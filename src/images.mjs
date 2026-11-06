import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { assertAgent } from './protocol.mjs';
import { delegationMessageId } from './delegation.mjs';

export const IMAGE_ROUTES = Object.freeze(['codex-imagegen', 'chatgpt-pro-web']);
const complexKeys = ['identityPreservation', 'sceneContinuity', 'multiReferenceRelations', 'complexPartialEdit'];
const hash = value => createHash('sha256').update(value).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;

/** The lead supplies observed requirements once; no classifier model call is made. */
export function selectImageRoute(request) {
  if (!request || typeof request !== 'object') throw new Error('Image request is required');
  if (request.route !== undefined && request.route !== 'auto') {
    if (!IMAGE_ROUTES.includes(request.route)) throw new Error('Unsupported image route');
    return { route: request.route, reason: 'Explicit user route' };
  }
  const constraints = request.constraints ?? {};
  for (const key of complexKeys) {
    if (constraints[key] !== undefined && typeof constraints[key] !== 'boolean') throw new Error('Invalid image constraint: ' + key);
  }
  const reasons = complexKeys.filter(key => constraints[key] === true);
  return reasons.length ? { route: 'chatgpt-pro-web', reason: reasons.join(', ') }
    : { route: 'codex-imagegen', reason: 'Independent image without compound preservation constraints' };
}

export function createImageTask(request, { webSkillPath } = {}) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(request?.taskId ?? '')
    || !Number.isSafeInteger(request.revision ?? 1) || (request.revision ?? 1) < 1) throw new Error('Invalid image task identity');
  if (!nonempty(request.prompt) || Buffer.byteLength(request.prompt) > 24000) throw new Error('Image prompt must contain 1–24000 UTF-8 bytes');
  if (!nonempty(request.projectRoot) || !isAbsolute(request.projectRoot)) throw new Error('Absolute image project root is required');
  const attachments = request.attachments ?? [];
  if (!Array.isArray(attachments) || !attachments.every(path => nonempty(path) && isAbsolute(path))) throw new Error('Image attachments must be absolute paths');
  const selection = selectImageRoute(request);
  if (selection.route === 'chatgpt-pro-web' && (!nonempty(webSkillPath) || !isAbsolute(webSkillPath))) throw new Error('ChatGPT Pro web route requires the installed skill path');
  const task = {
    contract: 'image-task.v1', taskId: request.taskId, revision: request.revision ?? 1,
    ...selection, app: selection.route === 'codex-imagegen' ? 'codex' : 'claude',
    prompt: request.prompt, promptSha256: hash(request.prompt), projectRoot: request.projectRoot,
    attachments, transparentBackground: request.transparentBackground === true,
    skillPath: selection.route === 'chatgpt-pro-web' ? webSkillPath : null,
    execution: selection.route === 'codex-imagegen'
      ? 'Use the native imagegen tool in the Codex session. Preserve its actual artifact or local output path.'
      : 'Read the installed ChatGPT image skill and use chatgpt.com in Pro mode. Reuse the project conversation registry. Confirm the visible Pro and image-generation selection before sending. Return the final image, conversation URL and chatgpt-log.jsonl path. If Pro is unavailable, report blocked; do not silently change routes.',
    completion: 'Save and inspect the requested result in projectRoot. Report actual artifacts and unverified items. Reply once when completed, failed or blocked; do not send ACKs. Never submit the same task simultaneously to both routes.',
  };
  if (Buffer.byteLength(JSON.stringify(task)) > 46 * 1024) throw new Error('Image task exceeds the message budget');
  return task;
}

/** A tool callback executes locally; remote tasks reuse the registered session transport. */
export async function dispatchImageTask(bridge, { from, request, webSkillPath, handlers = {} } = {}) {
  assertAgent(from);
  const task = createImageTask(request, { webSkillPath });
  const id = delegationMessageId({ profileId: 'agent-bridge-images', taskId: task.taskId, revision: task.revision });
  if (from !== task.app) {
    // With two apps, the selected image route may belong to an app that is not here.
    let settings = null;
    if (typeof bridge.root === 'string' && bridge.root) {
      try { settings = JSON.parse(await readFile(join(bridge.root, '.bridge', 'config.json'), 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (settings && !settings.agents?.[task.app]) {
      return { state: 'route-unavailable', task, reason: `${task.app} is not registered`, messageId: id,
        nextAction: task.route === 'codex-imagegen'
          ? 'Register Codex, or create the image with a tool available in the current chat.'
          : 'Register Claude (with Claude in Chrome) for the ChatGPT web route, or use an image tool available here.' };
    }
    const delivery = await bridge.send({ id, from, to: task.app, kind: 'task', body: JSON.stringify(task) });
    const status = delivery.status ?? null;
    return { task, delivery, status, duplicate: delivery.duplicate === true,
      state: status?.state ?? delivery.delivery?.state ?? 'delivery-unconfirmed' };
  }
  const handler = handlers[task.route];
  if (typeof handler !== 'function') return { state: 'local-execution-required', task, messageId: id };
  const directory = join(bridge.root, '.bridge', 'images');
  await mkdir(directory, { recursive: true });
  const claimPath = join(directory, id + '.request.json');
  const body = JSON.stringify(task);
  try { await writeFile(claimPath, body, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(claimPath, 'utf8') !== body) throw new Error('Image task identity already used for different content');
    try { return { state: 'already-completed', task, result: JSON.parse(await readFile(join(directory, id + '.result.json'), 'utf8')) }; }
    catch (readError) { if (readError.code !== 'ENOENT') throw readError; }
    return { state: 'execution-uncertain', task, nextAction: 'Inspect the original generation; do not regenerate automatically.' };
  }
  // A failed/aborted callback is intentionally not retried: the tool may have accepted it.
  const result = await handler(task);
  const verified = await recordImageResult(task, result);
  await writeFile(join(directory, id + '.result.json'), JSON.stringify(verified, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  return { state: 'completed', task, result: verified };
}

// This checks raster headers, not full decoding or visual quality. Native
// references remain the responsibility of the host that actually ran the tool.
function rasterHeader(bytes) {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    && bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR'
    && bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(20) > 0) {
    return { mime: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))
    && bytes.readUInt16LE(6) > 0 && bytes.readUInt16LE(8) > 0) {
    return { mime: 'image/gif', width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes[3] !== 0) {
    return { mime: 'image/jpeg' };
  }
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF'
    && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) >= 12
    && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16))) return { mime: 'image/webp' };
  throw new Error('Image artifact must have a supported PNG, JPEG, WebP or GIF raster header');
}

/** Hashes are calculated from real local files; native-only artifacts retain no invented hash. */
export async function recordImageResult(task, result) {
  if (!result || !Array.isArray(result.artifacts) || result.artifacts.length === 0) throw new Error('Actual image artifacts are required');
  const artifacts = [];
  for (const artifact of result.artifacts) {
    if (artifact.path) {
      if (!isAbsolute(artifact.path)) throw new Error('Image artifact path must be absolute');
      const bytes = await readFile(artifact.path);
      const header = rasterHeader(bytes);
      artifacts.push({ path: artifact.path, sha256: hash(bytes), bytes: bytes.length,
        mime: header.mime, width: header.width ?? artifact.width ?? null,
        height: header.height ?? artifact.height ?? null, validation: 'raster-header-only' });
    } else if (nonempty(artifact.nativeRef)) artifacts.push({ nativeRef: artifact.nativeRef, sha256: null,
      mime: artifact.mime ?? null, width: artifact.width ?? null, height: artifact.height ?? null,
      validation: 'host-reference-only' });
    else throw new Error('Image artifact requires a real path or native reference');
  }
  if (task.route === 'chatgpt-pro-web' && (result.modelObserved !== 'Pro' || result.imageModeObserved !== true
    || !/^https:\/\/chatgpt\.com\/(?:g\/[^/]+\/)?c\/[a-zA-Z0-9-]+/.test(result.conversationUrl ?? '')
    || !isAbsolute(result.logPath ?? ''))) throw new Error('Web result requires observed Pro, image mode, conversation and local log');
  if (task.route === 'chatgpt-pro-web') await readFile(result.logPath, 'utf8');
  return { contract: 'image-result.v1', taskId: task.taskId, revision: task.revision, route: task.route,
    promptSha256: task.promptSha256, artifacts, inspected: result.inspected ?? [], unverified: result.unverified ?? [],
    ...(task.route === 'chatgpt-pro-web' ? { conversationUrl: result.conversationUrl, logPath: result.logPath,
      modelObserved: result.modelObserved, imageModeObserved: true } : {}) };
}
