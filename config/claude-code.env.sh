#!/usr/bin/env bash

# Source this file after exporting WRTN_API_KEY.
export ANTHROPIC_BASE_URL="http://127.0.0.1:8787"
export ANTHROPIC_API_KEY="${CLIENT_API_KEY:-${WRTN_API_KEY}}"

# Pin Wrtn-supported model IDs for Claude Code's model roles.
export ANTHROPIC_MODEL="claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_SONNET_MODEL="claude-sonnet-4-6"
export ANTHROPIC_DEFAULT_OPUS_MODEL="claude-opus-4-6"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="claude-haiku-4-5-20251001"

# Optional model picker discovery through this proxy.
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
