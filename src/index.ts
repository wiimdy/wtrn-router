import { createProxyServer, type ProxyConfig } from './server.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const DEFAULT_WRTN_BASE_URL = 'https://api.wrtn.ax/api/v1';

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
  upstreamApiKey,
  upstreamBaseUrl: process.env.WRTN_BASE_URL ?? DEFAULT_WRTN_BASE_URL,
};
const server = createProxyServer(config);

server.listen(port, host, () => {
  console.info(`Wrtn CLI proxy listening on http://${host}:${port}`);
});

const shutdown = (signal: NodeJS.Signals): void => {
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
