import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;
const DEFAULT_MESSAGES_MAX_TOKENS = 16_384;
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
  messagesMaxTokens?: number;
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

interface ResponsesRequestPayload {
  input?: unknown;
  stream?: unknown;
  tools?: unknown;
  [key: string]: unknown;
}

interface ResponsesApiResponse {
  id?: unknown;
  output?: unknown;
  status?: unknown;
  [key: string]: unknown;
}

interface MessagesApiResponse {
  content?: unknown;
  id?: unknown;
  model?: unknown;
  role?: unknown;
  stop_reason?: unknown;
  type?: unknown;
  usage?: unknown;
  [key: string]: unknown;
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

const errorMessage = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return 'Unknown proxy error';
  }

  const causeMessage =
    error.cause instanceof Error ? `: ${error.cause.message}` : '';
  return `${error.message}${causeMessage}`;
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
    // Codex's model manager uses a backend-specific `models` envelope. An
    // empty list makes it use its built-in fallback metadata while `data`
    // remains available for OpenAI-compatible clients and Claude discovery.
    models: [],
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const stringifyValue = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value);

const messageItem = (
  role: 'assistant' | 'user',
  text: string,
): Record<string, unknown> => ({
  type: 'message',
  role,
  content: [{ type: 'input_text', text }],
});

const flattenToolRoundtrip = (input: unknown): unknown => {
  if (!Array.isArray(input)) {
    return input;
  }

  const result: unknown[] = [];
  const functionCalls = new Map<string, Record<string, unknown>>();
  const functionCallOrder: string[] = [];
  const consumedCallIds = new Set<string>();

  for (const rawItem of input) {
    if (!isRecord(rawItem)) {
      result.push(rawItem);
      continue;
    }

    const item = { ...rawItem };
    const itemType = item.type;
    const originalId = item.id;
    delete item.id;
    delete item.status;
    delete item.internal_chat_message_metadata_passthrough;

    if (itemType === 'reasoning') {
      continue;
    }

    if (itemType === 'function_call' || itemType === 'custom_tool_call') {
      const callId =
        typeof item.call_id === 'string'
          ? item.call_id
          : typeof originalId === 'string'
            ? originalId
            : '';
      functionCalls.set(callId, item);
      functionCallOrder.push(callId);
      continue;
    }

    if (
      itemType === 'function_call_output' ||
      itemType === 'custom_tool_call_output'
    ) {
      const callId = typeof item.call_id === 'string' ? item.call_id : '';
      const call = functionCalls.get(callId);
      consumedCallIds.add(callId);
      const toolName =
        typeof call?.name === 'string'
          ? call.name
          : typeof item.name === 'string'
            ? item.name
            : 'unknown';
      const argumentsValue = stringifyValue(call?.arguments ?? {});
      const output = stringifyValue(item.output ?? '');

      result.push(
        messageItem(
          'user',
          `[Tool execution result]\ntool: ${toolName}\narguments: ${argumentsValue}\ncall_id: ${callId || 'unknown'}\noutput:\n${output}\n\nContinue the original task using this tool result. Do not repeat the same tool call unless it is actually necessary.`,
        ),
      );
      continue;
    }

    result.push(item);
  }

  for (const callId of functionCallOrder) {
    if (consumedCallIds.has(callId)) {
      continue;
    }

    const call = functionCalls.get(callId);
    const toolName =
      typeof call?.name === 'string' ? call.name : 'unknown';
    const argumentsValue = stringifyValue(call?.arguments ?? {});
    result.push(
      messageItem(
        'assistant',
        `[Previous assistant tool request]\ntool: ${toolName}\narguments: ${argumentsValue}\ncall_id: ${callId || 'unknown'}`,
      ),
    );
  }

  return result;
};

const prepareResponsesPayload = (
  payload: ResponsesRequestPayload,
): ResponsesRequestPayload => {
  const prepared: ResponsesRequestPayload = {
    ...payload,
    stream: false,
    input: flattenToolRoundtrip(payload.input),
  };

  delete prepared.stream_options;
  delete prepared.client_metadata;
  delete prepared.prompt_cache_key;
  delete prepared.previous_response_id;
  return prepared;
};

const removeDescriptions = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(removeDescriptions);
  }

  if (!isRecord(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'description')
      .map(([key, child]) => [key, removeDescriptions(child)]),
  );
};

const responseRequestCandidates = (
  payload: ResponsesRequestPayload,
): ResponsesRequestPayload[] => {
  const prepared = prepareResponsesPayload(payload);
  if (!Array.isArray(prepared.tools)) {
    return [prepared];
  }

  const withoutDescriptions = {
    ...prepared,
    tools: removeDescriptions(prepared.tools),
  };
  const withoutNamespaces = {
    ...withoutDescriptions,
    tools: prepared.tools.filter(
      (tool) => !isRecord(tool) || tool.type !== 'namespace',
    ),
  };

  return [prepared, withoutDescriptions, withoutNamespaces];
};

const writeResponsesEvent = (
  response: ServerResponse,
  type: string,
  payload: Record<string, unknown>,
  sequenceNumber: number,
): void => {
  response.write(`event: ${type}\n`);
  response.write(
    `data: ${JSON.stringify({ type, sequence_number: sequenceNumber, ...payload })}\n\n`,
  );
};

const createResponseId = (): string =>
  `resp_${randomUUID().replaceAll('-', '')}`;

const createOutputItemId = (type: unknown): string => {
  const prefix =
    type === 'message' ? 'msg' : type === 'function_call' ? 'fc' : 'item';
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
};

const streamBufferedResponsesApiResponse = (
  upstreamResponse: Response,
  payload: ResponsesApiResponse,
  response: ServerResponse,
): void => {
  copyUpstreamHeaders(upstreamResponse.headers, response);
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('x-accel-buffering', 'no');
  response.writeHead(200);

  let sequenceNumber = 0;
  const emit = (type: string, eventPayload: Record<string, unknown>): void => {
    writeResponsesEvent(response, type, eventPayload, sequenceNumber);
    sequenceNumber += 1;
  };

  const responseId =
    typeof payload.id === 'string' ? payload.id : createResponseId();
  const output: Record<string, unknown>[] = (Array.isArray(payload.output)
    ? payload.output.filter(isRecord)
    : []
  ).map(
    (item): Record<string, unknown> => ({
      ...item,
      id:
        typeof item.id === 'string'
          ? item.id
          : createOutputItemId(item.type),
      status: typeof item.status === 'string' ? item.status : 'completed',
    }),
  );
  const completedResponse = {
    ...payload,
    id: responseId,
    object: typeof payload.object === 'string' ? payload.object : 'response',
    status: 'completed',
    output,
  };
  const startedResponse = {
    ...completedResponse,
    status: 'in_progress',
    output: [],
  };

  emit('response.created', { response: startedResponse });
  emit('response.in_progress', { response: startedResponse });

  output.forEach((item, outputIndex) => {
    const itemId = item.id;
    emit('response.output_item.added', {
      response_id: responseId,
      output_index: outputIndex,
      item: { ...item, status: 'in_progress' },
    });

    if (item.type === 'message' && Array.isArray(item.content)) {
      item.content.filter(isRecord).forEach((part, contentIndex) => {
        if (part.type !== 'output_text' || typeof part.text !== 'string') {
          return;
        }

        const emptyPart = { ...part, text: '' };
        emit('response.content_part.added', {
          response_id: responseId,
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          part: emptyPart,
        });
        if (part.text.length > 0) {
          emit('response.output_text.delta', {
            response_id: responseId,
            item_id: itemId,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text,
            logprobs: [],
          });
        }
        emit('response.output_text.done', {
          response_id: responseId,
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          text: part.text,
          logprobs: [],
        });
        emit('response.content_part.done', {
          response_id: responseId,
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      });
    }

    if (item.type === 'function_call' && typeof item.arguments === 'string') {
      if (item.arguments.length > 0) {
        emit('response.function_call_arguments.delta', {
          response_id: responseId,
          item_id: itemId,
          output_index: outputIndex,
          delta: item.arguments,
        });
      }
      emit('response.function_call_arguments.done', {
        response_id: responseId,
        item_id: itemId,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    }

    emit('response.output_item.done', {
      response_id: responseId,
      output_index: outputIndex,
      item,
    });
  });

  emit('response.completed', { response: completedResponse });
  response.end();
};

const writeMessagesEvent = (
  response: ServerResponse,
  type: string,
  payload: Record<string, unknown>,
): void => {
  response.write(`event: ${type}\n`);
  response.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
};

const streamBufferedMessagesApiResponse = (
  upstreamResponse: Response,
  payload: MessagesApiResponse,
  response: ServerResponse,
): void => {
  copyUpstreamHeaders(upstreamResponse.headers, response);
  response.setHeader('cache-control', 'no-cache');
  response.setHeader('content-type', 'text/event-stream; charset=utf-8');
  response.setHeader('x-accel-buffering', 'no');
  response.writeHead(200);

  const messageId =
    typeof payload.id === 'string'
      ? payload.id
      : `msg_${randomUUID().replaceAll('-', '')}`;
  const content = Array.isArray(payload.content)
    ? payload.content.filter(isRecord)
    : [];
  const usage = isRecord(payload.usage) ? payload.usage : {};
  const inputTokens =
    typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const outputTokens =
    typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;

  writeMessagesEvent(response, 'message_start', {
    message: {
      id: messageId,
      type: 'message',
      role: typeof payload.role === 'string' ? payload.role : 'assistant',
      model: typeof payload.model === 'string' ? payload.model : 'unknown',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        ...usage,
        input_tokens: inputTokens,
        output_tokens: 0,
      },
    },
  });

  content.forEach((block, index) => {
    if (block.type === 'text') {
      const text = typeof block.text === 'string' ? block.text : '';
      writeMessagesEvent(response, 'content_block_start', {
        index,
        content_block: { type: 'text', text: '' },
      });
      if (text.length > 0) {
        writeMessagesEvent(response, 'content_block_delta', {
          index,
          delta: { type: 'text_delta', text },
        });
      }
      writeMessagesEvent(response, 'content_block_stop', { index });
      return;
    }

    if (block.type === 'tool_use') {
      const toolId =
        typeof block.id === 'string'
          ? block.id
          : `toolu_${randomUUID().replaceAll('-', '')}`;
      writeMessagesEvent(response, 'content_block_start', {
        index,
        content_block: {
          type: 'tool_use',
          id: toolId,
          name: typeof block.name === 'string' ? block.name : 'unknown',
          input: {},
        },
      });
      writeMessagesEvent(response, 'content_block_delta', {
        index,
        delta: {
          type: 'input_json_delta',
          partial_json: JSON.stringify(block.input ?? {}),
        },
      });
      writeMessagesEvent(response, 'content_block_stop', { index });
    }
  });

  writeMessagesEvent(response, 'message_delta', {
    delta: {
      stop_reason:
        typeof payload.stop_reason === 'string'
          ? payload.stop_reason
          : 'end_turn',
      stop_sequence: null,
    },
    usage: { output_tokens: outputTokens },
  });
  writeMessagesEvent(response, 'message_stop', {});
  response.end();
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
  const messagesMaxTokens =
    config.messagesMaxTokens ?? DEFAULT_MESSAGES_MAX_TOKENS;

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
      let upstreamBody = body;
      let adaptResponsesStream = false;
      let adaptMessagesStream = false;
      let responsesPayloadCandidates: ResponsesRequestPayload[] | undefined;

      if (
        requestUrl.pathname === '/v1/responses' &&
        body !== undefined &&
        request.headers['content-encoding'] === undefined
      ) {
        try {
          const payload = JSON.parse(body.toString('utf8')) as unknown;
          if (isRecord(payload)) {
            adaptResponsesStream = payload.stream === true;
            responsesPayloadCandidates = responseRequestCandidates(payload);
            upstreamBody = Buffer.from(
              JSON.stringify(responsesPayloadCandidates[0]),
            );
          }
        } catch {
          // Forward malformed or non-JSON input unchanged so Wrtn returns the
          // canonical validation error.
        }
      }

      if (
        requestUrl.pathname === '/v1/messages' &&
        body !== undefined &&
        request.headers['content-encoding'] === undefined
      ) {
        try {
          const payload = JSON.parse(body.toString('utf8')) as unknown;
          if (isRecord(payload)) {
            adaptMessagesStream = payload.stream === true;
            const requestedMaxTokens =
              typeof payload.max_tokens === 'number'
                ? payload.max_tokens
                : messagesMaxTokens;
            upstreamBody = Buffer.from(
              JSON.stringify({
                ...payload,
                max_tokens: Math.min(requestedMaxTokens, messagesMaxTokens),
                stream: adaptMessagesStream ? false : payload.stream,
              }),
            );
          }
        } catch {
          // Preserve malformed or non-JSON input for the upstream validator.
        }
      }

      const requestInit: RequestInit = {
        method,
        headers: buildUpstreamHeaders(
          request.headers,
          config.upstreamApiKey,
        ),
      };
      if (upstreamBody !== undefined) {
        const binaryBody = new Uint8Array(upstreamBody.length);
        binaryBody.set(upstreamBody);
        requestInit.body = binaryBody;
      }

      const upstreamUrl =
        `${upstreamBaseUrl}${upstreamPath}${requestUrl.search}`;
      let upstreamResponse = await fetchImplementation(upstreamUrl, requestInit);

      if (
        upstreamResponse.status === 413 &&
        responsesPayloadCandidates !== undefined
      ) {
        for (
          let candidateIndex = 1;
          candidateIndex < responsesPayloadCandidates.length;
          candidateIndex += 1
        ) {
          const candidate = responsesPayloadCandidates[candidateIndex];
          console.warn(
            `Wrtn rejected Responses request size; retrying compatibility payload ${candidateIndex + 1}/${responsesPayloadCandidates.length}`,
          );
          const candidateBytes = Buffer.from(JSON.stringify(candidate));
          const candidateBody = new Uint8Array(candidateBytes.length);
          candidateBody.set(candidateBytes);
          upstreamResponse = await fetchImplementation(upstreamUrl, {
            ...requestInit,
            body: candidateBody,
          });
          if (upstreamResponse.status !== 413) {
            break;
          }
        }
      }

      if (adaptResponsesStream && upstreamResponse.ok) {
        const rawResponse = await upstreamResponse.text();
        try {
          const payload = JSON.parse(rawResponse) as unknown;
          if (isRecord(payload)) {
            streamBufferedResponsesApiResponse(
              upstreamResponse,
              payload,
              response,
            );
            return;
          }
        } catch {
          // Fall through and preserve the unexpected upstream response.
        }

        await forwardResponse(
          new Response(rawResponse, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: upstreamResponse.headers,
          }),
          response,
        );
        return;
      }

      if (adaptMessagesStream && upstreamResponse.ok) {
        const rawResponse = await upstreamResponse.text();
        try {
          const payload = JSON.parse(rawResponse) as unknown;
          if (isRecord(payload)) {
            streamBufferedMessagesApiResponse(
              upstreamResponse,
              payload,
              response,
            );
            return;
          }
        } catch {
          // Fall through and preserve the unexpected upstream response.
        }

        await forwardResponse(
          new Response(rawResponse, {
            status: upstreamResponse.status,
            statusText: upstreamResponse.statusText,
            headers: upstreamResponse.headers,
          }),
          response,
        );
        return;
      }

      await forwardResponse(upstreamResponse, response);
    } catch (error: unknown) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }

      const message = errorMessage(error);
      console.error(`${method} ${requestUrl.pathname} failed: ${message}`);
      const statusCode = message.startsWith('Request body exceeds') ? 413 : 502;
      errorResponse(response, statusCode, message);
    }
  });
};
