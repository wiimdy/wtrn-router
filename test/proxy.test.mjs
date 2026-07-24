import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createProxyServer } from "../src/proxy.mjs";

let upstream;
let proxy;
let upstreamOrigin;
let proxyOrigin;
let capturedRequest;

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

before(async () => {
  upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    capturedRequest = {
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };

    response.writeHead(201, { "content-type": "text/event-stream" });
    response.write('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n');
    response.end("data: [DONE]\n\n");
  });
  upstreamOrigin = await listen(upstream);

  proxy = createProxyServer({ upstreamOrigin });
  proxyOrigin = await listen(proxy);
});

after(async () => {
  await close(proxy);
  await close(upstream);
});

test("rewrites the OpenCode Chat Completions path and preserves SSE", async () => {
  const payload = {
    model: "claude-opus-4-8",
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    tools: [{ type: "function", function: { name: "demo" } }],
  };

  const response = await fetch(`${proxyOrigin}/v1/chat/completions?trace=1`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-key",
    },
    body: JSON.stringify(payload),
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(
    await response.text(),
    'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
  );
  assert.equal(capturedRequest.url, "/api/v1/providers/chat/completion?trace=1");
  assert.equal(capturedRequest.headers["x-api-key"], "test-key");
  assert.deepEqual(JSON.parse(capturedRequest.body), payload);
});

test("exposes health and rejects unsupported compatibility paths", async () => {
  const health = await fetch(`${proxyOrigin}/health`);
  assert.deepEqual(await health.json(), { status: "ok" });

  const unsupported = await fetch(`${proxyOrigin}/v1/messages`, {
    method: "POST",
  });
  assert.equal(unsupported.status, 404);
  assert.match(
    (await unsupported.json()).error.message,
    /Only POST \/v1\/chat\/completions/,
  );
});
