# Wrtn CLI Proxy

A small local gateway that lets Codex CLI and Claude Code use one Wrtn Router
API key without changing either client's wire protocol.

Wrtn already supports the required formats:

- Codex: OpenAI Responses API
- Claude Code: Anthropic Messages API

The proxy only rewrites paths, normalizes authentication to `X-API-Key`,
passes request fields and beta headers through, and relays SSE without
buffering.

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

export WRTN_API_KEY="your-wrtn-api-key"
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
| `CLIENT_API_KEY` | `WRTN_API_KEY` | Optional separate client-to-proxy key |

The server refuses a non-loopback bind unless `CLIENT_API_KEY` is explicitly
set.

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
export WRTN_API_KEY="your-wrtn-api-key"
source config/claude-code.env.sh
claude
```

Check `/status` inside Claude Code. It should show:

- Anthropic base URL: `http://127.0.0.1:8787`
- API key: `ANTHROPIC_API_KEY`

The model aliases in `config/claude-code.env.sh` are explicit Wrtn-supported
IDs. Adjust them if your account should use different models.

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
- Wrtn error bodies and SSE events are forwarded without schema rewriting.

## Known compatibility boundary

The proxy preserves the protocols Wrtn documents; it does not emulate features
Wrtn itself does not support. Future Codex or Claude Code releases may add
request fields or beta capabilities. The proxy passes those fields and
`anthropic-*` headers through unchanged, but the upstream Router ultimately
decides whether to accept them.
