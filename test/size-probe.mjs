// Probes the upstream request-size limit through the local proxy.
// Usage: node test/size-probe.mjs [model]
import { readFileSync } from "node:fs";

const PROXY = process.env.PROXY_ORIGIN ?? "http://127.0.0.1:8788";
const MODEL = process.argv[2] ?? "__size-probe-invalid__";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const apiKey = env.match(/^WRTN_API_KEY=(.*)$/m)?.[1]?.trim();
if (!apiKey) throw new Error("WRTN_API_KEY missing from .env");

const KB = 1024;
// 10240 KB는 통과, 10241 KB부터 413이 되는 경계를 포함한다.
const SIZES = [64, 256, 1024, 4096, 8192, 10240, 10241, 12288];

function buildBody(targetBytes) {
  const skeleton = {
    model: MODEL,
    stream: false,
    max_tokens: 1,
    messages: [{ role: "user", content: "" }],
  };
  const overhead = Buffer.byteLength(JSON.stringify(skeleton));
  const padLength = Math.max(0, targetBytes - overhead);
  skeleton.messages[0].content = "a".repeat(padLength);
  return JSON.stringify(skeleton);
}

for (const kb of SIZES) {
  const body = buildBody(kb * KB);
  const bytes = Buffer.byteLength(body);
  let status;
  let snippet;
  try {
    const res = await fetch(`${PROXY}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body,
    });
    status = res.status;
    snippet = (await res.text()).slice(0, 200).replace(/\s+/g, " ");
  } catch (error) {
    status = "ERR";
    snippet = error.message;
  }
  const label = String(kb).padStart(5);
  console.info(`${label} KB (${bytes} bytes) -> ${status} :: ${snippet}`);
}
