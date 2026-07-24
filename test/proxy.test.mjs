import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { createProxyServer } from "../src/proxy.mjs";

let upstream;
let proxy;
let upstreamOrigin;
let proxyOrigin;
const capturedRequests = [];

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
    capturedRequests.push({
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });

    if (request.url.startsWith("/api/v1/providers/messages")) {
      response.writeHead(201, { "content-type": "text/event-stream" });
      response.write(
        'event: message_start\r\ndata: {"type":"message_start","message":{"type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\r\n\r\n',
      );
      response.write(
        'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"OK"}}\r\n\r\n',
      );
      response.write(
        'event: content_block_stop\r\ndata: {"type":"content_block_stop","index":1}\r\n\r\n',
      );
      response.write(
        'event: message_delta\r\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\r\n\r\n',
      );
      response.end(
        'event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n',
      );
      return;
    }

    if (request.url.startsWith("/api/v1/providers/responses")) {
      response.writeHead(201, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(
        JSON.stringify({
          object: "response",
          status: "completed",
          model: "gpt-5",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "OK", annotations: [] },
              ],
            },
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        }),
      );
      return;
    }

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

test("rewrites Chat Completions and preserves its SSE stream", async () => {
  const payload = {
    model: "claude-opus-4-8",
    stream: true,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
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
  assert.equal(
    await response.text(),
    'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n',
  );

  const captured = capturedRequests.at(-1);
  assert.equal(captured.url, "/api/v1/providers/chat/completion?trace=1");
  assert.equal(captured.headers["x-api-key"], "test-key");
  assert.deepEqual(JSON.parse(captured.body), payload);
});

test("rewrites Responses, removes Codex-only metadata, and preserves SSE", async () => {
  const response = await fetch(`${proxyOrigin}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-key",
    },
    body: JSON.stringify({
      model: "gpt-5",
      input: "Reply with exactly: OK",
      stream: true,
      client_metadata: { originator: "codex_sdk_ts" },
      previous_response_id: "resp_local",
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: response\.output_text\.delta/);
  assert.match(body, /event: response\.completed/);

  const captured = capturedRequests.at(-1);
  assert.equal(captured.url, "/api/v1/providers/responses");
  assert.equal(captured.headers["x-api-key"], "test-key");
  assert.deepEqual(JSON.parse(captured.body), {
    model: "gpt-5",
    input: "Reply with exactly: OK",
    stream: false,
  });
});

test("flattens completed Responses tool roundtrips for Wrtn", async () => {
  const response = await fetch(`${proxyOrigin}/v1/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer test-key",
    },
    body: JSON.stringify({
      model: "gpt-5",
      stream: true,
      previous_response_id: "resp_previous",
      input: [
        { type: "reasoning", id: "rs_1", summary: [] },
        {
          type: "function_call",
          id: "fc_1",
          call_id: "call_1",
          name: "shell",
          arguments: '{"command":"pwd"}',
        },
        {
          type: "function_call_output",
          call_id: "call_1",
          output: "/home/ubuntu",
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  await response.text();

  const captured = capturedRequests.at(-1);
  const payload = JSON.parse(captured.body);
  assert.equal(payload.stream, false);
  assert.equal(payload.previous_response_id, undefined);
  assert.equal(
    payload.input.some((item) =>
      ["function_call", "function_call_output", "reasoning"].includes(item.type),
    ),
    false,
  );
  assert.match(
    payload.input[0].content[0].text,
    /\[Tool execution result\][\s\S]*\/home\/ubuntu/,
  );
});

test("rewrites Messages and repairs malformed Wrtn text block SSE", async () => {
  const response = await fetch(`${proxyOrigin}/v1/messages?beta=true`, {
    method: "POST",
    headers: {
      "anthropic-beta": "example-beta",
      "content-type": "application/json",
      "x-api-key": "test-key",
    },
    body: JSON.stringify({
      model: "claude-opus-4-8",
      max_tokens: 32,
      stream: true,
      messages: [
        { role: "user", content: "Run pwd" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Bash",
              input: { command: "pwd" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_1",
              content: "/home/ubuntu",
            },
          ],
        },
      ],
    }),
  });

  assert.equal(response.status, 201);
  const body = await response.text();
  assert.match(
    body,
    /event: content_block_start\ndata: \{"type":"content_block_start","index":0/,
  );
  assert.match(body, /"type":"text_delta","text":"OK"/);
  assert.match(
    body,
    /event: content_block_stop\ndata: \{"type":"content_block_stop","index":0\}/,
  );

  const captured = capturedRequests.at(-1);
  assert.equal(captured.url, "/api/v1/providers/messages?beta=true");
  assert.equal(captured.headers["anthropic-beta"], "example-beta");
  assert.equal(captured.headers["x-api-key"], "test-key");
  const payload = JSON.parse(captured.body);
  assert.equal(payload.messages[1].content[0].type, "text");
  assert.match(payload.messages[1].content[0].text, /Previous assistant tool request/);
  assert.equal(payload.messages[2].content[0].type, "text");
  assert.match(
    payload.messages[2].content[0].text,
    /\[Tool execution result\][\s\S]*\/home\/ubuntu/,
  );
});

test("supports health, Claude's probe, and rejects unknown paths", async () => {
  const health = await fetch(`${proxyOrigin}/health`);
  assert.deepEqual(await health.json(), { status: "ok" });

  const hello = await fetch(`${proxyOrigin}/api/hello`, { method: "HEAD" });
  assert.equal(hello.status, 200);

  const unsupported = await fetch(`${proxyOrigin}/v1/unknown`, {
    method: "POST",
  });
  assert.equal(unsupported.status, 404);
  assert.match((await unsupported.json()).error.message, /v1\/responses/);
});
