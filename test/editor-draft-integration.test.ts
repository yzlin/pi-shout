import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getKeybindings } from '@earendil-works/pi-tui';
import { createPiVoiceRuntime } from '../src/runtime.js';
import { settingsForModel } from '../src/settings.js';
import { TranscriptionService } from '../src/transcription-service.js';
import { model, provider, response, trash, turn } from './fixtures/translation-integration.js';

function realEditor(): CustomEditor {
  const plain = (text: string) => text;
  const tui = { requestRender() {} } as unknown as ConstructorParameters<typeof CustomEditor>[0];
  const theme = {
    borderColor: plain,
    selectList: {
      selectedPrefix: plain,
      selectedText: plain,
      description: plain,
      scrollInfo: plain,
      noMatch: plain,
    },
  } as unknown as ConstructorParameters<typeof CustomEditor>[1];
  const keybindings = getKeybindings() as unknown as ConstructorParameters<typeof CustomEditor>[2];
  return new CustomEditor(tui, theme, keybindings);
}

async function configuredDirectory(t: TestContext): Promise<void> {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'pi-shout-real-editor-'));
  const modelPath = join(directory, 'model.gguf');
  await writeFile(modelPath, 'fake');
  process.env.PI_CODING_AGENT_DIR = directory;
  await writeFile(join(directory, 'pi-shout.json'), JSON.stringify(settingsForModel(
    'parakeet-unified-en-0.6b',
    modelPath,
    { translation: { shortcut: 'ctrl+alt+t', swapShortcut: 'ctrl+alt+s', targetLanguage: 'en', prompt: 'Translate to {targetLanguage}' } },
  )));
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await trash(directory);
  });
}

function integratedEditorContext(editor: CustomEditor, registry: object) {
  const listeners = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
  const widgets: Array<{ key: string; value: unknown }> = [];
  const ctx = {
    mode: 'tui', hasUI: true, model, modelRegistry: registry,
    sessionManager: { getSessionId: () => 'session', getLeafId: () => 'leaf' },
    ui: {
      notify() {},
      pasteToEditor: (text: string) => editor.handleInput(`\u001b[200~${text}\u001b[201~`),
      setEditorText: (text: string) => editor.setText(text),
      getEditorText: () => editor.getExpandedText(),
      onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
        listeners.add(handler);
        return () => { listeners.delete(handler); };
      },
      setWidget: (key: string, value: unknown) => { widgets.push({ key, value }); },
      theme: { fg: (_color: string, text: string) => text },
      confirm: async () => false,
    },
  } as unknown as ExtensionContext;
  return {
    ctx,
    widgets,
    input(data: string) {
      for (const listener of [...listeners]) {
        const result = listener(data);
        if (result?.consume) return;
        data = result?.data ?? data;
      }
      editor.handleInput(data);
    },
    clearFromNativeAction() {
      for (const listener of [...listeners]) listener('\u0003');
      editor.setText('');
    },
  };
}

function runtimeForEditor() {
  return createPiVoiceRuntime({} as ExtensionAPI, 'ctrl+alt+z', 'ctrl+alt+t', 'ctrl+alt+s', {
    transcriptionService: new TranscriptionService(async () => ({
      prepare: async () => {},
      transcribe: async () => '你好',
      dispose: async () => {},
    })),
    loadAudio: async () => ({
      testMicrophonePermission: async () => ({ status: 'granted' as const }),
      createMicrophoneCapture: () => ({ start() {}, stop: async () => ({ pcm: new Float32Array([0.1]) }) }),
    }),
  });
}

test('native editor preserves paste normalization, draft replacement undo boundaries, and submit clearing', () => {
  const editor = realEditor();
  editor.handleInput('\u001b[200~first\rline\tvalue\u001b[201~');
  assert.equal(editor.getExpandedText(), 'first\nline    value');

  editor.setText('edited translation');
  editor.setText('edited original');
  editor.handleInput('\u001f'); // Native Ctrl+- encoding for the editor undo action.
  assert.equal(editor.getExpandedText(), 'edited translation');

  let submitted = '';
  editor.onSubmit = text => { submitted = text; };
  editor.handleInput('\r');
  assert.equal(submitted, 'edited translation');
  assert.equal(editor.getExpandedText(), '');
});

test('runtime draft swapping is coupled to the native editor and drops a submitted pair before new input', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const remote = provider();
  const editor = realEditor();
  const view = integratedEditorContext(editor, remote.registry);
  const runtime = runtimeForEditor();
  t.after(() => runtime.shutdown(view.ctx));

  await runtime.toggleCapture(view.ctx, 'translated');
  const stopping = runtime.toggleCapture(view.ctx, 'translated');
  await remote.entered();
  remote.calls[0]!.result.resolve(response('Hello\tworld'));
  await stopping;
  assert.equal(editor.getExpandedText(), 'Hello    world');

  view.input('!');
  runtime.swap(view.ctx);
  assert.equal(editor.getExpandedText(), '你好');
  view.input('原');
  runtime.swap(view.ctx);
  assert.equal(editor.getExpandedText(), 'Hello    world!');
  runtime.swap(view.ctx);
  assert.equal(editor.getExpandedText(), '你好原');
  assert.equal(remote.calls.length, 1, 'swapping never calls the provider');

  let submitted = '';
  editor.onSubmit = text => { submitted = text; };
  view.input('\r');
  view.input('N');
  await turn();
  assert.equal(submitted, '你好原');
  assert.equal(editor.getExpandedText(), 'N');
  runtime.swap(view.ctx);
  assert.equal(editor.getExpandedText(), 'N', 'the submitted pair cannot replace subsequent input');
});

test('native clear followed by an immediate swap cannot revive a runtime draft pair', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const remote = provider();
  const editor = realEditor();
  const view = integratedEditorContext(editor, remote.registry);
  const runtime = runtimeForEditor();
  t.after(() => runtime.shutdown(view.ctx));

  await runtime.toggleCapture(view.ctx, 'translated');
  const stopping = runtime.toggleCapture(view.ctx, 'translated');
  await remote.entered();
  remote.calls[0]!.result.resolve(response('Hello'));
  await stopping;
  view.clearFromNativeAction();
  runtime.swap(view.ctx);
  assert.equal(editor.getExpandedText(), '');
});
