import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { stopProxy } from '../scripts/stop-proxy.mjs';

test('refuses to stop a stale PID that belongs to another process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrtn-stop-stale-'));
  const pidPath = join(directory, '.wrtn-router.pid');
  const signals = [];
  await writeFile(pidPath, '12345\n');

  await assert.rejects(
    stopProxy({
      pidPath,
      expectedProxyPath: '/project/src/proxy.mjs',
      inspectProcess: async () => '/usr/bin/node /project/src/other.mjs',
      killProcess: (pid, signal) => signals.push([pid, signal]),
    }),
    /Refusing to stop PID 12345/,
  );

  assert.deepEqual(signals, [[12345, 0]]);
  assert.equal(await readFile(pidPath, 'utf8'), '12345\n');
});

test('stops the managed proxy after verifying its command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wrtn-stop-managed-'));
  const pidPath = join(directory, '.wrtn-router.pid');
  const proxyPath = '/project/src/proxy.mjs';
  const signals = [];
  await writeFile(pidPath, '23456\n');

  await stopProxy({
    pidPath,
    expectedProxyPath: proxyPath,
    inspectProcess: async () => `/usr/bin/node ${proxyPath}`,
    killProcess: (pid, signal) => signals.push([pid, signal]),
  });

  assert.deepEqual(signals, [
    [23456, 0],
    [23456, 'SIGTERM'],
  ]);
  await assert.rejects(readFile(pidPath), { code: 'ENOENT' });
});
