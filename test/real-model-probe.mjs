// Sends real (small, then progressively larger) requests through the proxy to
// confirm the model path itself accepts payloads that previously 413'd.
// Usage: node test/real-model-probe.mjs <model> <kb...>
import { readFileSync } from "node:fs";

const PROXY = process.env.PROXY_ORIGIN ?? "http://127.0.0.1:8788";
const [model, ...sizeArgs] = process.argv.slice(2);
if (!model) throw new Error("usage: node test/real-model-probe.mjs <model> <kb...>");
const SIZES = sizeArgs.length ? sizeArgs.map(Number) : [1];

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const apiKey = env.match(/^WRTN_API_KEY=(.*)$/m)?.[1]?.trim();
if (!apiKey) throw new Error("WRTN_API_KEY missing from .env");

// Repeated filler that stays cheap to tokenize but is realistic JSON text.
const FILLER = "The quick brown fox jumps over the lazy dog. ";

function buildBody(targetBytes) {
  const skeleton = {
    model,
    stream: false,
    max_tokens: 16,
    messages: [
      { role: "user", content: "" },
      { role: "user", content: "Reply with exactly: OK" },
    ],
  };
  const overhead = Buffer.byteLength(JSON.stringify(skeleton));
  const padLength = Math.max(0, targetBytes - overhead);
  skeleton.messages[0].content = FILLER.repeat(
    Math.ceil(padLength / FILLER.length),
  ).slice(0, padLength);
  return JSON.stringify(skeleton);
}

for (const kb of SIZES) {
  const body = buildBody(kb * 1024);
  const bytes = Buffer.byteLength(body);
  const started = process.hrtime.bigint();
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
    snippet = (await res.text()).slice(0, 300).replace(/\s+/g, " ");
  } catch (error) {
    status = "ERR";
    snippet = error.message;
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.info(
    `${model} ${String(kb).padStart(5)} KB (${bytes} bytes) -> ${status} ` +
      `in ${ms.toFixed(0)}ms :: ${snippet}`,
  );
}
