# Wrtn Router

OpenCode, Codex SDK, Claude Agent SDK를 Wrtn API에 연결하는 로컬 프록시입니다.

## 1. 프록시 실행

```bash
git clone git@github.com:wiimdy/wtrn-router.git
cd wtrn-router
npm start
```

기본 주소는 `http://127.0.0.1:8788`입니다.

## 2. API 키 설정

프록시를 사용하는 터미널에서:

```bash
export WRTN_API_KEY='your-api-key'
```

## OpenCode

새 설정이라면:

```bash
mkdir -p ~/.config/opencode
cp config/opencode.jsonc ~/.config/opencode/opencode.jsonc
opencode
```

기존 설정이 있다면 [`config/opencode.jsonc`](config/opencode.jsonc)의 `provider.wrtn-chat`만 추가하세요.

## Codex SDK

```bash
npm install @openai/codex-sdk
node examples/codex-sdk.mjs
```

입력할 때마다 같은 Codex Thread가 자동으로 이어집니다. 프로그램을 다시 실행할 때는 출력된 ID를 `CODEX_THREAD_ID`에 넣으면 기존 Thread를 재개합니다.

```bash
CODEX_THREAD_ID='thread-id' node examples/codex-sdk.mjs
```

## Claude Agent SDK

```bash
npm install @anthropic-ai/claude-agent-sdk
node examples/claude-agent-sdk.mjs
```

표준 입력이 Claude Agent SDK의 Streaming Input으로 전달되며, 실행 중에는 같은 세션이 자동으로 유지됩니다.

## 백그라운드 실행

저장소가 `~/wtrn-router`에 있을 때:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/wrtn-router-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wrtn-router-proxy.service
```

상태 확인:

```bash
curl -sS http://127.0.0.1:8788/health
```

지원 경로:

- `/v1/chat/completions` → Wrtn Chat API
- `/v1/responses` → Wrtn Responses API
- `/v1/messages` → Wrtn Messages API
