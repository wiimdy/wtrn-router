#!/usr/bin/env bash

# Load the project .env automatically when the caller has not exported a key.
if [[ -z "${WRTN_API_KEY:-}" && -z "${CLIENT_API_KEY:-}" ]]; then
  if [[ -n "${ZSH_VERSION:-}" ]]; then
    wrtn_config_path="${(%):-%N}"
  else
    wrtn_config_path="${BASH_SOURCE[0]}"
  fi

  wrtn_router_root="$(cd -- "$(dirname -- "${wrtn_config_path}")/.." && pwd)"
  if [[ -f "${wrtn_router_root}/.env" ]]; then
    set -a
    source "${wrtn_router_root}/.env"
    set +a
  fi

  unset wrtn_config_path wrtn_router_root
fi

if [[ -z "${WRTN_API_KEY:-}" && -z "${CLIENT_API_KEY:-}" ]]; then
  echo "WRTN_API_KEY or CLIENT_API_KEY must be set" >&2
  return 1
fi

export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="${CLIENT_API_KEY:-${WRTN_API_KEY}}"

# Pin Wrtn-supported model IDs for Claude Code's model roles.
export ANTHROPIC_MODEL="claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5-20251001"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="16384"

# Optional model picker discovery through this proxy.
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
