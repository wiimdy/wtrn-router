import { createInterface } from "node:readline";
import { query } from "@anthropic-ai/claude-agent-sdk";

const apiKey = process.env.WRTN_API_KEY;
if (!apiKey) throw new Error("WRTN_API_KEY must be set");

async function* userInput() {
  const lines = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  });

  console.log("메시지를 입력하세요. 종료: Ctrl-D");
  for await (const text of lines) {
    if (!text.trim()) continue;
    yield {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
  }
}

for await (const message of query({
  prompt: userInput(),
  options: {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: "http://127.0.0.1:8788",
      ANTHROPIC_API_KEY: apiKey,
    },
    model: "claude-opus-4-8",
    includePartialMessages: true,
  },
})) {
  if (
    message.type === "stream_event" &&
    message.event.type === "content_block_delta" &&
    message.event.delta.type === "text_delta"
  ) {
    process.stdout.write(message.event.delta.text);
  }

  if (message.type === "result") {
    process.stdout.write("\n");
    console.error(`session: ${message.session_id}`);
  }
}
