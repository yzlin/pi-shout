import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deferred, model, provider, response, trash, turn } from './fixtures/translation-integration.js';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createPiVoiceRuntime } from '../src/runtime.js';
import { settingsForModel } from '../src/settings.js';
import { TranscriptionService } from '../src/transcription-service.js';

function context(options: { mode?: 'tui' | 'rpc'; choice?: string; modelRegistry?: object } = {}) {
  const notices: string[] = [];
  const pastes: string[] = [];
  const widgets: unknown[] = [];
  const listeners = new Set<(data: string) => { consume?: boolean; data?: string } | undefined>();
  const state = { text: '', session: 'session', leaf: 'leaf' };
  const ctx = {
    mode: options.mode ?? 'tui', hasUI: true, model,
    modelRegistry: options.modelRegistry ?? {},
    sessionManager: { getSessionId: () => state.session, getLeafId: () => state.leaf },
    ui: {
      notify: (text: string) => notices.push(text),
      pasteToEditor: (text: string) => pastes.push(text),
      getEditorText: () => state.text,
      onTerminalInput: (handler: (data: string) => { consume?: boolean; data?: string } | undefined) => {
        listeners.add(handler); return () => { listeners.delete(handler); };
      },
      setWidget: (_key: string, value: unknown) => widgets.push(value),
      theme: { fg: (_color: string, text: string) => text },
      select: async () => options.choice,
      confirm: async () => false,
    },
    reload: async () => {},
  } as unknown as ExtensionContext & ExtensionCommandContext;
  return { ctx, notices, pastes, widgets, state, listeners, input(data: string) {
    for (const listener of listeners) {
      const result = listener(data);
      if (result?.consume) return;
      data = result?.data ?? data;
    }
  } };
}

async function configuredDirectory(t: TestContext) {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'pi-shout-runtime-'));
  const modelPath = join(directory, 'model.gguf');
  await writeFile(modelPath, 'fake');
  process.env.PI_CODING_AGENT_DIR = directory;
  const settings = settingsForModel('parakeet-unified-en-0.6b', modelPath, {
    translation: { shortcut: 'ctrl+alt+t', targetLanguage: 'en', prompt: 'Translate to {targetLanguage}' },
  });
  await writeFile(join(directory, 'pi-shout.json'), JSON.stringify(settings));
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await trash(directory);
  });
  return { settings, path: join(directory, 'pi-shout.json') };
}

function fakeService(text = '你好') {
  return new TranscriptionService(async () => ({
    prepare: async () => {},
    transcribe: async () => text,
    dispose: async () => {},
  }));
}

test('real runtime translates Chinese and either shortcut stops the mode that started', async (t) => {
  await configuredDirectory(t);
  let providerCalls = 0;
  const registry = {
    find: () => model,
    hasConfiguredAuth: () => true,
    streamSimple: () => {
      providerCalls += 1;
      return { result: async () => ({
        role: 'assistant', api: model.api, provider: model.provider, model: model.id,
        content: [{ type: 'text', text: 'Hello' }], stopReason: 'stop', timestamp: 1,
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      }) };
    },
  };
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, 'ctrl+alt+z', 'ctrl+alt+t', {
    transcriptionService: fakeService(),
    loadAudio: async () => ({
      testMicrophonePermission: async () => ({ status: 'granted' as const }),
      createMicrophoneCapture: () => ({ start() {}, stop: async () => ({ pcm: new Float32Array([0.1]) }) }),
    }),
  });
  const view = context({ modelRegistry: registry });
  await runtime.toggleCapture(view.ctx, 'translated');
  await runtime.toggleCapture(view.ctx, 'original');
  await runtime.toggleCapture(view.ctx, 'original');
  await runtime.toggleCapture(view.ctx, 'translated');
  assert.deepEqual(view.pastes, ['Hello', '你好']);
  assert.equal(providerCalls, 1);
  await runtime.shutdown(view.ctx);
});

test('pending result blocks both recording modes and canceled retry retains the original', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  let captures = 0;
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, 'ctrl+alt+z', 'ctrl+alt+t', {
    transcriptionService: fakeService(),
    loadAudio: async () => ({
      testMicrophonePermission: async () => ({ status: 'granted' as const }),
      createMicrophoneCapture: () => {
        captures += 1;
        return { start() {}, stop: async () => ({ pcm: new Float32Array([0.1]) }) };
      },
    }),
  });
  const held = context({ mode: 'rpc' });
  await runtime.toggleCapture(held.ctx);
  await runtime.toggleCapture(held.ctx);
  assert.equal(captures, 1);
  await runtime.toggleCapture(held.ctx);
  await runtime.toggleCapture(held.ctx, 'translated');
  assert.equal(captures, 1);
  assert.equal(held.notices.filter(text => text.includes('/voice-recover')).length >= 3, true);

  let providerSignal: AbortSignal | undefined;
  const entered = deferred<void>();
  const retry = context({
    choice: 'Retry translation',
    modelRegistry: {
      find: () => model,
      hasConfiguredAuth: () => true,
      streamSimple: (_selected: unknown, _request: unknown, options: { signal?: AbortSignal }) => {
        providerSignal = options.signal;
        entered.resolve();
        return { result: () => new Promise(() => {}) };
      },
    },
  });
  const retrying = runtime.recover(retry.ctx);
  await entered.promise;
  retry.input('\u001b');
  await retrying;
  assert.equal(providerSignal?.aborted, true);
  assert.equal(retry.notices.some(text => text.includes('Original retained')), true);

  const recovery = context({ choice: 'Insert original' });
  await runtime.recover(recovery.ctx);
  assert.deepEqual(recovery.pastes, ['你好']);
  await runtime.shutdown(recovery.ctx);
});

test('invalidation while audio module is pending prevents late capture and UI painting on every platform', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const audioReady = deferred<void>();
  const releaseAudio = deferred<void>();
  let captures = 0;
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, 'ctrl+alt+z', 'ctrl+alt+t', {
    transcriptionService: fakeService(),
    loadAudio: async () => {
      audioReady.resolve();
      await releaseAudio.promise;
      return {
      testMicrophonePermission: async () => ({ status: 'granted' as const }),
      createMicrophoneCapture: () => {
        captures += 1;
        return { start() {}, stop: async () => ({ pcm: new Float32Array() }) };
      },
    }; }, 
  });
  const view = context();
  const starting = runtime.toggleCapture(view.ctx);
  await audioReady.promise;
  runtime.invalidate();
  const paintsAtInvalidation = view.widgets.length;
  releaseAudio.resolve();
  await starting;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(captures, 0);
  assert.equal(view.widgets.length, paintsAtInvalidation);
  await runtime.shutdown(view.ctx);
});

function runtimeHarness(service = fakeService(), stop: () => Promise<{ pcm: Float32Array }> = async () => ({ pcm: new Float32Array([0.1]) })) {
  let captures = 0;
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, 'ctrl+alt+z', 'ctrl+alt+t', {
    transcriptionService: service,
    loadAudio: async () => ({
      testMicrophonePermission: async () => ({ status: 'granted' as const }),
      createMicrophoneCapture: () => { captures++; return { start() {}, stop }; },
    }),
  });
  return { runtime, captures: () => captures };
}

for (const mode of ['original', 'translated'] as const) {
  test(`${mode} dictation auto-pastes after the stop shortcut is released`, { timeout: 3000 }, async (t) => {
    await configuredDirectory(t);
    const entered = deferred<void>();
    const asr = deferred<string>();
    const service = new TranscriptionService(async () => ({ prepare: async () => {}, dispose: async () => {},
      transcribe: () => { entered.resolve(); return asr.promise; } }));
    const { runtime } = runtimeHarness(service);
    const remote = provider();
    const view = context({ modelRegistry: remote.registry });
    t.after(() => runtime.shutdown(view.ctx));
    await runtime.toggleCapture(view.ctx, mode);
    const stopping = runtime.toggleCapture(view.ctx, mode);
    await entered.promise;
    view.input(mode === 'translated' ? '\u001b[116;7:3u' : '\u001b[122;7:3u');
    asr.resolve('你好');
    if (mode === 'translated') {
      await remote.entered();
      view.input('\u001b[57442;1:3u');
      remote.calls[0]!.result.resolve(response('Hello'));
    }
    await stopping;
    assert.deepEqual(view.pastes, [mode === 'translated' ? 'Hello' : '你好']);
    assert.equal(view.notices.some(notice => notice.includes('held for recovery')), false);
    assert.equal(view.listeners.size, 0);
  });
}

test('retry invalidated during settings await never dispatches the discarded original', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const { runtime } = runtimeHarness();
  const remote = provider();
  const view = context({ mode: 'rpc', modelRegistry: remote.registry });
  await runtime.toggleCapture(view.ctx);
  await runtime.toggleCapture(view.ctx);
  let paints = 0;
  view.ctx.ui.select = async () => {
    // Run after the selection continuation enters await loadSettingsOnce().
    queueMicrotask(() => queueMicrotask(() => { runtime.invalidate(); paints = view.widgets.length; }));
    return 'Retry translation';
  };
  // A provider call is a failure, but resolve it so RED cannot hang.
  remote.registry.streamSimple = () => { remote.calls.push({ text: 'stale', prompt: '', signal: undefined, result: deferred() }); return { result: async () => response() }; };
  await runtime.recover(view.ctx);
  assert.equal(remote.calls.length, 0);
  assert.equal(view.widgets.length, paints);
  await runtime.shutdown(view.ctx);
});

test('invalidation owns old capture teardown before a replacement opens', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const stopping = deferred<void>();
  const stopped = deferred<{ pcm: Float32Array }>();
  let stops = 0;
  const { runtime, captures } = runtimeHarness(fakeService(), () => {
    stops++; stopping.resolve(); return stopped.promise;
  });
  const view = context();
  await runtime.toggleCapture(view.ctx);
  runtime.invalidate();
  runtime.invalidate();
  await stopping.promise;
  const replacement = runtime.toggleCapture(view.ctx);
  // Event-loop barriers cover cached imports and the explicit pre-start immediate.
  await turn(); await turn(); await turn();
  const capturesBeforeRelease = captures();
  stopped.resolve({ pcm: new Float32Array() });
  await replacement;
  await runtime.shutdown(view.ctx);
  assert.equal(capturesBeforeRelease, 1);
  assert.equal(captures(), 2);
  assert.equal(stops, 2);
});

for (const duringSetup of [false, true]) {
  test(`Escape cancels recovery ${duringSetup ? 'during setup before provider dispatch' : 'in active provider lane'}`, { timeout: 3000 }, async (t) => {
    await configuredDirectory(t);
    const { runtime } = runtimeHarness();
    const remote = provider();
    const view = context({ mode: 'rpc', modelRegistry: remote.registry, choice: 'Retry translation' });
    await runtime.toggleCapture(view.ctx);
    await runtime.toggleCapture(view.ctx);
    if (duringSetup) view.ctx.ui.select = async () => {
      queueMicrotask(() => queueMicrotask(() => view.input('\u001b')));
      return 'Retry translation';
    };
    const retry = runtime.recover(view.ctx);
    if (!duringSetup) { await remote.entered(); view.input('\u001b'); }
    await retry;
    assert.equal(remote.calls.length, duringSetup ? 0 : 1);
    assert.equal(view.listeners.size, 0);
    if (!duringSetup) {
      assert.equal(remote.calls[0]!.signal?.aborted, true);
      remote.calls[0]!.result.resolve(response('Late'));
      await turn();
    }
    view.ctx.ui.select = async () => 'Insert original';
    await runtime.recover(view.ctx);
    assert.deepEqual(view.pastes, ['你好']);
    await runtime.shutdown(view.ctx);
  });
}

test('active translation Escape retains original, blocks starts, and ignores late provider success', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const { runtime, captures } = runtimeHarness();
  const remote = provider();
  const view = context({ modelRegistry: remote.registry, choice: 'Insert original' });
  await runtime.toggleCapture(view.ctx, 'translated');
  const stopping = runtime.toggleCapture(view.ctx);
  await remote.entered();
  const busy = runtime.toggleCapture(view.ctx);
  assert.equal(captures(), 1);
  assert.equal(view.listeners.size, 2, 'cancel and destination listeners coexist');
  view.input('\u001b');
  await Promise.all([stopping, busy]);
  const paints = view.widgets.length;
  remote.calls[0]!.result.resolve(response('Late'));
  await turn();
  assert.deepEqual(view.pastes, []);
  assert.equal(view.widgets.length, paints);
  await runtime.recover(view.ctx);
  assert.deepEqual(view.pastes, ['你好']);
  assert.equal(view.listeners.size, 0);
  await runtime.shutdown(view.ctx);
});

test('absent translated target never opens a capture', async (t) => {
  const saved = await configuredDirectory(t);
  delete saved.settings.translation.targetLanguage;
  await writeFile(saved.path, JSON.stringify(saved.settings));
  const { runtime, captures } = runtimeHarness();
  const view = context();
  await runtime.toggleCapture(view.ctx, 'translated');
  assert.equal(captures(), 0);
  assert.match(view.notices.join('\n'), /Choose a translation target/);
  await runtime.shutdown(view.ctx);
});

for (const activity of ['edit-revert', 'cursor']) {
  test(`${activity} holds original; cancel dialog retains, explicit insert or discard clears`, { timeout: 3000 }, async (t) => {
    await configuredDirectory(t);
    const entered = deferred<void>();
    const asr = deferred<string>();
    const service = new TranscriptionService(async () => ({ prepare: async () => {}, dispose: async () => {},
      transcribe: () => { entered.resolve(); return asr.promise; } }));
    const { runtime, captures } = runtimeHarness(service);
    const view = context();
    await runtime.toggleCapture(view.ctx);
    const stopping = runtime.toggleCapture(view.ctx);
    await entered.promise;
    if (activity === 'edit-revert') { view.state.text = 'edit'; view.input('x'); view.state.text = ''; }
    else view.input('\u001b[D');
    asr.resolve('你好');
    await stopping;
    assert.deepEqual(view.pastes, []);
    await runtime.recover(view.ctx); // dismiss dialog
    await runtime.toggleCapture(view.ctx);
    assert.equal(captures(), 1);
    view.ctx.ui.select = async () => activity === 'edit-revert' ? 'Insert original' : 'Discard';
    await runtime.recover(view.ctx);
    assert.deepEqual(view.pastes, activity === 'edit-revert' ? ['你好'] : []);
    await runtime.toggleCapture(view.ctx);
    assert.equal(captures(), 2);
    await runtime.shutdown(view.ctx);
  });
}

for (const lifecycle of ['session', 'tree', 'shutdown']) {
  for (const phase of ['asr', 'provider']) {
    test(`${lifecycle} during ${phase} clears pending and prevents late paste or repaint`, { timeout: 3000 }, async (t) => {
      await configuredDirectory(t);
      const entered = deferred<void>();
      const asr = deferred<string>();
      const remote = provider();
      const service = new TranscriptionService(async () => ({ prepare: async () => {}, dispose: async () => {},
        transcribe: () => { entered.resolve(); return phase === 'asr' ? asr.promise : Promise.resolve('你好'); } }));
      const { runtime } = runtimeHarness(service);
      const view = context({ modelRegistry: remote.registry, choice: 'Insert original' });
      await runtime.toggleCapture(view.ctx, 'translated');
      const stopping = runtime.toggleCapture(view.ctx);
      await (phase === 'asr' ? entered.promise : remote.entered());
      let shutdown: Promise<void> | undefined;
      if (lifecycle === 'shutdown') shutdown = runtime.shutdown(view.ctx);
      else {
        runtime.invalidate();
        if (lifecycle === 'session') view.state.session = 'new'; else view.state.leaf = 'new';
      }
      const paints = view.widgets.length;
      asr.resolve('Late original');
      remote.calls[0]?.result.resolve(response('Late translation'));
      await stopping;
      await turn();
      // Shutdown is allowed its one deliberate clear, but not status repaint.
      if (shutdown) await shutdown;
      assert.equal(view.widgets.slice(paints).every(value => value === undefined), true);
      assert.deepEqual(view.pastes, []);
      await runtime.recover(view.ctx);
      assert.match(view.notices.at(-1)!, /No pending/);
      assert.equal(view.listeners.size, 0);
      await runtime.shutdown(view.ctx);
    });
  }
}

test('branch invalidation clears a recovery status after discarding its pending result', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const entered = deferred<void>();
  const asr = deferred<string>();
  const service = new TranscriptionService(async () => ({ prepare: async () => {}, dispose: async () => {},
    transcribe: () => { entered.resolve(); return asr.promise; } }));
  const { runtime } = runtimeHarness(service);
  const view = context();
  await runtime.toggleCapture(view.ctx);
  const stopping = runtime.toggleCapture(view.ctx);
  await entered.promise;
  view.input('edited');
  asr.resolve('Held result');
  await stopping;
  assert.deepEqual(view.widgets.at(-1), ['Recovery · /voice-recover']);

  view.state.leaf = 'branch';
  runtime.invalidate();
  assert.equal(view.widgets.at(-1), undefined);
  await runtime.shutdown(view.ctx);
});

test('tree invalidation clears an in-progress transcription status', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const entered = deferred<void>();
  const asr = deferred<string>();
  const service = new TranscriptionService(async () => ({ prepare: async () => {}, dispose: async () => {},
    transcribe: () => { entered.resolve(); return asr.promise; } }));
  const { runtime } = runtimeHarness(service);
  const view = context();
  await runtime.toggleCapture(view.ctx);
  const stopping = runtime.toggleCapture(view.ctx);
  await entered.promise;
  assert.equal((view.widgets.at(-1) as string[])[0]?.startsWith('Transcribing…'), true);

  view.state.leaf = 'tree';
  runtime.invalidate();
  assert.equal(view.widgets.at(-1), undefined);
  asr.resolve('Late result');
  await stopping;
  await runtime.shutdown(view.ctx);
});

test('invalidation between stop and visualizer await does not repaint stale transcription status', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const { runtime } = runtimeHarness();
  const view = context();
  await runtime.toggleCapture(view.ctx);
  const stopping = runtime.toggleCapture(view.ctx);
  runtime.invalidate();
  const paints = view.widgets.length;
  await stopping;
  assert.equal(view.widgets.length, paints);
  assert.equal(view.listeners.size, 0);
  await runtime.shutdown(view.ctx);
});

test('invalidation at the scheduled pre-start boundary prevents opening the capture', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  let captures = 0;
  let paints = 0;
  const view = context();
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, 'ctrl+alt+z', 'ctrl+alt+t', {
    transcriptionService: fakeService(),
    loadAudio: async () => {
      // This immediate precedes runtime's explicit pre-start immediate.
      setImmediate(() => { runtime.invalidate(); paints = view.widgets.length; });
      return { testMicrophonePermission: async () => ({ status: 'granted' as const }),
        createMicrophoneCapture: () => { captures++; return { start() {}, stop: async () => ({ pcm: new Float32Array() }) }; } };
    },
  });
  await runtime.toggleCapture(view.ctx);
  assert.equal(captures, 0);
  assert.equal(view.widgets.length, paints);
  await runtime.shutdown(view.ctx);
});

test('macOS permission await is invalidated without capture or repaint', { timeout: 3000, skip: process.platform !== 'darwin' }, async (t) => {
  await configuredDirectory(t);
  const entered = deferred<void>();
  const permission = deferred<{ status: 'granted' }>();
  let captures = 0;
  const view = context();
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, 'ctrl+alt+z', 'ctrl+alt+t', {
    transcriptionService: fakeService(),
    loadAudio: async () => ({ testMicrophonePermission: () => { entered.resolve(); return permission.promise; },
      createMicrophoneCapture: () => { captures++; return { start() {}, stop: async () => ({ pcm: new Float32Array() }) }; } }),
  });
  const starting = runtime.toggleCapture(view.ctx);
  await entered.promise;
  runtime.invalidate();
  const paints = view.widgets.length;
  permission.resolve({ status: 'granted' });
  await starting;
  assert.equal(captures, 0);
  assert.equal(view.widgets.length, paints);
  await runtime.shutdown(view.ctx);
});

test('retry invalidated across visualizer setup await does not dispatch or repaint', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const { runtime } = runtimeHarness();
  const remote = provider();
  const view = context({ mode: 'rpc', modelRegistry: remote.registry });
  await runtime.toggleCapture(view.ctx); await runtime.toggleCapture(view.ctx);
  let paints = 0;
  view.ctx.ui.select = async () => {
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      runtime.invalidate(); paints = view.widgets.length;
    })));
    return 'Retry translation';
  };
  await runtime.recover(view.ctx);
  assert.equal(remote.calls.length, 0);
  assert.equal(view.widgets.length, paints);
  await runtime.shutdown(view.ctx);
});

test('repeated invalidation and shutdown await owned device release without opening a replacement', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const release = deferred<{ pcm: Float32Array }>();
  const { runtime, captures } = runtimeHarness(fakeService(), () => release.promise);
  const view = context();
  await runtime.toggleCapture(view.ctx);
  runtime.invalidate(); runtime.invalidate();
  const replacement = runtime.toggleCapture(view.ctx);
  let finished = false;
  const shutdown = runtime.shutdown(view.ctx).then(() => { finished = true; });
  await turn();
  assert.equal(finished, false);
  assert.equal(captures(), 1);
  release.resolve({ pcm: new Float32Array() });
  await Promise.all([replacement, shutdown]);
  assert.equal(captures(), 1);
  assert.equal(view.listeners.size, 0);
});

test('recording Escape cleanup cannot notify an invalidated session', { timeout: 3000 }, async (t) => {
  await configuredDirectory(t);
  const entered = deferred<void>();
  const release = deferred<{ pcm: Float32Array }>();
  const { runtime } = runtimeHarness(fakeService(), () => { entered.resolve(); return release.promise; });
  const view = context();
  await runtime.toggleCapture(view.ctx);
  view.input('\u001b');
  await entered.promise;
  runtime.invalidate();
  const notices = view.notices.length;
  const paints = view.widgets.length;
  release.resolve({ pcm: new Float32Array() });
  await turn();
  assert.equal(view.notices.length, notices);
  assert.equal(view.widgets.length, paints);
  await runtime.shutdown(view.ctx);
});

test('unsafe original control sequences cannot auto-paste or be explicitly inserted', async (t) => {
  await configuredDirectory(t);
  const { runtime } = runtimeHarness(fakeService('unsafe\u001b[201~text'));
  const view = context({ choice: 'Insert original' });
  await runtime.toggleCapture(view.ctx);
  await runtime.toggleCapture(view.ctx);
  await runtime.recover(view.ctx);
  assert.deepEqual(view.pastes, []);
  assert.match(view.notices.at(-1)!, /Unsafe transcript/);
  view.ctx.ui.select = async () => 'Discard';
  await runtime.recover(view.ctx);
  await runtime.shutdown(view.ctx);
});
