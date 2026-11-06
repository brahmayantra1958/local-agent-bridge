# AI 설치 안내 (에이전트용)

사용자가 이 폴더를 주고 "설치해 줘"라고 하면, 아래 순서를 그대로 따른다. 사람이 직접 하려면 `Setup.cmd`를 더블클릭하면 된다.

## 0. 확인

- **운영체제:** Windows x64여야 한다. 다른 운영체제면 지원하지 않는다고 알리고 멈춘다.
- **Node.js:** 사용자가 따로 설치할 필요가 없다. Setup이 고정 버전 Node.js를 이 폴더의 `runtime\`에만 받는다. 해시를 확인하고, 관리자 권한도 PATH 변경도 쓰지 않는다.
- **앱:** Codex, Claude, Antigravity 중 **두 개 이상**이 설치돼 있어야 한다. 하나뿐이면 이 도구로 이어 줄 상대가 없다.

## 1. Setup 실행

이 폴더의 절대 경로를 `<설치 폴더>`로 바꿔 PowerShell에서 실행한다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File '<설치 폴더>\installer\bootstrap.ps1' -NonInteractive
```

- **연결할 앱:** 설치된 앱을 모두 연결한다. 사용자가 일부만 원하면 `-Apps codex,claude`처럼 지정한다. 두 개 이상이어야 한다.
- **미리 보기:** `-DryRun`을 붙이면 아무것도 바꾸지 않고 계획만 보여 준다.
- **결과 기록:** 결과는 `<설치 폴더>\.bridge\install-receipt.json`에 남는다.

| 종료 코드 | 뜻 | 할 일 |
|---|---|---|
| 0 | 설치됨 | 2단계로 간다 |
| 3 | 앱이 두 개 미만 | 사용자에게 다른 앱을 하나 더 설치하라고 안내하고 멈춘다 |
| 1 | 충돌 또는 오류 | 같은 이름의 스킬이 이미 있으면 출력된 파일을 사용자에게 보여 준다. 바꿔도 된다고 하면 `-ReplaceSkills`로 다시 실행한다. 덮어쓴 파일은 `.bridge\skill-backups\`에 백업된다 |

## 2. 채팅 등록

스킬은 **새로 연 채팅부터** 보인다. 사용자에게 아래처럼 안내한다.

1. 함께 일할 채팅을 앱마다 하나씩 새로 연다.
2. 각 채팅에 "에이전트 브리지에 이 채팅을 등록해줘"라고 말한다.
3. 채팅이 스킬을 찾지 못하면 `install-receipt.json`의 `next[].command`를 그 채팅에서 실행하게 한다. Codex와 Antigravity는 출력에 나온 `next` 명령을 같은 채팅에서 한 번 더 실행해야 한다.

지금 이 채팅이 연결할 앱 중 하나라면, 이 채팅은 바로 직접 등록해도 된다.

## 3. 연결 확인

모든 앱을 등록한 뒤 아무 등록된 채팅에서 한 번 실행한다.

```powershell
& '<runtime 안 node.exe>' '<설치 폴더>\bin\agent-bridge.mjs' selftest --root '<설치 폴더>'
```

- **ping:** 앱 쌍마다 ping이 한 번 가고, 받는 채팅이 pong을 보낸다. 앱이 두 개면 1번, 세 개면 3번이다.
- **기록:** pong이 모두 돌아오면 `verify --record-versions true`를 실행해 연결 확인을 기록한다.

## 하지 말 것

- 앱의 권한 설정이나 승인 모드를 바꾸지 않는다. 등록은 지금 설정을 읽기만 한다.
- `.bridge\config.json`에 채팅 ID를 손으로 적지 않는다. 다른 PC의 ID를 복사하지 않는다.
- 사용자 동의 없이 기존 스킬을 `-ReplaceSkills`로 덮어쓰지 않는다.
- 연결 확인 외에는 ping을 반복하지 않는다. ping마다 받는 채팅의 모델 턴이 하나씩 든다.
