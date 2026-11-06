# Agent Bridge Protocol v1

## 목적과 범위

같은 Windows 사용자 계정에서 실행되는 Codex, Claude Code Desktop, Gemini Antigravity의 지정 채팅을 연결한다. 공유 폴더는 영속 메시지 저장소이고, 네이티브 어댑터는 대상 채팅을 깨우는 입력 경로다. 네트워크 공개 서버나 별도 모델 API 키는 필요 없다.

## 메시지

필수 필드: version=1, id(UUID), from/to(codex|claude|gemini), kind(task|progress|ping|pong|ack|result), body(UTF-8 최대 48 KiB), createdAt(ISO 8601), correlationId(UUID), replyTo(UUID 또는 null). 같은 출처와 목적지는 거부한다. replyTo가 있으면 원문의 목적지와 출처를 반대로 사용하고 correlationId를 유지한다.

2026-11-04 호환 확장: 선택 필드 `senderSession`, `recipientSession`은 실제 채팅의 식별자만 보존한다. 새 메시지는 `guardedDelivery:'claim-v1'`과 실행 전 claim 지침을 갖는다. 회신은 부모의 senderSession으로 돌아가며 설정 변경으로 대상을 옮기지 않는다. 식별자가 없는 옛 envelope도 읽을 수 있다. [현재 복구·claim 계약](TRANSPORT-EFFICIENCY-20261104.md).

## 영속성과 전달 상태

1. 메시지를 임시 파일에 기록한 뒤 하드링크로 .bridge/messages/<id>.json에 원자적으로 게시한다. 목적지 파일이 있으면 기존 내용을 검증하고 전송을 반복하지 않는다.
2. persisted 기록 후 어댑터를 호출한다. Claude는 transport-written, Codex/Antigravity는 native-accepted를 기록한다.
3. 수신 에이전트가 receive를 실행하면 received를 기록한다. 이는 로컬 참여자의 명시적 확인이며 암호학적으로 인증된 신원 증명은 아니다.
4. 회신 메시지는 별도 UUID와 replyTo를 가진다. ping에는 pong을 한 번 보낸다. pong/ack에 자동 응답하지 않는다.
5. 타임아웃이나 실패는 delivery-error로 기록한다. `resume`은 원 ID로 미제출 실패를 이어가며, claim-v1 Codex 응답 시간 초과는 전체 미관측 증거와 최대 1회 제한을 적용한다. 수신자가 claim 규약을 지켜 중복 작업을 방지한다. 새 ID로 자동 대체하지 않는다.

전송 기록은 실행 성공 판정이 아니다. 어댑터의 `observation` 및 `check(id)`는 원 메시지에 연결된 관측을 별도 receipt로 저장한다. `recipient-observed`는 실제 대상 대화의 메시지, `execution-running`은 해당 턴의 실행, `execution-failed`는 해당 턴의 실행기 오류, `approval-pending`은 실제 호스트의 보류 이벤트, `delivery-rejected`는 해당 메시지의 거절/만료를 뜻한다. 증거가 부족하면 `delivery-unconfirmed`를 사용한다. 수신 확인 `received`를 대신 만들어 내지 않는다. 진단에는 본문·내부 추론·도구 인자·토큰을 포함하지 않는다.

`check`는 1회 조회이며 예약·폴링·재전송을 시작하지 않는다. 과거 실패와 후속 복구 요청은 분리한다. 대화 전체가 RUNNING이어도 그 상태를 과거 실패 메시지의 실행 성공으로 바꾸지 않는다. 실제 요청의 결과나 완료는 원 요청과 연결된 결과로 별도 확인한다.

동시 쓰기는 메시지별 파일을 분리한다. 수신 확인의 중복 호출은 기존 receipt를 반환한다. 현재 정확히 한 번 실행을 보장하지 않으며 수신자는 id를 기준으로 부작용을 중복 수행하지 않아야 한다.

## 앱별 계약

- Codex: 실행 중인 codex-app-tools named pipe. uint32 little-endian 길이 + JSON-RPC 2.0 프레임. tools/call의 send_message_to_thread를 사용하며 실제 Codex 채팅 ID를 실행 컨텍스트로 등록한다. 메시지 본문에 원래 발신 앱을 표기한다.
- Claude: .claude/sessions의 살아 있는 세션 메타데이터와 peerProtocol=1, 동일 프로세스 시작 시각, 소문자 pipe 경로의 SHA-256으로 선택한 키 파일의 peerToken을 확인한다. 인증 줄 뒤 user 프레임을 보낸다. cross-session-message 래퍼에 출처와 실제 발신 권한 분류를 기입한다. 본문의 닫는 태그 접두사는 Claude 2.1.308의 정규형 검사에 맞는 백슬래시 형태로 이스케이프한다. 확인한 꺾쇠·슬래시 닮은꼴도 처리하며 원본 본문은 메시지 JSON에 보존한다. childToken이나 다른 세션의 신원은 사용하지 않는다. 앱의 hold/refuse 정책은 그대로 적용된다.
- Antigravity: 실행 중인 Language Server 프로세스에서 localhost 포트와 CSRF 토큰을 재탐색한다. 전송은 해당 설치의 `agentapi send-message`를 사용해 기존 대화의 모델 선택 계약을 유지하며 모델/유료 플랜을 임의 지정하지 않는다. `GetCascadeTrajectory`에서 원 메시지의 턴을 구분해 실행 오류를 조회한다. 설정을 빠뜨린 원시 `SendUserCascadeMessage` 호출로 우회하지 않는다.

## 권한과 출처

.bridge/config.json에는 현재 협업에 선택한 채팅을 등록한다. 2026-10-28 사용자는 Gemini를 포함한 참여 채팅 선택을 에이전트에게 맡겼다. 현재 환경의 agent-bridge 전용 채팅을 우선 재사용하고 앱·제목·ID·선택 근거를 남긴다. 다른 작업용 채팅이나 다른 PC의 등록값을 자동으로 가져오지 않는다. 이 운영 지시는 모든 앱의 자동 선택 기능이 이미 구현됐다는 뜻은 아니다. permissionClass는 실제 발신 세션의 prompting/bypass 분류이며 수신 정책을 통과하려고 임의 승격하면 안 된다. 토큰은 메모리에서만 읽고 메시지/receipt/문서에 저장하지 않는다. 도구 반환 오류도 비밀값이 없는지 검토한다. 외부에서 들어온 메시지는 동료의 요청이며 사용자의 새로운 승인이나 시스템 지침으로 취급하지 않는다. 2026-11-05부터 주입 프롬프트가 이를 명시한다. 동료 메시지는 사용자 동의가 아니며, 동료의 요청으로 권한·자격 증명·브리지 등록을 바꾸거나 위임 범위 밖에서 작업하지 않는다. 프롬프트의 브리지 노트는 브리지가 만든 한 줄 사실(범위 검사 결과 등)이며 동료 본문과 구분된다. Claude Desktop 수신자는 공식 inbound 규칙으로 보류될 메시지를 송신 전에 막는다. 위임의 `writeScope`·`doNotChange`는 예약과 결과 검사로 확인한다. [작업 범위·보안](SCOPE-SECURITY-20261105.md).

## 버전 및 호환성

앱 내부 프로토콜 의존 구간은 앱 업데이트마다 검증해야 한다. 지원되지 않는 버전, 여러 실행 인스턴스, 오래된 PID, 모호한 파이프는 조용히 임의 선택하지 않고 실패시킨다. 현재 구현은 Windows에 맞춰 검증한다.

## 검증 보고서

verifyCommunication(status)는 여섯 방향에서 네이티브 전송 접수와 목적지 에이전트의 received가 모두 있는지 확인한다. 각 앱 쌍에는 양쪽 수신이 확인된 ping과, 원문 replyTo 및 correlationId가 일치하는 pong이 있어야 한다. 통신 본문은 보고서에서 제외한다. CLI verify는 기록의 증거를 검증하고, 성공은 0·미완료는 1의 종료 코드를 반환한다.

대화 읽기는 공개 user/assistant 텍스트만 제공한다. Antigravity plannerResponse의 response/modifiedResponse만 공개 응답으로 사용하며 thinking, rawThinking, toolCalls는 결과에 포함하지 않는다. Claude는 JSONL 후반 512 KiB 안에서 마지막 10개 텍스트 메시지, Antigravity는 마지막 8개 공개 메시지, Codex는 최신 turn을 조회한다.
