# Wrtn Router for OpenCode

OpenCode의 OpenAI 호환 요청을 Wrtn Chat API로 연결하는 최소 프록시입니다.

OpenCode가 호출하는 경로:

```text
POST /v1/chat/completions
```

Wrtn이 제공하는 실제 경로:

```text
POST /api/v1/providers/chat/completion
```

프록시는 이 경로만 바꾸며 요청 본문과 스트리밍 응답은 그대로 전달합니다. Claude 모델도 Anthropic Messages 형식이 아니라 Wrtn Chat 경로를 사용하므로, 도구 호출 뒤 `tool_result`가 누락되는 호환성 문제를 피할 수 있습니다.

## 요구 사항

- Node.js 20 이상
- Wrtn API 키
- OpenCode

## 실행

```bash
git clone git@github.com:wiimdy/wtrn-router.git
cd wtrn-router
export WRTN_API_KEY='your-api-key'
npm start
```

기본 주소는 `http://127.0.0.1:8788`입니다. 필요하면 `PORT`, `WRTN_UPSTREAM_ORIGIN` 환경 변수로 바꿀 수 있습니다. 보안을 위해 `HOST`는 루프백 주소만 허용합니다.

정상 동작 확인:

```bash
curl -sS http://127.0.0.1:8788/health
```

## OpenCode 설정

[`config/opencode.jsonc`](config/opencode.jsonc)의 `provider.wrtn-chat`을 `~/.config/opencode/opencode.jsonc`에 병합합니다.

```bash
export WRTN_API_KEY='your-api-key'
opencode
```

등록된 모델과 한도:

| 모델 | context | output |
| --- | ---: | ---: |
| `claude-opus-4-8` | 1,000,000 | 128,000 |
| `gpt-5` | 400,000 | 128,000 |

`temperature`는 모델 설정에 넣지 않습니다. Claude Opus 4.8에서 해당 파라미터가 거부될 수 있습니다.

## systemd 사용자 서비스

저장소를 `~/wtrn-router`에 둔 경우:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/wrtn-opencode-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wrtn-opencode-proxy.service
```

로그 확인:

```bash
journalctl --user -u wrtn-opencode-proxy.service -f
```

## 직접 API 테스트

```bash
curl -N -sS \
  -X POST 'http://127.0.0.1:8788/v1/chat/completions' \
  -H 'Content-Type: application/json' \
  -H "X-API-Key: $WRTN_API_KEY" \
  -d '{
    "model": "claude-opus-4-8",
    "stream": true,
    "messages": [
      { "role": "user", "content": "Reply with exactly: OK" }
    ]
  }'
```

## 테스트

```bash
npm test
```

프록시는 요청 내용이나 API 키를 로그에 남기지 않으며 기본적으로 루프백 주소에서만 수신합니다.
