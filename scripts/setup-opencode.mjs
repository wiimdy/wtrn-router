import { spawn } from 'node:child_process';
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
} from 'jsonc-parser';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const TEMPLATE_PATH = join(PROJECT_ROOT, 'config', 'opencode.jsonc');
const DEFAULT_HEALTH_URL = 'http://127.0.0.1:8788/health';
const STARTUP_ATTEMPTS = 25;
const STARTUP_DELAY_MS = 200;
const FORMATTING_OPTIONS = { insertSpaces: true, tabSize: 2, eol: '\n' };

const pathExists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const parseJsonc = (text, label) => {
  const errors = [];
  const value = parse(text, errors, { allowTrailingComma: true });

  if (errors.length > 0) {
    const details = errors
      .map(({ error, offset }) => `${printParseErrorCode(error)} at ${offset}`)
      .join(', ');
    throw new Error(`Cannot parse ${label}: ${details}`);
  }

  return value ?? {};
};

const updateJsoncValue = (text, path, value) =>
  applyEdits(
    text,
    modify(text, path, value, { formattingOptions: FORMATTING_OPTIONS }),
  );

export const selectOpenCodeConfigPath = async (configDirectory) => {
  const jsoncPath = join(configDirectory, 'opencode.jsonc');
  if (await pathExists(jsoncPath)) return jsoncPath;

  const jsonPath = join(configDirectory, 'opencode.json');
  if (await pathExists(jsonPath)) return jsonPath;

  return jsoncPath;
};

export const mergeOpenCodeConfig = (existingText, templateText) => {
  const sourceText = existingText.trim() ? existingText : '{}\n';
  const existingConfig = parseJsonc(sourceText, 'existing OpenCode config');
  const templateConfig = parseJsonc(templateText, 'Wrtn OpenCode template');
  const wrtnProvider = templateConfig.provider?.['wrtn-chat'];

  if (!wrtnProvider) {
    throw new Error('Wrtn OpenCode template is missing provider.wrtn-chat');
  }

  let mergedText = sourceText;
  if (!existingConfig.$schema && templateConfig.$schema) {
    mergedText = updateJsoncValue(
      mergedText,
      ['$schema'],
      templateConfig.$schema,
    );
  }
  mergedText = updateJsoncValue(mergedText, ['permission'], 'allow');
  mergedText = updateJsoncValue(
    mergedText,
    ['provider', 'wrtn-chat'],
    wrtnProvider,
  );

  return mergedText.endsWith('\n') ? mergedText : `${mergedText}\n`;
};

export const installOpenCodeConfig = async ({
  configDirectory,
  templatePath = TEMPLATE_PATH,
  now = () => new Date(),
}) => {
  await mkdir(configDirectory, { recursive: true });
  const configPath = await selectOpenCodeConfigPath(configDirectory);
  const configExists = await pathExists(configPath);
  const existingText = configExists ? await readFile(configPath, 'utf8') : '{}\n';
  const templateText = await readFile(templatePath, 'utf8');
  const mergedText = mergeOpenCodeConfig(existingText, templateText);

  if (configExists && mergedText === existingText) {
    return { changed: false, configPath, backupPath: null };
  }

  let backupPath = null;
  if (configExists) {
    const timestamp = now().toISOString().replaceAll(':', '-').replaceAll('.', '-');
    backupPath = `${configPath}.backup-${timestamp}`;
    await copyFile(configPath, backupPath);
    await chmod(backupPath, 0o600);
  }

  const temporaryPath = `${configPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, mergedText, { mode: 0o600 });
  await rename(temporaryPath, configPath);
  await chmod(configPath, 0o600);

  return { changed: true, configPath, backupPath };
};

export const isProxyHealthy = async ({
  fetchImplementation = globalThis.fetch,
  healthUrl = DEFAULT_HEALTH_URL,
} = {}) => {
  try {
    const response = await fetchImplementation(healthUrl, {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;

    const body = await response.json();
    return body.status === 'ok';
  } catch {
    return false;
  }
};

const delay = (milliseconds) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));

export const ensureProxyRunning = async ({
  projectRoot = PROJECT_ROOT,
  healthCheck = isProxyHealthy,
  spawnImplementation = spawn,
  wait = delay,
  startupAttempts = STARTUP_ATTEMPTS,
} = {}) => {
  if (await healthCheck()) {
    return { started: false, pid: null };
  }

  const logPath = join(projectRoot, 'wrtn-router.log');
  const pidPath = join(projectRoot, '.wrtn-router.pid');
  const logHandle = await open(logPath, 'a');
  let child;

  try {
    child = spawnImplementation(process.execPath, [join(projectRoot, 'src', 'proxy.mjs')], {
      cwd: projectRoot,
      detached: true,
      env: process.env,
      stdio: ['ignore', logHandle.fd, logHandle.fd],
    });

    await new Promise((resolveSpawn, rejectSpawn) => {
      child.once('spawn', resolveSpawn);
      child.once('error', rejectSpawn);
    });
    child.unref();
  } finally {
    await logHandle.close();
  }

  if (!child.pid) {
    throw new Error('Proxy process started without a PID');
  }

  await writeFile(pidPath, `${child.pid}\n`, { mode: 0o600 });

  for (let attempt = 0; attempt < startupAttempts; attempt += 1) {
    if (await healthCheck()) {
      return { started: true, pid: child.pid, logPath, pidPath };
    }
    await wait(STARTUP_DELAY_MS);
  }

  try {
    child.kill('SIGTERM');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
  }
  await rm(pidPath, { force: true });
  throw new Error(`Proxy did not become healthy. Check ${logPath}`);
};

export const runSetup = async () => {
  const configRoot = process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config');
  const configResult = await installOpenCodeConfig({
    configDirectory: join(configRoot, 'opencode'),
  });
  const proxyResult = await ensureProxyRunning();

  console.info(`OpenCode config: ${configResult.configPath}`);
  if (configResult.backupPath) {
    console.info(`Previous config backup: ${configResult.backupPath}`);
  }
  console.info(
    proxyResult.started
      ? `Wrtn Router started in background (PID ${proxyResult.pid}).`
      : 'Wrtn Router is already running.',
  );
  console.info('OpenCode permissions: allow (approval prompts disabled).');
  console.info('First run only: use /connect and register provider ID wrtn-chat.');
};

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  runSetup().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Setup failed: ${message}`);
    process.exitCode = 1;
  });
}
