import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { IsObject, IsString } from 'typebox';
import { trash } from './fixtures/translation-integration.js';

test('Pi resource loader registers the source extension with isolated settings and no network', async (t) => {
  // The test runner starts at the workspace root; load source, not emitted test output.
  const extensionPath = resolve('index.ts');
  const dir = await mkdtemp(join(tmpdir(), 'pi-shout-loader-'));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await trash(dir);
  });
  process.env.PI_CODING_AGENT_DIR = dir;
  const fetch = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Extension registration must not access the network');
  });
  const { DefaultResourceLoader, SettingsManager } = await import('@earendil-works/pi-coding-agent');
  const loader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager: SettingsManager.inMemory(),
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: '',
    appendSystemPrompt: [],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const extension = result.extensions[0];
  assert.ok(extension);
  assert.equal(extension.resolvedPath, extensionPath);
  assert.deepEqual([...extension.tools.keys()], ['transcribe_file']);
  const tool = extension.tools.get('transcribe_file');
  assert.ok(tool);
  const schema = tool.definition.parameters;
  assert.ok(IsObject(schema));
  assert.ok(IsString(schema.properties.path));
  assert.ok(IsString(schema.properties.targetLanguage));
  assert.deepEqual(schema.required, ['path']);
  assert.deepEqual([...extension.shortcuts.keys()].sort(), ['ctrl+alt+t', 'ctrl+alt+z']);
  for (const name of ['voice-settings', 'transcribe', 'voice-recover']) {
    assert.ok(extension.commands.has(name), `Missing command: ${name}`);
  }
  assert.equal(fetch.mock.callCount(), 0);
});
