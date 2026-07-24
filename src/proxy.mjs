import http from "node:http";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const DEFAULT_UPSTREAM_ORIGIN = "https://api.wrtn.ax";
const ROUTES = new Map([
  ["/v1/chat/completions", "/api/v1/providers/chat/completion"],
  ["/v1/responses", "/api/v1/providers/responses"],
  ["/v1/messages", "/api/v1/providers/messages"],
]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const OMITTED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP_HEADERS,
  // Node fetch decodes compressed bodies before they are written downstream.
  "content-encoding",
]);

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
}

function requestHeaders(incoming) {
  const headers = new Headers();

  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  const authorization = headers.get("authorization");
  if (!headers.has("x-api-key") && authorization?.toLowerCase().startsWith("bearer ")) {
    headers.set("x-api-key", authorization.slice(7));
  }

  return headers;
}

function responseHeaders(upstream) {
  const headers = {};

  for (const [name, value] of upstream) {
    if (!OMITTED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }

  return headers;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function stringifyValue(value) {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function inputMessage(role, text) {
  return {
    type: "message",
    role,
    content: [{ type: "input_text", text }],
  };
}

function flattenResponseToolRoundtrip(input) {
  if (!Array.isArray(input)) {
    return input;
  }

  const result = [];
  const calls = new Map();
  const callOrder = [];
  const consumedCalls = new Set();

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

    if (itemType === "reasoning") {
      continue;
    }

    if (itemType === "function_call" || itemType === "custom_tool_call") {
      const callId = item.call_id ?? originalId;
      if (typeof callId === "string") {
        calls.set(callId, item);
        callOrder.push(callId);
      }
      continue;
    }

    if (
      itemType === "function_call_output" ||
      itemType === "custom_tool_call_output"
    ) {
      const callId = item.call_id ?? originalId;
      const call = typeof callId === "string" ? calls.get(callId) : undefined;
      if (typeof callId === "string") {
        consumedCalls.add(callId);
      }
      result.push(
        inputMessage(
          "user",
          `[Tool execution result]\ntool: ${call?.name ?? item.name ?? "unknown"}\narguments: ${stringifyValue(call?.arguments ?? {})}\ncall_id: ${callId ?? "unknown"}\noutput:\n${stringifyValue(item.output ?? "")}\n\nContinue the original task using this tool result. Do not repeat the same tool call unless it is actually necessary.`,
        ),
      );
      continue;
    }

    result.push(item);
  }

  for (const callId of callOrder) {
    if (consumedCalls.has(callId)) {
      continue;
    }
    const call = calls.get(callId);
    result.push(
      inputMessage(
        "assistant",
        `[Previous assistant tool request]\ntool: ${call?.name ?? "unknown"}\narguments: ${stringifyValue(call?.arguments ?? {})}\ncall_id: ${callId}`,
      ),
    );
  }

  return result;
}

function messageContentText(value) {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value
      .map((item) =>
        isRecord(item) && typeof item.text === "string"
          ? item.text
          : stringifyValue(item),
      )
      .join("\n");
  }

  return stringifyValue(value);
}

function flattenMessageToolRoundtrip(messages) {
  if (!Array.isArray(messages)) {
    return messages;
  }

  const toolNames = new Map();

  return messages.map((rawMessage) => {
    if (!isRecord(rawMessage) || !Array.isArray(rawMessage.content)) {
      return rawMessage;
    }

    const role = rawMessage.role;
    const content = rawMessage.content.map((rawBlock) => {
      if (!isRecord(rawBlock)) {
        return rawBlock;
      }

      if (role === "assistant" && rawBlock.type === "tool_use") {
        const callId =
          typeof rawBlock.id === "string" ? rawBlock.id : "unknown";
        const toolName =
          typeof rawBlock.name === "string" ? rawBlock.name : "unknown";
        toolNames.set(callId, toolName);

        return {
          type: "text",
          text:
            `[Previous assistant tool request]\n` +
            `tool: ${toolName}\n` +
            `arguments: ${stringifyValue(rawBlock.input ?? {})}\n` +
            `call_id: ${callId}`,
        };
      }

      if (role === "user" && rawBlock.type === "tool_result") {
        const callId =
          typeof rawBlock.tool_use_id === "string"
            ? rawBlock.tool_use_id
            : "unknown";
        const toolName = toolNames.get(callId) ?? "unknown";
        const errorLabel = rawBlock.is_error === true ? "\nstatus: error" : "";

        return {
          type: "text",
          text:
            `[Tool execution result]\n` +
            `tool: ${toolName}\n` +
            `call_id: ${callId}${errorLabel}\n` +
            `output:\n${messageContentText(rawBlock.content ?? "")}\n\n` +
            `Continue the original task using this tool result. ` +
            `Do not repeat the same tool call unless it is actually necessary.`,
        };
      }

      return rawBlock;
    });

    return { ...rawMessage, content };
  });
}

async function responsesBody(request) {
  const body = await readBody(request);

  try {
    const payload = JSON.parse(body.toString("utf8"));
    const streaming = payload.stream === true;
    // Wrtn's native Responses stream currently repeats response.created and
    // never completes. Buffer upstream and synthesize a standards-compatible
    // SSE sequence below.
    payload.stream = false;
    // Codex adds this private field. It is not part of Wrtn's Responses API.
    delete payload.client_metadata;
    payload.input = flattenResponseToolRoundtrip(payload.input);
    // The proxy returns synthetic response IDs, while Codex already sends the
    // complete thread history in input.
    delete payload.previous_response_id;
    return {
      body: Buffer.from(JSON.stringify(payload)),
      streaming,
    };
  } catch {
    return { body, streaming: false };
  }
}

async function messagesBody(request) {
  const body = await readBody(request);

  try {
    const payload = JSON.parse(body.toString("utf8"));
    payload.messages = flattenMessageToolRoundtrip(payload.messages);
    return Buffer.from(JSON.stringify(payload));
  } catch {
    return body;
  }
}

function writeSse(response, event, data) {
  if (event) response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseItemId(type) {
  const prefix = type === "message" ? "msg" : type === "function_call" ? "fc" : "item";
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

async function forwardBufferedResponses(upstream, response) {
  let payload;
  try {
    payload = await upstream.json();
  } catch {
    json(response, 502, {
      error: {
        type: "upstream_error",
        message: "Wrtn returned an invalid Responses payload",
      },
    });
    return;
  }

  if (!upstream.ok || !isRecord(payload)) {
    response.writeHead(upstream.status, responseHeaders(upstream.headers));
    response.end(JSON.stringify(payload));
    return;
  }

  const responseId =
    typeof payload.id === "string"
      ? payload.id
      : `resp_${randomUUID().replaceAll("-", "")}`;
  const output = (Array.isArray(payload.output) ? payload.output : [])
    .filter(isRecord)
    .map((item) => ({
      ...item,
      id:
        typeof item.id === "string"
          ? item.id
          : responseItemId(item.type),
      status: typeof item.status === "string" ? item.status : "completed",
    }));
  const completedResponse = {
    ...payload,
    id: responseId,
    object: typeof payload.object === "string" ? payload.object : "response",
    status: "completed",
    output,
  };
  const startedResponse = {
    ...completedResponse,
    status: "in_progress",
    output: [],
  };
  const headers = responseHeaders(upstream.headers);
  headers["cache-control"] = "no-cache";
  headers["content-type"] = "text/event-stream; charset=utf-8";
  headers["x-accel-buffering"] = "no";
  response.writeHead(200, headers);

  let sequenceNumber = 0;
  const emit = (event, data) => {
    writeSse(response, event, {
      type: event,
      sequence_number: sequenceNumber++,
      ...data,
    });
  };

  emit("response.created", { response: startedResponse });
  emit("response.in_progress", { response: startedResponse });

  output.forEach((item, outputIndex) => {
    emit("response.output_item.added", {
      response_id: responseId,
      output_index: outputIndex,
      item: { ...item, status: "in_progress" },
    });

    if (item.type === "message" && Array.isArray(item.content)) {
      item.content.filter(isRecord).forEach((part, contentIndex) => {
        if (part.type !== "output_text" || typeof part.text !== "string") {
          return;
        }

        const emptyPart = { ...part, text: "" };
        emit("response.content_part.added", {
          response_id: responseId,
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part: emptyPart,
        });
        if (part.text) {
          emit("response.output_text.delta", {
            response_id: responseId,
            item_id: item.id,
            output_index: outputIndex,
            content_index: contentIndex,
            delta: part.text,
            logprobs: [],
          });
        }
        emit("response.output_text.done", {
          response_id: responseId,
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          text: part.text,
          logprobs: [],
        });
        emit("response.content_part.done", {
          response_id: responseId,
          item_id: item.id,
          output_index: outputIndex,
          content_index: contentIndex,
          part,
        });
      });
    }

    if (item.type === "function_call" && typeof item.arguments === "string") {
      if (item.arguments) {
        emit("response.function_call_arguments.delta", {
          response_id: responseId,
          item_id: item.id,
          output_index: outputIndex,
          delta: item.arguments,
        });
      }
      emit("response.function_call_arguments.done", {
        response_id: responseId,
        item_id: item.id,
        output_index: outputIndex,
        arguments: item.arguments,
      });
    }

    emit("response.output_item.done", {
      response_id: responseId,
      output_index: outputIndex,
      item,
    });
  });

  emit("response.completed", { response: completedResponse });
  response.end();
}

async function forwardMessagesStream(upstream, response) {
  const decoder = new TextDecoder();
  const started = new Set();
  let buffer = "";

  const handleEvent = (rawEvent) => {
    const normalized = rawEvent.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const event = lines
      .find((line) => line.startsWith("event:"))
      ?.slice("event:".length)
      .trim();
    const dataText = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");

    if (!event || !dataText) {
      response.write(`${rawEvent}\n\n`);
      return;
    }

    let data;
    try {
      data = JSON.parse(dataText);
    } catch {
      response.write(`${rawEvent}\n\n`);
      return;
    }

    if (event === "message_start") started.clear();
    if (event === "content_block_start") started.add(data.index);

    if (event === "content_block_delta" && !started.has(data.index)) {
      let contentBlock;
      if (data.delta?.type === "text_delta") {
        contentBlock = { type: "text", text: "" };
      } else if (data.delta?.type === "thinking_delta") {
        contentBlock = { type: "thinking", thinking: "" };
      }

      if (contentBlock) {
        writeSse(response, "content_block_start", {
          type: "content_block_start",
          index: data.index,
          content_block: contentBlock,
        });
        started.add(data.index);
      }
    }

    if (
      event === "content_block_stop" &&
      !started.has(data.index) &&
      started.size === 1
    ) {
      data.index = started.values().next().value;
    }

    writeSse(response, event, data);
    if (event === "content_block_stop") started.delete(data.index);
  };

  for await (const chunk of upstream.body) {
    buffer += decoder.decode(chunk, { stream: true });

    let boundary = buffer.match(/\r?\n\r?\n/);
    while (boundary?.index !== undefined) {
      handleEvent(buffer.slice(0, boundary.index));
      buffer = buffer.slice(boundary.index + boundary[0].length);
      boundary = buffer.match(/\r?\n\r?\n/);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) handleEvent(buffer);
  response.end();
}

export function createProxyServer({
  upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN,
} = {}) {
  return http.createServer(async (request, response) => {
    const incomingUrl = new URL(request.url ?? "/", "http://localhost");

    if (request.method === "GET" && incomingUrl.pathname === "/health") {
      json(response, 200, { status: "ok" });
      return;
    }

    // Claude Agent SDK probes custom API origins before its first Messages call.
    if (request.method === "HEAD" && incomingUrl.pathname === "/api/hello") {
      response.writeHead(200);
      response.end();
      return;
    }

    const upstreamPath = ROUTES.get(incomingUrl.pathname);
    if (request.method !== "POST" || !upstreamPath) {
      json(response, 404, {
        error: {
          type: "not_found",
          message:
            "Supported paths: POST /v1/chat/completions, " +
            "POST /v1/responses, POST /v1/messages",
        },
      });
      return;
    }

    const upstreamUrl = new URL(upstreamPath, upstreamOrigin);
    upstreamUrl.search = incomingUrl.search;

    try {
      let body = request;
      let responsesStreaming = false;
      if (incomingUrl.pathname === "/v1/responses") {
        const prepared = await responsesBody(request);
        body = prepared.body;
        responsesStreaming = prepared.streaming;
      } else if (incomingUrl.pathname === "/v1/messages") {
        body = await messagesBody(request);
      }
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: requestHeaders(request.headers),
        body,
        duplex: "half",
      });

      if (!upstream.body) {
        response.writeHead(upstream.status, responseHeaders(upstream.headers));
        response.end();
        return;
      }

      if (incomingUrl.pathname === "/v1/responses" && responsesStreaming) {
        await forwardBufferedResponses(upstream, response);
        return;
      }

      response.writeHead(upstream.status, responseHeaders(upstream.headers));

      if (
        incomingUrl.pathname === "/v1/messages" &&
        upstream.headers.get("content-type")?.includes("text/event-stream")
      ) {
        await forwardMessagesStream(upstream, response);
        return;
      }

      for await (const chunk of upstream.body) {
        response.write(chunk);
      }
      response.end();
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }

      json(response, 502, {
        error: {
          type: "upstream_error",
          message: "Wrtn request failed",
        },
      });
    }
  });
}

function parsePort(value) {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const host = process.env.HOST ?? DEFAULT_HOST;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("HOST must be a loopback address");
  }
  const port = parsePort(process.env.PORT);
  const upstreamOrigin =
    process.env.WRTN_UPSTREAM_ORIGIN ?? DEFAULT_UPSTREAM_ORIGIN;
  const server = createProxyServer({ upstreamOrigin });

  server.listen(port, host, () => {
    console.info(`Wrtn Router proxy listening on http://${host}:${port}`);
  });

  const shutdown = () => server.close();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
