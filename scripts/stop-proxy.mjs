import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const PID_PATH = join(PROJECT_ROOT, '.wrtn-router.pid');
const PROXY_PATH = join(PROJECT_ROOT, 'src', 'proxy.mjs');
const execFileAsync = promisify(execFile);

const readProcessCommand = async (pid) => {
  const { stdout } = await execFileAsync('ps', [
    '-p',
    String(pid),
    '-o',
    'command=',
  ]);
  return stdout.trim();
};

export const stopProxy = async ({
  pidPath = PID_PATH,
  expectedProxyPath = PROXY_PATH,
  inspectProcess = readProcessCommand,
  killProcess = process.kill,
} = {}) => {
  let pidText;
  try {
    pidText = await readFile(pidPath, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      console.info('No managed Wrtn Router background process was found.');
      return;
    }
    throw error;
  }

  const pid = Number(pidText.trim());
  if (!Number.isInteger(pid) || pid < 1) {
    throw new Error(`Invalid PID in ${pidPath}`);
  }

  try {
    killProcess(pid, 0);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      throw error;
    }
    console.info(`Wrtn Router PID ${pid} was no longer running.`);
    await rm(pidPath, { force: true });
    return;
  }

  const command = await inspectProcess(pid);
  if (!command.includes(expectedProxyPath)) {
    throw new Error(
      `Refusing to stop PID ${pid}: process is not ${expectedProxyPath}`,
    );
  }

  killProcess(pid, 'SIGTERM');
  console.info(`Stopped Wrtn Router (PID ${pid}).`);
  await rm(pidPath, { force: true });
};

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  stopProxy().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Stop failed: ${message}`);
    process.exitCode = 1;
  });
}
