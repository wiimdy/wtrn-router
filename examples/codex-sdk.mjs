import { createInterface } from "node:readline";
import { Codex } from "@openai/codex-sdk";

const apiKey = process.env.WRTN_API_KEY;
if (!apiKey) throw new Error("WRTN_API_KEY must be set");

const codex = new Codex({
  config: {
    model_provider: "wrtn",
    model_context_window: 400000,
    model_providers: {
      wrtn: {
        name: "Wrtn",
        base_url: "http://127.0.0.1:8788/v1",
        wire_api: "responses",
        env_key: "WRTN_API_KEY",
        supports_websockets: false,
      },
    },
  },
  env: { ...process.env, WRTN_API_KEY: apiKey },
});

const thread = process.env.CODEX_THREAD_ID
  ? codex.resumeThread(process.env.CODEX_THREAD_ID)
  : codex.startThread({
      model: "gpt-5",
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      sandboxMode: "workspace-write",
      approvalPolicy: "never",
    });

const lines = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

console.log("메시지를 입력하세요. 종료: Ctrl-D");
for await (const input of lines) {
  if (!input.trim()) continue;

  const { events } = await thread.runStreamed(input);
  for await (const event of events) {
    if (
      event.type === "item.completed" &&
      event.item.type === "agent_message"
    ) {
      console.log(event.item.text);
    }
  }

  console.error(`thread: ${thread.id}`);
}
