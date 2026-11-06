# 앱 버전 감시 (2026-11-05)

세 전송 경로는 모두 앱 내부 인터페이스에 기대므로, 앱이 업데이트되면 그 앱으로 들어가는 경로를 다시 검증해야 한다. 기존 `verify`는 과거 기록 전체로 판정하기 때문에 앱이 바뀐 뒤에도 통과로 남았다. 2026-11-05에 확인했을 때 세 앱 모두 마지막 문서화 검증(2026-10-28) 이후 업데이트돼 있었다. 이 기능은 업데이트를 놓치지 않게 하고 재검증 결과를 버전별로 기록한다. 동작을 보증하지는 않는다.

## 계약

- **경고만 한다.** `send`·`reply`·`resume`·`flush`는 매 전달 전에 수신 앱의 현재 버전을 읽고 검증된 기준과 비교한다. 결과 JSON의 `warnings[]`에 `app-version-unverified`가 붙는다. 전송을 막지 않고 `status`·`requiresAttention`·종료 코드도 바꾸지 않는다. `--version-check false`(라이브러리는 `versionCheck:false`)를 주면 그 송신에서 비교를 생략한다.
- **증거를 남긴다.** 각 `delivery-attempt` 영수증에 `recipientApp {version, state, source, reason?}`를 기록한다. 본문·자격 증명·명령줄은 기록하지 않는다.
- **읽는 곳:** 앱을 띄우거나 메시지를 보내지 않는다. Codex·Antigravity는 PowerShell을 한 번 실행하고, 같은 프로세스 안에서는 60초 동안 결과를 재사용한다.

| 앱 | 출처(`source`) | 읽는 값 |
|---|---|---|
| Codex | `appx-package` | MSIX 패키지 `OpenAI.Codex`의 Version (`Get-AppxPackage`) |
| Claude | `claude-runtime-discovery` | 등록 채팅의 살아 있는 Claude Code 런타임이 `~/.claude/sessions/<pid>.json`에 게시한 `version`. 런타임 해석은 전송과 같은 식별 규칙을 따른다 |
| Antigravity | `antigravity-executable` | `%LOCALAPPDATA%\Programs\antigravity\Antigravity.exe`의 파일 버전(Gemini 깨우기와 같은 경로) |

- **상태:**
  - `verified`: 기준과 같다.
  - `changed`: 기준과 다르다.
  - `unverified`: 그 앱의 기준이 없다.
  - `unknown`: 읽지 못했다. 이유는 `reason`에 남는다.
- **기준:** state root의 `.bridge/verified-app-versions.json`(Git 제외)을 쓴다. 이 파일이 없으면 코드와 함께 있는 [verification.json](verification.json)의 `environment`(2026-10-28 6방향 검증)를 쓴다. 기록이 손상됐으면 `invalid`로 보고하고 추측하지 않는다.
- **버전별 증거:** 앱 X를 검증됨으로 기록하려면 다른 두 앱 각각에서 X로 보낸 메시지가 필요하다. 그 메시지는 전송 접수와 X의 `received`를 갖고 있어야 하고, 접수된 시도에 X의 현재 버전이 기록돼 있어야 한다. 업데이트 전에 모은 증거는 새 버전의 증거로 쓰지 않는다. 기록은 앱별로 하며, 재검증하지 않은 앱은 기존 항목을 유지한다.
- **기존 `verify`:** 옵션 없이 실행하면 예전과 같이 과거 기록 전체를 판정한다.

## 명령

    node bin/agent-bridge.mjs versions
    node bin/agent-bridge.mjs verify --versions true
    node bin/agent-bridge.mjs verify --record-versions true

- `versions`는 읽기 전용 비교다. 검증되지 않은 앱이 있으면 `requiresAttention:true`와 종료 코드 2를 낸다.
- `verify --versions true`는 현재 버전 기준의 경로별 증거를 보여 주기만 하고 기록하지 않는다.
- `verify --record-versions true`는 증거가 갖춰진 앱만 기준에 기록한다. 기록 뒤에도 전부 검증되지 않았으면 종료 코드 1을 낸다.

## 업데이트 뒤 재검증

1. `versions`로 `pending` 앱을 확인한다.
2. `pending` 앱마다 다른 두 앱에서 그 앱으로 ping을 한 번씩 보낸다. 그 앱이 pong을 보내면 `reply`가 원 ping의 `received`도 기록하므로, 그 앱으로 들어가는 두 경로가 채워진다. 세 앱이 모두 바뀌었으면 세 쌍마다 ping을 하나씩 보내고, 원 발신자가 받은 pong에 `receive`를 실행하면 여섯 경로가 모두 채워진다.
3. `verify --record-versions true`를 실행한다.

ping과 pong은 받는 채팅마다 모델 턴을 하나씩 쓴다. 앱이 바뀌었을 때만 실행한다.

## 검증 결과

- **단위 테스트:** [test/app-versions.test.mjs](../test/app-versions.test.mjs)의 11개 테스트가 다음을 확인한다.
  - 전송을 막지 않는 경고와 짧은 재사용
  - 읽기 실패·형식 오류일 때의 처리와 비교 생략 옵션
  - 대기된 전송과 `flush`의 경고 전달
  - 버전별 증거, 앱별 기록, 업데이트 뒤 기존 증거 무효화
  - 기준 우선순위와 손상된 기록 보고
  - Windows 리더의 JSON 파싱과 설치 경로 인용, Claude 런타임 식별 규칙, 접수된 시도의 버전 선택
- **전체 테스트:** `node --test` 247/247 통과(2026-11-05, Node v24.18.1, 기존 236 + 신규 11).
- **실제 앱 읽기:** 2026-11-05에 읽기 전용으로 실행했고, 결과는 [evidence](APP-VERSION-GUARD-20261105.evidence.json)에 있다.
  - `versions`(약 0.5초, 종료 코드 2): 세 앱이 모두 `changed`였다.

    | 앱 | 현재 | 기준 |
    |---|---|---|
    | Codex | 26.1029.7803.0 | 26.1013.4894.0 |
    | Claude Code | 2.1.317 | 2.1.308 |
    | Antigravity | 2.29.0 | 2.27.0 |

  - `verify --versions true`: 기존 판정은 `passed:true`였지만, 현재 버전 기준으로는 여섯 경로 모두 증거가 없었다.
  - 기준 파일은 생성되지 않았다.
- **미검증:**
  - 실제 ping 행렬로 기준을 기록하는 경로. 사용 중인 세 채팅에 메시지를 보내야 하므로 실행하지 않았다.
  - Codex 앱이 실행 중일 때 설치 버전과 실행 버전이 다른 경우. 확인 시점에 Codex 앱 도구 파이프가 없었다.

## 한계

- Codex와 Antigravity는 설치 버전을 읽는다. 업데이트가 설치됐지만 앱을 다시 시작하지 않았으면 실행 중인 버전과 다를 수 있다.
- Claude 버전은 등록 채팅의 런타임이 살아 있을 때만 읽힌다. 닫힌 채팅은 `unknown`이다(`claude-runtime-unresolved`).
- 버전이 같아도 서버 측 변경이나 설정 변경으로 경로가 깨질 수 있다. 이 감시는 업데이트를 알릴 뿐 동작을 증명하지 않는다.
- 차단 모드는 없다. 실사용 재검증을 몇 번 거친 뒤 필요하면 별도로 결정한다.

## 변경 파일과 되돌리기

- **새 파일:**
  - [src/app-versions.mjs](../src/app-versions.mjs)
  - [test/app-versions.test.mjs](../test/app-versions.test.mjs)
  - 이 문서
  - [evidence](APP-VERSION-GUARD-20261105.evidence.json)
- **수정한 파일:**
  - [src/index.mjs](../src/index.mjs): 전달 전 비교, 영수증 기록, `appVersions`·`verifyAppVersions`
  - [src/verification.mjs](../src/verification.mjs): `delivered` 내보내기
  - [bin/agent-bridge.mjs](../bin/agent-bridge.mjs): `versions`, `verify --versions/--record-versions`, `--version-check`
  - README와 운영·검증 문서
- **되돌리기:** 수정 전 원본은 `.bridge/backups/version-guard-20261105/`에 있다.
