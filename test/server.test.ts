import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type Server,
} from 'node:http';
import { once } from 'node:events';
import test, { after, before } from 'node:test';
import { createProxyServer } from '../src/server.js';

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
};

let upstreamOrigin = '';
let proxyOrigin = '';
let proxyServer: Server;

const upstreamServer = createServer(async (request, response) => {
  if (request.url === '/api/v1/models/support') {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        status: 200,
        data: {
          claude: [
            { provider: 'anthropic', name: 'claude-sonnet-4-6' },
          ],
          gpt: [{ provider: 'openai', name: 'gpt-5' }],
        },
      }),
    );
    return;
  }

  const body = await readBody(request);
  const parsedBody =
    request.headers['content-encoding'] === 'test-binary'
      ? body.toString('base64')
      : JSON.parse(body.toString('utf8'));

  if (
    request.url === '/api/v1/providers/responses' &&
    typeof parsedBody === 'object' &&
    parsedBody !== null &&
    'input' in parsedBody &&
    (parsedBody.input === 'stream-test' ||
      parsedBody.input === 'large-tools-test')
  ) {
    const tools: unknown[] =
      'tools' in parsedBody && Array.isArray(parsedBody.tools)
        ? parsedBody.tools
        : [];
    if (
      parsedBody.input === 'large-tools-test' &&
      tools.some(
        (tool) =>
          typeof tool === 'object' &&
          tool !== null &&
          'type' in tool &&
          tool.type === 'namespace',
      )
    ) {
      response.writeHead(413);
      response.end(JSON.stringify({ error: 'request entity too large' }));
      return;
    }

    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        object: 'response',
        status: 'completed',
        upstream_stream: parsedBody.stream,
        upstream_tools: tools,
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'OK', annotations: [] }],
          },
        ],
      }),
    );
    return;
  }

  if (
    request.url === '/api/v1/providers/messages?beta=true' &&
    typeof parsedBody === 'object' &&
    parsedBody !== null &&
    'messages' in parsedBody &&
    Array.isArray(parsedBody.messages) &&
    parsedBody.messages[0]?.content === 'stream-test'
  ) {
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-6',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 10,
          output_tokens: 4,
          upstream_max_tokens: parsedBody.max_tokens,
        },
      }),
    );
    return;
  }

  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      body: parsedBody,
      path: request.url,
      authorization: request.headers.authorization ?? null,
      anthropicBeta: request.headers['anthropic-beta'] ?? null,
      upstreamApiKey: request.headers['x-api-key'] ?? null,
    }),
  );
});

before(async () => {
  upstreamServer.listen(0, '127.0.0.1');
  await once(upstreamServer, 'listening');
  const upstreamAddress = upstreamServer.address();
  assert(upstreamAddress && typeof upstreamAddress !== 'string');
  upstreamOrigin = `http://127.0.0.1:${upstreamAddress.port}`;

  proxyServer = createProxyServer({
    clientApiKey: 'client-secret',
    upstreamApiKey: 'wrtn-secret',
    upstreamBaseUrl: `${upstreamOrigin}/api/v1`,
  });

  proxyServer.listen(0, '127.0.0.1');
  await once(proxyServer, 'listening');
  const proxyAddress = proxyServer.address();
  assert(proxyAddress && typeof proxyAddress !== 'string');
  proxyOrigin = `http://127.0.0.1:${proxyAddress.port}`;
});

after(async () => {
  proxyServer.close();
  upstreamServer.close();
  await Promise.all([
    once(proxyServer, 'close'),
    once(upstreamServer, 'close'),
  ]);
});

test('rewrites the Responses path and normalizes authentication', async () => {
  const response = await fetch(`${proxyOrigin}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer client-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: 'gpt-5', input: 'hello' }),
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.path, '/api/v1/providers/responses');
  assert.equal(payload.upstreamApiKey, 'wrtn-secret');
  assert.equal(payload.authorization, null);
  assert.deepEqual(payload.body, {
    model: 'gpt-5',
    input: 'hello',
    stream: false,
  });
});

test('forwards encoded request bodies without converting their bytes', async () => {
  const binaryBody = new Uint8Array([0, 255, 1, 128, 2]);
  const response = await fetch(`${proxyOrigin}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer client-secret',
      'content-encoding': 'test-binary',
      'content-type': 'application/octet-stream',
    },
    body: binaryBody,
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.body, Buffer.from(binaryBody).toString('base64'));
});

test('adapts buffered Wrtn Responses output into Codex SSE events', async () => {
  const response = await fetch(`${proxyOrigin}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer client-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5-mini',
      input: 'stream-test',
      stream: true,
    }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const body = await response.text();
  assert.match(body, /event: response\.output_text\.delta/);
  assert.match(body, /event: response\.completed/);
  assert.match(body, /"upstream_stream":false/);

  const events = body
    .split('\n\n')
    .map((event) => event.split('\n').find((line) => line.startsWith('data: ')))
    .filter((line): line is string => line !== undefined)
    .map(
      (line) =>
        JSON.parse(line.slice('data: '.length)) as Record<string, unknown>,
    );
  const completedEvent = events.find(
    (event) => event.type === 'response.completed',
  );
  assert(completedEvent);
  const completedResponse = completedEvent.response;
  assert(completedResponse && typeof completedResponse === 'object');
  assert.match(
    (completedResponse as Record<string, unknown>).id as string,
    /^resp_[a-f0-9]{32}$/,
  );
  const output = (completedResponse as Record<string, unknown>).output;
  assert(Array.isArray(output));
  assert.match(
    (output[0] as Record<string, unknown>).id as string,
    /^msg_[a-f0-9]{32}$/,
  );
});

test('retries oversized Codex payloads without namespace tools', async () => {
  const response = await fetch(`${proxyOrigin}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer client-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-5',
      input: 'large-tools-test',
      stream: true,
      tools: [
        {
          type: 'namespace',
          name: 'large_connector',
          description: 'large connector',
          tools: [],
        },
        {
          type: 'function',
          name: 'exec_command',
          description: 'run a command',
          parameters: { type: 'object' },
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"name":"exec_command"/);
  assert.doesNotMatch(body, /"name":"large_connector"/);
  assert.match(body, /event: response\.completed/);
});

test('rewrites the Messages path while preserving query and beta headers', async () => {
  const response = await fetch(`${proxyOrigin}/v1/messages?beta=true`, {
    method: 'POST',
    headers: {
      'anthropic-beta': 'example-beta',
      'content-type': 'application/json',
      'x-api-key': 'client-secret',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 32_000,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.path, '/api/v1/providers/messages?beta=true');
  assert.equal(payload.anthropicBeta, 'example-beta');
  assert.equal(payload.upstreamApiKey, 'wrtn-secret');
});

test('adapts buffered Wrtn Messages output into Claude SSE events', async () => {
  const response = await fetch(`${proxyOrigin}/v1/messages?beta=true`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'client-secret',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 32_000,
      stream: true,
      messages: [{ role: 'user', content: 'stream-test' }],
    }),
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /event: content_block_start/);
  assert.match(body, /"type":"text_delta","text":"OK"/);
  assert.match(body, /"upstream_max_tokens":16384/);
  assert.match(body, /event: message_stop/);
});

test('translates Wrtn model support into an OpenAI-style model list', async () => {
  const response = await fetch(`${proxyOrigin}/v1/models`, {
    headers: { 'x-api-key': 'client-secret' },
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    data: Array<{ id: string }>;
    models: unknown[];
  };
  assert.deepEqual(
    payload.data.map((model) => model.id),
    ['claude-sonnet-4-6', 'gpt-5'],
  );
  assert.deepEqual(payload.models, []);
});

test('rejects an invalid client credential', async () => {
  const response = await fetch(`${proxyOrigin}/v1/responses`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer wrong-secret',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ input: 'hello' }),
  });

  assert.equal(response.status, 401);
});
