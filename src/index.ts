import { config as loadEnvironment } from 'dotenv';
import { createProxyServer, type ProxyConfig } from './server.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_MESSAGES_MAX_TOKENS = 16_384;
const DEFAULT_WRTN_BASE_URL = 'https://api.wrtn.ax/api/v1';

loadEnvironment({ quiet: true });

const requireEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }

  return value;
};

const parsePort = (value: string | undefined): number => {
  const port = Number(value ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PORT must be an integer between 1 and 65535`);
  }

  return port;
};

const parsePositiveInteger = (
  name: string,
  value: string | undefined,
  defaultValue: number,
): number => {
  const parsed = Number(value ?? defaultValue);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
};

const isLoopbackHost = (host: string): boolean =>
  host === '127.0.0.1' || host === '::1' || host === 'localhost';

const upstreamApiKey = requireEnvironmentVariable('WRTN_API_KEY');
const host = process.env.HOST ?? DEFAULT_HOST;
const port = parsePort(process.env.PORT);
const clientApiKey = process.env.CLIENT_API_KEY ?? upstreamApiKey;

if (!isLoopbackHost(host) && !process.env.CLIENT_API_KEY) {
  throw new Error(
    'CLIENT_API_KEY must be set when HOST is not a loopback address',
  );
}

const config: ProxyConfig = {
  clientApiKey,
  messagesMaxTokens: parsePositiveInteger(
    'WRTN_MESSAGES_MAX_TOKENS',
    process.env.WRTN_MESSAGES_MAX_TOKENS,
    DEFAULT_MESSAGES_MAX_TOKENS,
  ),
  upstreamApiKey,
  upstreamBaseUrl: process.env.WRTN_BASE_URL ?? DEFAULT_WRTN_BASE_URL,
};
const server = createProxyServer(config);
let isShuttingDown = false;

server.listen(port, host, () => {
  console.info(`Wrtn CLI proxy listening on http://${host}:${port}`);
});

const shutdown = (signal: NodeJS.Signals): void => {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.info(`Received ${signal}; shutting down`);
  server.close((error) => {
    if (error) {
      console.error(error);
      process.exitCode = 1;
    }
  });
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
