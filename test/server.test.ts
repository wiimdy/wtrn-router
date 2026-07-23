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
  response.setHeader('content-type', 'application/json');
  response.end(
    JSON.stringify({
      body:
        request.headers['content-encoding'] === 'test-binary'
          ? body.toString('base64')
          : JSON.parse(body.toString('utf8')),
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
  assert.deepEqual(payload.body, { model: 'gpt-5', input: 'hello' });
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
      max_tokens: 32,
      messages: [{ role: 'user', content: 'hello' }],
    }),
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as Record<string, unknown>;
  assert.equal(payload.path, '/api/v1/providers/messages?beta=true');
  assert.equal(payload.anthropicBeta, 'example-beta');
  assert.equal(payload.upstreamApiKey, 'wrtn-secret');
});

test('translates Wrtn model support into an OpenAI-style model list', async () => {
  const response = await fetch(`${proxyOrigin}/v1/models`, {
    headers: { 'x-api-key': 'client-secret' },
  });

  assert.equal(response.status, 200);
  const payload = (await response.json()) as {
    data: Array<{ id: string }>;
  };
  assert.deepEqual(
    payload.data.map((model) => model.id),
    ['claude-sonnet-4-6', 'gpt-5'],
  );
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
