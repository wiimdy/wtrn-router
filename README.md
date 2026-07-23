# Wrtn CLI Proxy

A small local gateway that lets Codex CLI and Claude Code use one Wrtn Router
API key without changing either client's wire protocol.

Wrtn already supports the required formats:

- Codex: OpenAI Responses API
- Claude Code: Anthropic Messages API

The proxy only rewrites paths, normalizes authentication to `X-API-Key`,
and passes request fields and beta headers through. Wrtn's Responses stream
does not terminate reliably, and its Messages stream omits lifecycle events
that Claude Code expects. The proxy therefore requests non-streaming results
and emits standards-shaped SSE event sequences for both clients after each
upstream response completes.

## Routes

| Client route | Wrtn Router route |
| --- | --- |
| `POST /v1/responses` | `POST /api/v1/providers/responses` |
| `POST /v1/messages` | `POST /api/v1/providers/messages` |
| `POST /v1/chat/completions` | `POST /api/v1/providers/chat/completion` |
| `GET /v1/models` | Transformed from `GET /api/v1/models/support` |

`POST /v1/messages/count_tokens` intentionally returns `404`. Anthropic
documents this endpoint as optional; Claude Code estimates token usage locally
when it is unavailable.

## Requirements

- Node.js 20 or newer
- A Wrtn Router API key

## Install and run

```bash
npm install
npm run build

cp .env.example .env
# Edit .env and set WRTN_API_KEY.
npm start
```

The default listener is `http://127.0.0.1:8787`. Supported environment
variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `WRTN_API_KEY` | required | Credential sent to Wrtn Router |
| `WRTN_BASE_URL` | `https://api.wrtn.ax/api/v1` | Wrtn API base URL |
| `HOST` | `127.0.0.1` | Proxy bind host |
| `PORT` | `8787` | Proxy bind port |
| `WRTN_MESSAGES_MAX_TOKENS` | `16384` | Caps Claude Code output tokens to Wrtn's reliable limit |
| `CLIENT_API_KEY` | `WRTN_API_KEY` | Optional separate client-to-proxy key |

The server refuses a non-loopback bind unless `CLIENT_API_KEY` is explicitly
set. Values already exported by the shell take precedence over `.env`.

## Codex CLI

Merge [`config/codex.config.toml`](config/codex.config.toml) into the
user-level `~/.codex/config.toml`. Codex does not allow provider configuration
from a project-local `.codex/config.toml`.

With the proxy running:

```bash
export WRTN_API_KEY="your-wrtn-api-key"
codex --profile wrtn
```

If `CLIENT_API_KEY` is set on the proxy, change `env_key` in the Codex provider
block to `"CLIENT_API_KEY"` and export that variable before starting Codex.

## Claude Code

Source the supplied environment configuration:

```bash
source config/claude-code.env.sh
claude
```

The script loads the project `.env` automatically when neither
`WRTN_API_KEY` nor `CLIENT_API_KEY` is already exported. It sets both
`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` so an existing Claude OAuth
login does not override the local gateway credential.

Check `/status` inside Claude Code. It should show:

- Anthropic base URL: `http://127.0.0.1:8787`
- API key: `ANTHROPIC_API_KEY`

The model aliases in `config/claude-code.env.sh` are explicit Wrtn-supported
IDs. Adjust them if your account should use different models.
Claude Code's requested output limit is set to `16384`, matching the reliable
Wrtn limit enforced by the proxy.

## Smoke checks

Health:

```bash
curl http://127.0.0.1:8787/health
```

Responses API:

```bash
curl http://127.0.0.1:8787/v1/responses \
  -H "Authorization: Bearer $WRTN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-5","input":"Say hello"}'
```

Messages API:

```bash
curl http://127.0.0.1:8787/v1/messages \
  -H "X-API-Key: $WRTN_API_KEY" \
  -H "anthropic-version: 2023-06-01" \
  -H "Content-Type: application/json" \
  -d '{
    "model":"claude-sonnet-4-6",
    "max_tokens":64,
    "messages":[{"role":"user","content":"Say hello"}]
  }'
```

## Security behavior

- Request bodies and credentials are never logged.
- Client `Authorization` and `X-API-Key` headers are consumed locally.
- Only the configured Wrtn key is sent upstream as `X-API-Key`.
- The default listener is loopback-only.
- Wrtn error bodies are forwarded without logging their request bodies.
- Codex Responses and Claude Messages requests use buffered upstream
  generation with synthesized SSE completion events. This preserves client
  compatibility but not token-by-token latency.
- When Wrtn rejects a very large Codex request with `413`, the proxy retries
  after compacting tool descriptions and, if necessary, omitting namespace
  tools supplied by connected apps. The same fallback compacts Claude Code
  tool descriptions and can omit extension tools as a final retry.
- Wrtn currently returns `502` when a Messages request includes completed
  Anthropic `tool_use` and `tool_result` blocks. The proxy keeps new tool calls
  native, but converts completed tool-call history to text before forwarding
  follow-up turns. Claude Code can therefore execute tools and continue the
  same turn normally.

## Known compatibility boundary

The proxy preserves the protocols Wrtn documents; it does not emulate features
Wrtn itself does not support. Future Codex or Claude Code releases may add
request fields or beta capabilities. The proxy passes those fields and
`anthropic-*` headers through unchanged, but the upstream Router ultimately
decides whether to accept them.

Codex installations with many connected apps can exceed Wrtn's request-size
limit. In that case, the automatic fallback removes those namespace tools for
the affected turn. Start Codex with only the connector needed for a task when
that connector must be callable through Wrtn.
