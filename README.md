# Wrtn Router for OpenCode

OpenCode에서 Wrtn의 Claude와 GPT 모델을 사용하기 위한 로컬 프록시입니다.

## 빠른 시작

요구 사항: Node.js 20 이상, OpenCode, Wrtn API 키

### 1. 프록시 실행

```bash
git clone git@github.com:wiimdy/wtrn-router.git
cd wtrn-router
npm start
```

프록시는 `http://127.0.0.1:8788`에서 실행됩니다.

### 2. OpenCode 설정

새 설정이라면:

```bash
mkdir -p ~/.config/opencode
cp config/opencode.jsonc ~/.config/opencode/opencode.jsonc
```

기존 `opencode.jsonc`가 있다면 [`config/opencode.jsonc`](config/opencode.jsonc)의 `provider.wrtn-chat` 부분만 기존 설정에 추가하세요.

### 3. OpenCode 실행

새 터미널에서:

```bash
export WRTN_API_KEY='your-api-key'
opencode
```

OpenCode에서 `wrtn-chat/claude-opus-4-8` 또는 `wrtn-chat/gpt-5`를 선택하면 됩니다.

## 등록 모델

| 모델 | context | output |
| --- | ---: | ---: |
| `claude-opus-4-8` | 1,000,000 | 128,000 |
| `gpt-5` | 400,000 | 128,000 |

## 백그라운드 실행

저장소가 `~/wtrn-router`에 있을 때:

```bash
mkdir -p ~/.config/systemd/user
cp systemd/wrtn-opencode-proxy.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now wrtn-opencode-proxy.service
```

상태 확인:

```bash
curl -sS http://127.0.0.1:8788/health
```

프록시는 OpenCode의 `/v1/chat/completions` 요청을 Wrtn Chat API로 전달하며, 요청과 스트리밍 응답은 변경하지 않습니다.
