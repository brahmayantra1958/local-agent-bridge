# 설치기·채팅 등록·앱 조합 대응 (2026-11-05)

일반 사용자가 Node.js를 따로 깔지 않고, 가진 앱이 두 개든 세 개든 같은 순서로 설치하고 연결하게 만들었다. 핵심 구조는 그대로다. 기존 채팅에 한 번 보내고 결과를 한 번 받는다. 상주 프로세스·폴링·추가 확인 턴은 없다.

## 사용자가 하는 일

1. `Setup.cmd`를 더블클릭한다. 또는 에이전트에게 [AI_INSTALL.md](../AI_INSTALL.md)를 주고 "설치해 줘"라고 한다.
2. 설치된 앱 중에서 연결할 앱을 고른다. 두 개 이상이어야 하고, 그냥 Enter를 누르면 감지된 앱을 모두 고른다.
3. 앱마다 새 채팅을 열고 "에이전트 브리지에 이 채팅을 등록해줘"라고 말한다.
4. 모두 등록했으면 아무 채팅에서 "브리지 연결 시험해줘"라고 말한다.

## 구성

| 파일 | 하는 일 |
|---|---|
| `Setup.cmd` | 더블클릭 진입점. UTF-8 콘솔로 바꾼 뒤 bootstrap을 실행하고 마지막에 멈춘다. ASCII만 쓴다. |
| [installer/bootstrap.ps1](../installer/bootstrap.ps1) | x64 Windows를 확인한다. 고정 버전 Node(24.21.0)를 nodejs.org에서 받아 SHA-256을 대조하고, `runtime\`에 `node.exe`와 LICENSE만 푼다. 관리자 권한과 PATH 변경은 쓰지 않는다. 한 번 받은 압축 파일은 다시 대조해 재사용한다. ASCII만 쓴다. |
| [installer/node-distribution.json](../installer/node-distribution.json) | 버전·파일·SHA-256. 값은 nodejs.org `SHASUMS256.txt`와 대조했고, `premiere-uxp-mcp` 설치기와 같은 버전이다. |
| [installer/setup.mjs](../installer/setup.mjs) | 앱 감지 → 선택 → 스킬 렌더·설치 → 등록 파일 골격 → 설치 영수증(`.bridge/install-receipt.json`)과 다음 단계 안내. |
| [installer/skills.mjs](../installer/skills.mjs) | 스킬 템플릿 렌더(연결한 앱별 블록, 경로·역할표)와 관리 목록 기반 설치. |
| [installer/skill-template/agent-bridge/](../installer/skill-template/agent-bridge/SKILL.md) | 공개용 스킬. 개인 도구(ChatGPT Pro 상담, 이미지 스킬, orchestrator)에 의존하지 않는다. |
| [AI_INSTALL.md](../AI_INSTALL.md) | 에이전트가 그대로 따르는 설치 순서와 하지 말 것. |
| [src/join.mjs](../src/join.mjs) | `join`(채팅 자기 등록)과 `selftest`(연결 시험). |

### setup.mjs의 판정

- **앱 감지:** 메타데이터만 읽는다. Codex는 MSIX 패키지, Claude는 Desktop 설치 폴더(`AnthropicClaude\app-*`), Antigravity는 실행 파일이다. 앱을 띄우거나 설정을 바꾸지 않는다.
- **종료 코드:**
  - 0: 설치 완료 또는 `--dry-run` 계획
  - 3: 고른 앱이 두 개 미만이라 아무것도 설치하지 않음
  - 1: 충돌 또는 오류
- **스킬 설치:** 앱마다 `skills\agent-bridge\`에 설치하고, 관리 목록(`.agent-bridge-skill.json`)을 남긴다.
  - 설치기가 쓰지 않은 파일이나 그 뒤 고친 파일이 있으면 충돌로 보고 어느 앱도 바꾸지 않는다.
  - `-ReplaceSkills`일 때만 덮어쓴다. 기존 파일은 `.bridge\skill-backups\`에 백업한다.
  - 설치 뒤 해시를 대조하고, 실패하면 원래대로 되돌린다.
- **등록 파일:** `config.json`이 없을 때만 `{version:1, agents:{}}`를 만든다. 있으면 건드리지 않는다.

## 채팅 등록(`join`)

| 앱 | 채팅을 찾는 방법 | 권한 분류 |
|---|---|---|
| Claude | 채팅이 실행한 명령에 들어 있는 `CLAUDE_CODE_SESSION_ID`·`CLAUDE_CODE_HOST_SESSION_ID`로 바로 찾는다(한 번에 끝난다) | 대화 기록의 마지막 `permissionMode`. `bypassPermissions`면 bypass, 그 밖에는 prompting |
| Codex | 1단계에서 확인 코드를 출력한다. 같은 채팅에서 2단계 명령을 실행하면, 최근 30분 rollout 중 그 코드가 든 채팅을 찾는다 | 마지막 `turn_context.approval_policy`. `never`면 bypass |
| Antigravity | 같은 2단계 방식. 최근 30분 안에 활동한 대화의 trajectory에서 코드를 찾는다. 활동 시각은 `<id>.db`·`.db-wal`·`.db-shm` 중 가장 늦은 시각이다(쓰는 중인 대화는 WAL 파일만 바뀐다). `projectId`도 함께 읽는다 | trajectory의 마지막 `autoExecutionPolicy`(없으면 `config.json`). EAGER면 bypass |

- **확인 코드:** 성공하면 바로 지운다. 2단계가 실패해도 15분 안에는 같은 코드로 다시 할 수 있다. 만료된 코드는 다음 코드를 발급할 때 지운다.
- **같은 채팅:** 다시 실행하면 갱신만 한다.
- **다른 채팅:** `already-registered`(exit 2)를 내고 아무것도 바꾸지 않는다. `--replace true`일 때만 바꾼다.
- **설정 쓰기:** 설정 파일은 백업한 뒤 원자적으로 바꾼다. 같은 등록 폴더에 대한 동시 실행은 OS 뮤텍스로 한 번에 하나씩 처리한다.
- **Codex 호출 채팅:** Codex를 등록하면 `codexCallerThreadId`가 비어 있을 때 그 채팅으로 채운다.
- **분업표 재생성:** 등록이 끝날 때마다 등록 폴더의 분업표(`.bridge/routing-profile.json`)를 등록된 앱에 맞춘다.
  - 두 앱이면 만든다. 세 앱이 되면 지운다(기본표 사용).
  - 사람이 손으로 쓴 분업표(`generatedBy` 표시 없음)는 바꾸지 않는다.

## 앱 조합

| 등록된 앱 | 처리 |
|---|---|
| 1개 | Setup이 설치하지 않는다(exit 3). `selftest`는 `needs-two-apps`를 낸다. |
| 2개 | 없는 앱의 역할을 가장 가까운 앱으로 옮긴다. Codex 역할은 Claude, 그다음 Gemini가 받는다. Claude 역할은 Codex, 그다음 Gemini가 받는다. Gemini 역할은 Claude, 그다음 Codex가 받는다. 옮긴 역할의 고정 모델 지정은 지운다. |
| 3개 | 기본 분업표를 쓴다. |

**두 앱일 때 깨지던 곳 수정**
- **연결 검증과 버전 기록:** `verify`와 버전 기록(`verify --record-versions`)이 등록된 앱끼리만 센다.
- **위임:** `delegate`가 등록되지 않은 앱으로 가는 경로를 보내기 전에 분명한 오류로 막는다.
- **이미지:** 이미지 작업은 경로의 앱이 없으면 `route-unavailable`을 낸다.

## 연결 시험(`selftest`)

- **보내는 것:** 등록된 앱 쌍마다 ping을 하나 보낸다. 두 앱이면 1번, 세 앱이면 3번이다.
- **재실행:** ID가 날짜로 정해지므로, 같은 날 다시 실행해도 새로 보내지 않는다.
- **pong 처리:** pong 프롬프트가 원 발신자에게 로컬 `receive`를 요청하도록 바꿨다. 받은 사실을 기록할 뿐 상대에게 아무것도 보내지 않는다. 그래서 pong만으로 양방향 경로와 왕복이 기록된다.
- **비용:** 쌍마다 받는 채팅의 모델 턴이 두 번 든다.

## 검증 결과

- **전체 테스트:** `node --test` 278/278 통과(2026-11-05). 신규 15개를 포함한다.
  - 템플릿 렌더
  - 스킬 설치의 관리 목록·업그레이드·충돌·백업
  - Setup 비대화 설치·2앱 미만·dry-run·충돌 거부·덮어쓰기
  - Claude·Codex·Antigravity `join`, Antigravity WAL 활동 감지, 만료 확인 코드 정리
  - 두 앱 분업표, 사용자 분업표 보존
  - 두 앱 검증·버전 증거
  - 미등록 앱 위임·이미지 거부
  - `selftest`, pong 프롬프트
- **실제 설치(임시 사본·임시 홈):**
  - **첫 실행:** `bootstrap.ps1`이 Node 24.21.0을 실제로 받아 해시를 대조했다. 세 앱용 스킬까지 7.1초에 설치했다(exit 0).
  - **내려받은 Node:** `node.exe`는 v24.21.0이고 OpenJS Foundation 서명이 유효하다. `runtime\`에는 압축 파일(35.9 MB), `node.exe`(89.2 MB), LICENSE만 있다.
  - **두 번째 실행:** 압축 파일을 재사용해 0.9초에 끝났다. 임시 홈에서는 Codex만 감지돼 exit 3으로 멈췄다.
  - **실제 홈 dry-run:** 세 앱을 모두 감지했고 실제 스킬 폴더 3곳에 각 2개 파일을 계획했다. 아무것도 쓰지 않았다.
- **실제 데이터로 채팅 찾기:** 메시지를 보내지 않았고, 등록은 임시 폴더에만 썼다.
  - Claude: 이 대화에서 `join`을 실행해 세션·Desktop 채팅·제목과 `bypassPermissions` → bypass를 찾았다.
  - Antigravity: 오늘 위임 메시지 ID로 등록된 대화와 같은 projectId를 찾았다. EAGER → bypass다. 단, 이 확인은 기준 시각을 대화 `.db`의 수정 시각으로 맞춰 실행해서 최근 대화 필터를 시험하지 못했다. 그 필터의 결함은 아래 Gemini 채팅 시험에서 드러났다.
  - Codex: 최신 rollout의 채팅을 찾았다. 승인 정책 `never` → bypass다.
  - Antigravity·Codex의 결과는 기존 등록값의 분류와 같다.
- **Gemini 채팅 안에서 2단계 `join`(실사용):** Antigravity 채팅이 임시 설치본의 Node·CLI로 직접 실행했다. 등록은 임시 폴더에만 썼다.
  - **1차(메시지 `56df80ec…`):** 1단계는 코드를 냈다. 2단계는 "No recently active Antigravity conversation was found"로 실패했다(회신 `87db609a…`). 원인은 아래 결함 1이다.
  - **재시험(메시지 `89288d60…`, 회신 `7ad911c6…`):** 1단계 23:46:15, 2단계 23:46:28(KST)에 `registered`가 나왔다. 임시 등록의 `conversationId`(`1852506e…`)와 `projectId`(`d35eca2b…`)는 실제 등록값과 같고, 권한은 EAGER → bypass다. 등록된 앱이 하나라 분업표 상태는 `waiting-for-second-app`이다. 성공한 회차의 코드 파일은 바로 지워졌다.
  - **비용:** 회차마다 Gemini 턴 1회와 회신 1건이 들었다.
- **영향 없음:** 이 PC의 실제 스킬 폴더 3곳, 등록 파일(10-28 이후 수정 없음), 프로젝트 폴더는 Gemini 시험 뒤에도 그대로다.
- **미검증:**
  - Codex 채팅 **안에서** 2단계 `join`을 실제로 실행하는 것. 찾는 방식(rollout 속 코드 검색)은 실제 데이터로 확인했다.
  - 실제 스킬 폴더에 설치한 뒤 각 앱이 스킬을 인식하는 시점
  - 두 앱 조합의 실제 위임

## 실채팅 시험에서 고친 결함

1. **쓰는 중인 Antigravity 대화를 못 찾음.** Antigravity 대화 저장소는 SQLite WAL 모드다. 쓰는 중인 대화는 `<id>.db-wal`만 바뀌고 `<id>.db`는 마지막 체크포인트 시각에 머문다. 1차 시험 때 `.db`는 약 3시간 전 시각이었고 `.db-wal`만 방금 바뀌어 있었다. `.db` 시각만 보던 최근 대화 필터가 바로 그 채팅을 뺐다. 이제 대화별 활동 시각을 세 파일 중 가장 늦은 시각으로 잡는다.
2. **실패한 등록의 확인 코드가 남음.** 성공한 코드는 바로 지워졌지만, 2단계가 실패한 코드는 만료 뒤에도 `.bridge/joins/`에 남았다. 이제 코드를 새로 발급할 때 만료된 코드 파일을 지운다. 시각을 읽을 수 없는 파일(다른 채팅이 막 쓰는 중인 코드)은 파일 수정 시각으로 판단해서, 방금 만든 코드를 지우지 않는다.

두 결함 모두 회귀 테스트를 더했다. 각 테스트는 수정 전 코드에서 실패하고 수정 후 통과한다.

## 한계

- **환경:** Windows x64 전용이다. 첫 실행에는 인터넷(nodejs.org)이 필요하다. `runtime\`에 Node 압축 파일을 미리 넣은 묶음이면 오프라인으로도 설치할 수 있다.
- **같은 이름의 스킬:** 이 PC처럼 기존 개인 스킬(`USER-agent-connect-sessions-agent-bridge`)이 있는 곳에서 Setup을 실행하면 이름이 다른 `agent-bridge` 스킬이 하나 더 생긴다. 이 PC는 지금 방식(orchestrator 동기화)을 그대로 쓰면 된다.
- **확인 코드 유효 시간:** Codex·Antigravity 등록은 확인 코드가 15분, 기록 검색 범위가 최근 30분이다. 그보다 늦으면 1단계부터 다시 한다.
- **공개 배포 전 남은 일:** 이름과 배포 묶음(개인 기록·ID·경로 제외)은 아직 정하지 않았다. 라이선스는 2026-11-06 사용자 결정으로 0BSD를 적용했다([LICENSE](../LICENSE), `package.json`, README 라이선스 절).

## 되돌리기

수정 전 원본은 `.bridge/backups/installer-20261105/`에 있다. 새 파일은 위 표의 파일들과 테스트 2개(`test/join.test.mjs`, `test/installer.test.mjs`)다.
