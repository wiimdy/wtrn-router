import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { parse } from 'jsonc-parser';

import {
  ensureProxyRunning,
  installOpenCodeConfig,
  mergeOpenCodeConfig,
  selectOpenCodeConfigPath,
} from '../scripts/setup-opencode.mjs';

const TEMPLATE = `{
  "$schema": "https://opencode.ai/config.json",
  "permission": "allow",
  "provider": {
    "wrtn-chat": {
      "name": "Wrtn Router",
      "options": { "baseURL": "http://127.0.0.1:8788/v1" }
    }
  }
}\n`;

test('merges Wrtn config without discarding existing JSONC settings', () => {
  const existing = `{
    // Keep the user's existing provider and URL.
    "theme": "system",
    "provider": {
      "other": { "baseURL": "https://example.com/v1" },
    },
    "permission": { "bash": "ask" },
  }\n`;

  const merged = parse(mergeOpenCodeConfig(existing, TEMPLATE));

  assert.equal(merged.theme, 'system');
  assert.equal(merged.provider.other.baseURL, 'https://example.com/v1');
  assert.equal(merged.provider['wrtn-chat'].name, 'Wrtn Router');
  assert.equal(merged.permission, 'allow');
});

test('installs GPT-5.6 Sol model definition from the OpenCode template', async () => {
  const templateText = await readFile('config/opencode.jsonc', 'utf8');
  const merged = parse(mergeOpenCodeConfig('{}\n', templateText));
  const model = merged.provider['wrtn-chat'].models['gpt-5.6-sol'];

  assert.equal(model.provider.npm, '@ai-sdk/openai');
  assert.equal(model.name, 'GPT-5.6 Sol (Wrtn)');
  assert.equal(model.limit.context, 1050000);
  assert.equal(model.variants.max.reasoningEffort, 'max');
});

test('selects an existing JSONC config, then JSON, then a new JSONC path', async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'wrtn-config-path-'));
  const jsonPath = join(configDirectory, 'opencode.json');
  const jsoncPath = join(configDirectory, 'opencode.jsonc');

  assert.equal(await selectOpenCodeConfigPath(configDirectory), jsoncPath);
  await writeFile(jsonPath, '{}\n');
  assert.equal(await selectOpenCodeConfigPath(configDirectory), jsonPath);
  await writeFile(jsoncPath, '{}\n');
  assert.equal(await selectOpenCodeConfigPath(configDirectory), jsoncPath);
});

test('backs up, secures, and idempotently updates an existing config', async () => {
  const configDirectory = await mkdtemp(join(tmpdir(), 'wrtn-config-install-'));
  const templatePath = join(configDirectory, 'template.jsonc');
  const configPath = join(configDirectory, 'opencode.jsonc');
  const original = '{ "theme": "system" }\n';
  await writeFile(templatePath, TEMPLATE);
  await writeFile(configPath, original);

  const firstResult = await installOpenCodeConfig({
    configDirectory,
    templatePath,
    now: () => new Date('2026-08-07T12:00:00.000Z'),
  });
  const backupText = await readFile(firstResult.backupPath, 'utf8');
  const installedText = await readFile(configPath, 'utf8');
  const installedMode = (await stat(configPath)).mode & 0o777;

  assert.equal(firstResult.changed, true);
  assert.equal(backupText, original);
  assert.equal(parse(installedText).permission, 'allow');
  assert.equal(installedMode, 0o600);

  const secondResult = await installOpenCodeConfig({
    configDirectory,
    templatePath,
  });
  assert.equal(secondResult.changed, false);
  assert.equal(secondResult.backupPath, null);
  assert.equal(await readFile(configPath, 'utf8'), installedText);
});

test('terminates a proxy that never becomes healthy', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'wrtn-proxy-timeout-'));
  const child = new EventEmitter();
  let killedWith = null;
  child.pid = 43210;
  child.unref = () => {};
  child.kill = (signal) => {
    killedWith = signal;
    return true;
  };

  const startPromise = ensureProxyRunning({
    projectRoot,
    healthCheck: async () => false,
    spawnImplementation: () => {
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    wait: async () => {},
    startupAttempts: 1,
  });

  await assert.rejects(startPromise, /Proxy did not become healthy/);
  assert.equal(killedWith, 'SIGTERM');
  await assert.rejects(readFile(join(projectRoot, '.wrtn-router.pid')), {
    code: 'ENOENT',
  });
});
