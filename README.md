# Wrtn Router

OpenCode, Codex SDK, Claude Agent SDK를 Wrtn API에 연결하는 로컬 프록시입니다.

## 빠른 시작: OpenCode

먼저 [OpenCode](https://opencode.ai/docs)를 설치하세요.

```bash
npm install -g opencode-ai
```

```bash
git clone git@github.com:wiimdy/wtrn-router.git
cd wtrn-router
npm install && npm run opencode
```

## 프록시 관리

OpenCode 설정과 백그라운드 프록시만 준비하려면:

```bash
npm run setup
```

상태와 로그 확인:

```bash
curl -sS http://127.0.0.1:8788/health
tail -f wrtn-router.log
```

온보딩 스크립트가 실행한 프록시 종료:

```bash
npm run stop
```

포그라운드에서 직접 실행하려면 `npm start`를 사용하세요.

### Wrtn 403 문제

Wrtn 호출이 `Forbidden`을 반환하면 먼저 상류 접근 여부를 확인하세요.

```bash
curl -I https://api.wrtn.ax/
```

여기서도 Cloudflare 403이 반환되면 모델 요청 본문을 처리하기 전에 현재 네트워크가
차단된 상태입니다. Wrtn이 허용하는 네트워크에서 다시 시도하거나 Wrtn 지원팀에
접근 허용을 요청하세요. 임의의 중계 서버로 보안 차단을 우회하지 마세요.

## systemd 백그라운드 실행

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


이 명령은 기존 OpenCode 설정을 백업한 뒤 `wrtn-chat` provider를 병합하고,
승인 질문을 끄는 `permission: "allow"`를 영구 적용하며, 프록시를 백그라운드로
실행한 다음 OpenCode를 시작합니다. 기존의 다른 provider와 설정은 유지됩니다.

> `permission: "allow"`는 셸 실행과 파일 수정도 묻지 않고 허용합니다. 신뢰할 수
> 있는 프로젝트에서만 사용하세요.

프록시 기본 주소는 `http://127.0.0.1:8788`입니다. 최초 한 번 OpenCode에서
`/connect`를 실행한 뒤 `Other`를 선택하고 다음 값을 등록하세요.

```text
Provider ID: wrtn-chat
API key: Wrtn API 키
```

키는 권한 `600`인 OpenCode 인증 저장소에 보관됩니다. 이후 새 터미널에서도
`WRTN_API_KEY`를 export할 필요가 없습니다.

등록 모델:

| 모델 | 용도 | context | output |
| --- | --- | ---: | ---: |
| `claude-opus-4-8` | 주력 | 1,000,000 | 128,000 |
| `claude-sonnet-4-6` | 빠른 Opus 대안 | 1,000,000 | 128,000 |
| `claude-haiku-4-5-20251001` | 빠르고 가벼운 작업 | 200,000 | 64,000 |
| `gpt-5` | GPT 주력 | 400,000 | 128,000 |
| `gpt-5.6-sol` | GPT 플래그십 | 1,050,000 | 128,000 |
| `gpt-5.6-terra` | GPT 밸런스형 | 1,050,000 | 128,000 |
| `gpt-5.6-luna` | GPT 저비용 | 1,050,000 | 128,000 |
| `kimi-k3` | 오픈 모델 | 1,048,576 | 131,072 |
| `glm-5.2` | 오픈 모델 | 500,000 | 131,072 |
| `gpt-4.1-mini` | 가벼운 비-Claude 대안 | 1,047,576 | 32,768 |

`glm-5.2`의 context는 문서상 1,048,576이지만, 1.5MB(약 786k 토큰) 이상 요청부터
상류가 429를 반환해 500,000으로 제한했습니다.

Claude Opus는 `low`, `medium`, `high`, `xhigh`, `max`를 제공합니다.
Sonnet과 Haiku는 `low`부터 `xhigh`까지, GPT-5는 `none`부터 `xhigh`까지,
GPT-5.6 시리즈(Sol/Terra/Luna)는 `none`부터 `max`까지 reasoning effort variant를
제공합니다. OpenCode의 variant 전환 키 또는 `opencode run --variant max`처럼
선택할 수 있습니다.

`gpt-5.6-sol`은 function tool과 reasoning을 함께 사용할 수 있도록 OpenAI
Responses API(`/v1/responses`)로 라우팅됩니다.

## Wrtn에서 GPT-5.6 Sol 직접 호출

OpenCode 없이 Wrtn Responses API를 직접 호출할 수 있습니다.

```bash
export WRTN_API_KEY='your-api-key'

curl https://api.wrtn.ax/api/v1/providers/responses \
  -H "x-api-key: $WRTN_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "model": "gpt-5.6-sol",
    "stream": false,
    "input": "Reply with exactly OK.",
    "max_output_tokens": 16
  }'
```

Wrtn의 live model catalog에서 `gpt-5.6-sol`을 확인하려면:

```bash
curl https://api.wrtn.ax/api/v1/models/support
```



## Codex SDK

```bash
npm install @openai/codex-sdk
export WRTN_API_KEY='your-api-key'
node examples/codex-sdk.mjs
```

입력할 때마다 같은 Codex Thread가 자동으로 이어집니다. 프로그램을 다시 실행할 때는 출력된 ID를 `CODEX_THREAD_ID`에 넣으면 기존 Thread를 재개합니다.

```bash
CODEX_THREAD_ID='thread-id' node examples/codex-sdk.mjs
```

## Claude Agent SDK

```bash
npm install @anthropic-ai/claude-agent-sdk
export WRTN_API_KEY='your-api-key'
node examples/claude-agent-sdk.mjs
```

표준 입력이 Claude Agent SDK의 Streaming Input으로 전달되며, 실행 중에는 같은 세션이 자동으로 유지됩니다.
SDK는 OpenCode 인증 저장소를 읽지 않으므로 API 키를 별도로 전달해야 합니다.

