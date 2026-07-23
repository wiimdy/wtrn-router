import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'content-length',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const SENSITIVE_REQUEST_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
]);
const OMITTED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  'content-encoding',
]);

export interface ProxyConfig {
  clientApiKey: string;
  maxBodyBytes?: number;
  upstreamApiKey: string;
  upstreamBaseUrl: string;
}

interface WrtnModel {
  name?: unknown;
  provider?: unknown;
}

interface WrtnModelsResponse {
  data?: Record<string, WrtnModel[]>;
}

const jsonResponse = (
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void => {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
};

const errorResponse = (
  response: ServerResponse,
  statusCode: number,
  message: string,
): void => {
  jsonResponse(response, statusCode, {
    error: {
      message,
      type: statusCode === 401 ? 'authentication_error' : 'invalid_request_error',
    },
  });
};

const credentialsMatch = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

const getClientCredential = (headers: IncomingHttpHeaders): string | null => {
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string') {
    return apiKey;
  }

  const authorization = headers.authorization;
  if (typeof authorization !== 'string') {
    return null;
  }

  const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
  return bearerMatch?.[1] ?? null;
};

const readRequestBody = async (
  request: IncomingMessage,
  maxBodyBytes: number,
): Promise<Buffer | undefined> => {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return undefined;
  }

  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    receivedBytes += buffer.length;

    if (receivedBytes > maxBodyBytes) {
      throw new Error(`Request body exceeds ${maxBodyBytes} bytes`);
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
};

const buildUpstreamHeaders = (
  incomingHeaders: IncomingHttpHeaders,
  upstreamApiKey: string,
): Headers => {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incomingHeaders)) {
    const lowerName = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerName) ||
      SENSITIVE_REQUEST_HEADERS.has(lowerName) ||
      value === undefined
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }

  headers.set('x-api-key', upstreamApiKey);
  return headers;
};

const copyUpstreamHeaders = (
  upstreamHeaders: Headers,
  response: ServerResponse,
): void => {
  for (const [name, value] of upstreamHeaders) {
    if (!OMITTED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      response.setHeader(name, value);
    }
  }
};

const toModelList = (payload: WrtnModelsResponse): unknown => {
  const models = new Map<string, string>();

  for (const familyModels of Object.values(payload.data ?? {})) {
    for (const model of familyModels) {
      if (typeof model.name !== 'string' || models.has(model.name)) {
        continue;
      }

      models.set(
        model.name,
        typeof model.provider === 'string' ? model.provider : 'wrtn',
      );
    }
  }

  return {
    object: 'list',
    data: [...models.entries()].map(([id, provider]) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: provider,
      display_name: id,
    })),
  };
};

const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.replace(/\/+$/, '');

const routeUpstreamPath = (
  method: string,
  pathname: string,
): string | null => {
  if (method === 'POST' && pathname === '/v1/responses') {
    return '/providers/responses';
  }

  if (method === 'POST' && pathname === '/v1/messages') {
    return '/providers/messages';
  }

  if (method === 'POST' && pathname === '/v1/chat/completions') {
    return '/providers/chat/completion';
  }

  return null;
};

const forwardResponse = async (
  upstreamResponse: Response,
  response: ServerResponse,
): Promise<void> => {
  copyUpstreamHeaders(upstreamResponse.headers, response);
  response.writeHead(upstreamResponse.status);

  if (!upstreamResponse.body) {
    response.end();
    return;
  }

  const reader = upstreamResponse.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!response.write(value)) {
      await new Promise<void>((resolve) => {
        response.once('drain', resolve);
      });
    }
  }

  response.end();
};

export const createProxyServer = (
  config: ProxyConfig,
  fetchImplementation: typeof fetch = fetch,
): Server => {
  const upstreamBaseUrl = normalizeBaseUrl(config.upstreamBaseUrl);
  const maxBodyBytes = config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  return createServer(async (request, response) => {
    const startedAt = Date.now();
    const method = request.method ?? 'GET';
    const requestUrl = new URL(request.url ?? '/', 'http://localhost');

    response.on('finish', () => {
      const durationMs = Date.now() - startedAt;
      console.info(
        `${method} ${requestUrl.pathname} ${response.statusCode} ${durationMs}ms`,
      );
    });

    if (method === 'HEAD' && requestUrl.pathname === '/') {
      response.writeHead(200);
      response.end();
      return;
    }

    if (method === 'GET' && requestUrl.pathname === '/health') {
      jsonResponse(response, 200, { status: 'ok' });
      return;
    }

    const clientCredential = getClientCredential(request.headers);
    if (
      clientCredential === null ||
      !credentialsMatch(clientCredential, config.clientApiKey)
    ) {
      errorResponse(response, 401, 'Missing or invalid proxy API key');
      return;
    }

    try {
      if (method === 'GET' && requestUrl.pathname === '/v1/models') {
        const upstreamResponse = await fetchImplementation(
          `${upstreamBaseUrl}/models/support`,
          {
            headers: buildUpstreamHeaders(
              request.headers,
              config.upstreamApiKey,
            ),
          },
        );

        if (!upstreamResponse.ok) {
          await forwardResponse(upstreamResponse, response);
          return;
        }

        const payload = (await upstreamResponse.json()) as WrtnModelsResponse;
        jsonResponse(response, 200, toModelList(payload));
        return;
      }

      if (
        method === 'POST' &&
        requestUrl.pathname === '/v1/messages/count_tokens'
      ) {
        errorResponse(
          response,
          404,
          'Token counting is not exposed by Wrtn Router; Claude Code will estimate locally',
        );
        return;
      }

      const upstreamPath = routeUpstreamPath(method, requestUrl.pathname);
      if (upstreamPath === null) {
        errorResponse(response, 404, 'Unsupported proxy endpoint');
        return;
      }

      const body = await readRequestBody(request, maxBodyBytes);
      const requestInit: RequestInit = {
        method,
        headers: buildUpstreamHeaders(
          request.headers,
          config.upstreamApiKey,
        ),
      };
      if (body !== undefined) {
        const binaryBody = new Uint8Array(body.length);
        binaryBody.set(body);
        requestInit.body = binaryBody;
      }

      const upstreamResponse = await fetchImplementation(
        `${upstreamBaseUrl}${upstreamPath}${requestUrl.search}`,
        requestInit,
      );

      await forwardResponse(upstreamResponse, response);
    } catch (error: unknown) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }

      const message =
        error instanceof Error ? error.message : 'Unknown proxy error';
      const statusCode = message.startsWith('Request body exceeds') ? 413 : 502;
      errorResponse(response, statusCode, message);
    }
  });
};
