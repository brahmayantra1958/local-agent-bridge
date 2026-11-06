import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { antigravityRpc, formatAntigravitySteps, readAntigravity } from '../src/adapters/antigravity.mjs';

// A host can assign fetch-blocklisted low ports for listen(0). Keep fixtures in
// the high dynamic range; bounded retries accommodate parallel test processes.
let nextMockPort = 49152 + (process.pid % 12000);
async function createMockServer(t, handler) {
  for (let attempt = 0; attempt < 64; attempt++) {
    const server = http.createServer(handler);
    const candidate = nextMockPort++;
    if (nextMockPort > 65535) nextMockPort = 49152;
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve();
        });
      });
    } catch (error) {
      if (['EADDRINUSE', 'EACCES'].includes(error.code)) continue;
      throw error;
    }
    const { port } = server.address();
    t.after(() => new Promise((res) => server.close(res)));
    return { port, address: `http://127.0.0.1:${port}` };
  }
  throw new Error('No free mock HTTP port after 64 high-range candidates');
}

test('antigravityRpc rejects invalid method names and remote hosts', async () => {
  await assert.rejects(() => antigravityRpc('../invalid', {}), /Invalid RPC method/);
  await assert.rejects(() => antigravityRpc('method/nested', {}), /Invalid RPC method/);
  await assert.rejects(() => antigravityRpc('123method', {}), /Invalid RPC method/);
  await assert.rejects(() => antigravityRpc('method with space', {}), /Invalid RPC method/);

  await assert.rejects(
    () => antigravityRpc('ValidMethod', {}, { connection: { address: 'http://example.com:8080', csrfToken: 'tok' } }),
    /Local Antigravity endpoint required/
  );
  await assert.rejects(
    () => antigravityRpc('ValidMethod', {}, { connection: { address: 'http://192.168.1.5:8080', csrfToken: 'tok' } }),
    /Local Antigravity endpoint required/
  );
});

test('antigravityRpc sends expected headers and path to local server', async (t) => {
  let receivedPath = '';
  let receivedHeaders = {};
  let receivedBody = null;

  const mock = await createMockServer(t, async (req, res) => {
    receivedPath = req.url;
    receivedHeaders = req.headers;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    receivedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, echo: receivedBody }));
  });

  const res = await antigravityRpc(
    'GetCascadeTrajectory',
    { cascadeId: 'test-cascade-123' },
    { connection: { address: mock.address, csrfToken: 'csrf-secret-abc' } }
  );

  assert.equal(receivedPath, '/exa.language_server_pb.LanguageServerService/GetCascadeTrajectory');
  assert.equal(receivedHeaders['content-type'], 'application/json');
  assert.equal(receivedHeaders['x-codeium-csrf-token'], 'csrf-secret-abc');
  assert.deepEqual(receivedBody, { cascadeId: 'test-cascade-123' });
  assert.deepEqual(res, { ok: true, echo: { cascadeId: 'test-cascade-123' } });
});

test('antigravityRpc surfaces HTTP codes without leaking response bodies', async (t) => {
  const mock = await createMockServer(t, (req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal server error detail that might be long'.repeat(10));
  });

  await assert.rejects(
    () => antigravityRpc('FailMethod', {}, { connection: { address: mock.address, csrfToken: 'tok' } }),
    error => error.message === 'Antigravity RPC FailMethod HTTP 500'
  );
});

test('formatAntigravitySteps allowlist extracts only public text and drops internal thinking/tools', () => {
  const sampleSteps = [
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      userInput: {
        items: [{ text: '사용자 요청 메시지' }],
        userResponse: '사용자 요청 메시지'
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
      plannerResponse: {
        thinking: '비밀 추론 과정: 시스템 프롬프트 및 내부 판단...',
        rawThinking: 'raw CoT...',
        toolCalls: [{ toolName: 'run_command', args: { command: 'secret.sh' } }],
        response: '사용자에게 공개되는 최종 답변입니다.'
      }
    },
    {
      type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
      runCommand: { commandLine: 'dir' }
    }
  ];

  const result = formatAntigravitySteps(sampleSteps);
  assert.equal(result.length, 2);
  assert.deepEqual(result[0], { type: 'user', text: '사용자 요청 메시지' });
  assert.deepEqual(result[1], { type: 'assistant', text: '사용자에게 공개되는 최종 답변입니다.' });

  // 누출 방지 단언: thinking, rawThinking, toolCalls가 결과에 일절 없어야 함
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('비밀 추론 과정'), false);
  assert.equal(serialized.includes('raw CoT'), false);
  assert.equal(serialized.includes('secret.sh'), false);
});

test('readAntigravity formats trajectory steps and surfaces RPC errors via mock options', async (t) => {
  const mockSuccess = await createMockServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      status: 'CASCADE_RUN_STATUS_RUNNING',
      numTotalSteps: 3,
      trajectory: {
        steps: [
          {
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            userInput: { userResponse: '질문' }
          },
          {
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            plannerResponse: { response: '답변', thinking: '숨겨진 CoT' }
          }
        ]
      }
    }));
  });

  const res = await readAntigravity(
    { conversationId: 'conv-mock-1' },
    {},
    { connection: { address: mockSuccess.address, csrfToken: 'tok-mock' } }
  );
  assert.equal(res.conversationId, 'conv-mock-1');
  assert.equal(res.status, 'CASCADE_RUN_STATUS_RUNNING');
  assert.equal(res.numTotalSteps, 3);
  assert.deepEqual(res.messages, [
    { type: 'user', text: '질문' },
    { type: 'assistant', text: '답변' }
  ]);
  assert.equal(JSON.stringify(res.messages).includes('숨겨진 CoT'), false);

  const mockFail = await createMockServer(t, (req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'not_found', message: 'trajectory not found' }));
  });

  await assert.rejects(
    () => readAntigravity(
      { conversationId: '00000000-0000-0000-0000-000000000000' },
      {},
      { connection: { address: mockFail.address, csrfToken: 'tok-fail' } }
    ),
    /Antigravity RPC GetCascadeTrajectory HTTP 500/
  );
});
