// Isolated process: module mocks intercept only hardware and the settings UI boundary.
import assert from 'node:assert/strict';
import { mock } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { createPiVoiceRuntime, type PiVoiceRuntime } from '../../src/runtime.js';
import { registerFileTranscriptionTool } from '../../src/file-transcription.js';
import { TranscriptionService } from '../../src/transcription-service.js';
import { settingsForModel } from '../../src/settings.js';
import { model, provider, response, trash } from './translation-integration.js';

const directory = await mkdtemp(join(tmpdir(), 'pi-shout-index-integration-'));
process.env.PI_CODING_AGENT_DIR = directory;
const path = join(directory, 'sample');
await writeFile(path, 'public fake sample and model');
const saved = settingsForModel('parakeet-unified-en-0.6b', path, {
  translation: { shortcut: 'ctrl+alt+t', targetLanguage: 'en', prompt: 'Translate to {targetLanguage}' },
});
const save = () => writeFile(join(directory, 'pi-shout.json'), JSON.stringify(saved));
await save();
let asrCalls = 0;
let runtimes = 0;
let runtime: PiVoiceRuntime | undefined;
let fileOptions: Parameters<typeof registerFileTranscriptionTool>[1] | undefined;
let settingsMenus = 0;
const remote = provider();
const hooks = new Map<string, (_event: unknown, ctx: ExtensionContext) => Promise<unknown>>();
const shortcuts = new Map<string, { handler(ctx: ExtensionContext): Promise<void> }>();
const commands = new Map<string, { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }>();
let tool: ToolDefinition | undefined;
const notices: string[] = [];
const pastes: string[] = [];
let selection = 'Retry translation';
const ctx = {
  cwd: directory, mode: 'rpc', hasUI: true, model, modelRegistry: remote.registry,
  sessionManager: { getSessionId: () => 'session', getLeafId: () => 'leaf' },
  ui: { getEditorText: () => '', pasteToEditor: (text: string) => pastes.push(text),
    onTerminalInput: () => () => {}, setWidget() {}, theme: { fg: (_color: string, text: string) => text },
    notify: (text: string) => notices.push(text), select: async () => selection },
} as unknown as ExtensionContext & ExtensionCommandContext;
mock.module('../../src/runtime.js', { namedExports: {
  createPiVoiceRuntime: (pi: ExtensionAPI, original: string, translated: string) => {
    runtimes++;
    runtime = createPiVoiceRuntime(pi, original, translated, {
      transcriptionService: new TranscriptionService(async () => ({ prepare: async () => {}, dispose: async () => {},
        transcribe: async () => { asrCalls++; return '你好'; } })),
      loadAudio: async () => ({ testMicrophonePermission: async () => ({ status: 'granted' as const }),
        createMicrophoneCapture: () => ({ start() {}, stop: async () => ({ pcm: new Float32Array([0.1]) }) }) }),
    });
    return runtime;
  },
} });
mock.module('../../src/file-transcription.js', { namedExports: {
  registerFileTranscriptionTool: (pi: ExtensionAPI, options: Parameters<typeof registerFileTranscriptionTool>[1]) => {
    fileOptions = options;
    return registerFileTranscriptionTool(pi, { ...options,
      decodeFileAudio: async () => ({ pcm: new Float32Array([0.1]), seconds: 1 }) });
  },
} });
mock.module('../../src/settings-menu.js', { namedExports: {
  showSettingsMenu: async () => {
    settingsMenus++;
    saved.translation.targetLanguage = 'fr';
    saved.translation.prompt = 'Updated translation to {targetLanguage}';
    saved.translation.model = { provider: 'fake', id: 'fake' };
    await save();
    return false;
  },
} });
try {
  const { default: extension } = await import('../../src/index.js');
  extension({
    on(event: string, handler: (_event: unknown, ctx: ExtensionContext) => Promise<unknown>) {
      hooks.set(event, handler); return () => { hooks.delete(event); };
    },
    registerShortcut(key: string, value: { handler(ctx: ExtensionContext): Promise<void> }) { shortcuts.set(key, value); },
    registerCommand(key: string, value: { handler(args: string, ctx: ExtensionCommandContext): Promise<void> }) { commands.set(key, value); },
    registerTool(value: ToolDefinition) { tool = value; },
  } as unknown as ExtensionAPI);
  assert.equal(runtimes, 0, 'registration stays lazy');
  assert.ok(tool);
  const file = await tool.execute('original', { path }, undefined, undefined, ctx);
  assert.equal(file.content[0]?.type === 'text' && file.content[0].text, '你好');
  assert.ok(runtime); assert.ok(fileOptions);
  assert.equal(await fileOptions.getTranslationService(), runtime.translationService);
  assert.equal(await fileOptions.getService(), runtime.service);
  assert.equal(runtimes, 1, 'all entry points share one runtime');
  const original = shortcuts.get('ctrl+alt+z')!;
  const translated = shortcuts.get('ctrl+alt+t')!;
  await original.handler(ctx);
  await translated.handler(ctx); // stop original; RPC destination holds it
  const beforeRetry = asrCalls;
  await commands.get('voice-settings')!.handler('', ctx);
  assert.equal(settingsMenus, 1);
  const retry = commands.get('voice-recover')!.handler('', ctx);
  await remote.entered();
  assert.equal(remote.calls[0]!.text, '你好');
  assert.equal(remote.calls[0]!.prompt, 'Updated translation to French (fr)');
  remote.calls[0]!.result.resolve(response('Bonjour'));
  await retry;
  assert.equal(asrCalls, beforeRetry, 'retry does not retranscribe');
  selection = 'Insert translation';
  await commands.get('voice-recover')!.handler('', ctx);
  assert.deepEqual(pastes, ['Bonjour']);
  // Every actual index lifecycle hook clears a held result.
  for (const event of ['session_start', 'session_before_switch', 'session_before_fork', 'session_before_tree', 'session_tree']) {
    await original.handler(ctx); await original.handler(ctx);
    await hooks.get(event)!({}, ctx);
    await commands.get('voice-recover')!.handler('', ctx);
    assert.match(notices.at(-1)!, /No pending/);
  }
  await hooks.get('session_shutdown')!({}, ctx);
  await assert.rejects(tool.execute('after', { path }, undefined, undefined, ctx), /shutting down/);
  assert.equal(runtimes, 1);
  console.log('index wiring, settings-cache retry, lifecycle hooks verified');
} finally {
  await runtime?.shutdown(ctx);
  mock.restoreAll();
  await trash(directory);
}
