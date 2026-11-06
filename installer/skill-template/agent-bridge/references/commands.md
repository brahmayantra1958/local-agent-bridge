# 명령

모든 명령은 [SKILL.md](../SKILL.md)의 세 변수(`$bridgeNode`, `$bridgeCli`, `$bridgeRoot`)를 쓴다. 옵션은 `--이름 값` 쌍이다. 본문과 JSON은 UTF-8 파일로 만들고, 경로를 인수로 넘긴다. 본문은 48 KiB까지 보낼 수 있다.

## 등록과 연결 확인

```powershell
& $bridgeNode $bridgeCli join --root $bridgeRoot --agent <codex|claude|gemini>
& $bridgeNode $bridgeCli selftest --root $bridgeRoot
& $bridgeNode $bridgeCli verify --root $bridgeRoot --record-versions true
& $bridgeNode $bridgeCli versions --root $bridgeRoot
```

- **`join`:** 실행한 채팅을 등록한다.
  - Codex와 Antigravity는 확인 코드를 먼저 출력한다. 같은 채팅에서 `next` 명령을 실행해야 등록이 끝난다.
  - 권한 분류는 그 채팅의 실제 설정에서 읽는다.
  - 등록된 앱이 두 개뿐이면, 없는 앱의 역할을 남은 앱에 나눈 분업표가 자동으로 만들어진다.
- **`selftest`:** 등록된 앱 쌍마다 ping을 한 번 보낸다. 같은 날 다시 실행하면 아무것도 새로 보내지 않는다.
- **`verify --record-versions true`:** 지금 앱 버전으로 주고받은 기록을 연결 확인 기준으로 남긴다.
- **`versions`:** 앱 버전이 기준과 같은지 읽기만 한다.

## 일 맡기기

```powershell
& $bridgeNode $bridgeCli delegate --root $bridgeRoot --from <내 앱> --task-type writing --task-file 'C:\작업\task.json'
& $bridgeNode $bridgeCli send --root $bridgeRoot --from <내 앱> --to <상대 앱> --kind task --body-file 'C:\작업\request.txt'
```

`task.json` 예시:

```json
{
  "taskId": "chapter-review",
  "revision": 1,
  "objective": "3장 초안의 흐름을 검토하고 고친 안을 review.md에 쓴다.",
  "readOrder": [{"path": "C:/작업/chapter3.md"}],
  "writeScope": ["C:/작업/review.md"],
  "doNotChange": ["C:/작업/chapter3.md"],
  "doneWhen": ["review.md에 문제점과 고친 문장이 있다."]
}
```

- **`taskId`와 `revision`:** 같은 `taskId`·`revision`은 같은 메시지다. 일부러 새로 시키려면 `revision`을 올린다.
- **역할 선택:** `--task-type`이 일을 맡을 앱을 고른다(역할표는 SKILL.md에 있다).
- **쓰기 예약:** `writeScope`는 쓰기 예약된다. 진행 중인 다른 위임과 겹치면 보내지 않고 `write-scope-reserved`로 알려 준다. 예약은 `reservations`로 보고, 버려진 작업은 `release --id <위임 ID>`로 푼다.

## 회신과 마감

받은 메시지에 같은 명령이 이미 들어 있다.

```powershell
& $bridgeNode $bridgeCli claim --root $bridgeRoot --agent <내 앱> --id '<받은 메시지 ID>'
& $bridgeNode $bridgeCli reply --root $bridgeRoot --agent <내 앱> --id '<받은 메시지 ID>' --kind result --body-file 'C:\작업\result.txt'
& $bridgeNode $bridgeCli receive --root $bridgeRoot --agent <내 앱> --id '<받은 결과 ID>'
```

- **`reply`:** 결과에는 완료·실패·막힘, 짧은 요약, 산출물 경로, 확인한 내용을 적는다. 같은 본문으로 다시 실행해도 같은 결과로 처리된다.
- **`receive`:** 받은 결과를 반영한 뒤 기록만 남긴다. 상대에게는 아무것도 가지 않는다.

## 대기와 복구

```powershell
& $bridgeNode $bridgeCli inbox --root $bridgeRoot --agent <내 앱> --include-bodies false
& $bridgeNode $bridgeCli flush --root $bridgeRoot --to <앱>
& $bridgeNode $bridgeCli check --root $bridgeRoot --id '<메시지 ID>'
& $bridgeNode $bridgeCli resume --root $bridgeRoot --id '<메시지 ID>'
& $bridgeNode $bridgeCli scope-check --root $bridgeRoot --id '<위임 ID>'
```

| 상태 | 뜻 | 할 일 |
|---|---|---|
| `queued` | 받는 앱이 꺼져 있어 보관 중 | 앱을 켠 뒤 `flush` 한 번 |
| `pending-receipt` | 응답 시간 초과, 접수 여부 불명확 | 필요할 때 `check` 한 번 |
| `recipient-observed`·`received` | 상대가 받음 | 다시 보내지 않는다 |
| `send-blocked` | 보내지 않음(이유는 `nextAction`) | 원인을 고친 뒤 같은 ID로 `resume` |
| `write-scope-reserved` | 다른 위임과 쓰기 범위가 겹침 | 그 작업을 기다리거나 `release` 뒤 다시 보냄 |

- **종료 코드:** exit 0은 정상(대기 포함), exit 2는 조치 필요, exit 1은 입력·실행 오류다.
- **`scope-check`:** 회신 없이 끝난 위임을 기록 없이 지금 상태와 비교한다.
