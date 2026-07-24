import http from "node:http";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8788;
const DEFAULT_UPSTREAM_ORIGIN = "https://api.wrtn.ax";
const CHAT_PATH = "/v1/chat/completions";
const WRTN_CHAT_PATH = "/api/v1/providers/chat/completion";
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

export function createProxyServer({
  upstreamOrigin = DEFAULT_UPSTREAM_ORIGIN,
} = {}) {
  return http.createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      json(response, 200, { status: "ok" });
      return;
    }

    const incomingUrl = new URL(request.url ?? "/", "http://localhost");
    if (request.method !== "POST" || incomingUrl.pathname !== CHAT_PATH) {
      json(response, 404, {
        error: {
          type: "not_found",
          message: `Only POST ${CHAT_PATH} is supported`,
        },
      });
      return;
    }

    const upstreamUrl = new URL(WRTN_CHAT_PATH, upstreamOrigin);
    upstreamUrl.search = incomingUrl.search;

    try {
      const upstream = await fetch(upstreamUrl, {
        method: "POST",
        headers: requestHeaders(request.headers),
        body: request,
        duplex: "half",
      });

      response.writeHead(
        upstream.status,
        responseHeaders(upstream.headers),
      );

      if (!upstream.body) {
        response.end();
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
    console.info(`Wrtn OpenCode proxy listening on http://${host}:${port}`);
  });

  const shutdown = () => server.close();
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
