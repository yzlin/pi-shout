import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { getEventListeners } from 'node:events';
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type ExtensionAPI, type ExtensionContext, type ToolDefinition,
  type ToolResultEvent, type ToolResultEventResult } from '@earendil-works/pi-coding-agent';
import { registerFileTranscriptionTool } from '../src/file-transcription.js';
import { settingsForModel } from '../src/settings.js';
import { TranscriptionService } from '../src/transcription-service.js';
import { TranslationService } from '../src/translation-service.js';
import { createPiVoiceRuntime } from '../src/runtime.js';
import { deferred, model, provider, response, trash, turn, usage } from './fixtures/translation-integration.js';

test('rejects an unsupported explicit target before path lookup, decoding or model setup', async () => {
  let tool: ToolDefinition | undefined;
  let calls = 0;
  const pi = { on() {}, registerTool(value: ToolDefinition) { tool = value; } } as unknown as ExtensionAPI;
  const controller = registerFileTranscriptionTool(pi, {
    getSettings: async () => { calls++; throw new Error('setup called'); },
    getService: async () => { calls++; throw new Error('ASR called'); },
    getTranslationService: async () => { calls++; throw new Error('translation called'); },
    decodeFileAudio: async () => { calls++; throw new Error('decode called'); },
  });
  assert.ok(tool);
  await assert.rejects(tool.execute('id', { path: '/missing', targetLanguage: 'not-a-target' }, undefined, undefined,
    { cwd: '/tmp' } as ExtensionContext), /Unsupported target language/);
  assert.equal(calls, 0);
  await controller.shutdown();
});

async function harness(t: TestContext, options: {
  text?: string;
  translation?: TranslationService;
  decode?: () => Promise<{ pcm: Float32Array; seconds: number }>;
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'pi-shout-file-test-'));
  const path = join(directory, 'public-sample.wav');
  await writeFile(path, 'dummy regular file; decoded only by fake');
  const configured = settingsForModel('parakeet-unified-en-0.6b', path, {
    translation: { shortcut: 'ctrl+alt+t', swapShortcut: 'ctrl+alt+s', targetLanguage: 'en', prompt: 'Translate to {targetLanguage}' },
  });
  const remote = provider();
  const translation = options.translation ?? new TranslationService();
  let asrCalls = 0;
  let decodes = 0;
  let translationLookups = 0;
  let unlistens = 0;
  const service = new TranscriptionService(async () => ({ prepare: async () => {}, dispose: async () => {},
    transcribe: async () => { asrCalls++; return options.text ?? '你好'; } }));
  let tool: ToolDefinition | undefined;
  let hook: ((event: ToolResultEvent) => ToolResultEventResult | undefined) | undefined;
  const pi = {
    on(_event: string, handler: typeof hook) { hook = handler; return () => { unlistens++; }; },
    registerTool(value: ToolDefinition) { tool = value; },
  } as unknown as ExtensionAPI;
  const controller = registerFileTranscriptionTool(pi, {
    getSettings: async () => configured,
    getService: async () => service,
    getTranslationService: async () => { translationLookups++; return translation; },
    decodeFileAudio: async () => { decodes++; return options.decode ? options.decode() : { pcm: new Float32Array([0.1]), seconds: 1 }; },
  });
  assert.ok(tool); assert.ok(hook);
  const registered = tool;
  const resultHook = hook;
  const ctx = { cwd: directory, model, modelRegistry: remote.registry,
    ui: { pasteToEditor: () => assert.fail('file output must never paste') } } as unknown as ExtensionContext;
  const temporaryResults = new Set<string>();
  t.after(async () => {
    await controller.shutdown(); translation.shutdown(); await service.shutdown();
    for (const directory of temporaryResults) await trash(directory);
    await trash(directory);
  });
  return { configured, remote, translation, controller, ctx, service,
    counts: () => ({ asrCalls, decodes, translationLookups, unlistens }),
    execute: (id: string, targetLanguage?: string, signal?: AbortSignal, onUpdate?: Parameters<ToolDefinition['execute']>[3]) =>
      registered.execute(id, { path, ...(targetLanguage ? { targetLanguage } : {}) }, signal, onUpdate, ctx),
    hook: (id: string, result?: Awaited<ReturnType<ToolDefinition['execute']>>, toolName = 'transcribe_file') => resultHook({
      type: 'tool_result', toolName, toolCallId: id, input: {}, content: result?.content ?? [], details: result?.details, isError: false,
    }),
    async fullResult(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
      const details = result.details;
      assert.ok(details && typeof details === 'object' && 'fullTranscriptPath' in details);
      assert.equal(typeof details.fullTranscriptPath, 'string');
      const path = String(details.fullTranscriptPath);
      temporaryResults.add(dirname(path));
      assert.ok(text(result).includes(path), 'model-facing path is usable');
      assert.equal((await stat(dirname(path))).mode & 0o077, 0, 'result directory is private');
      return readFile(path, 'utf8');
    },
  };
}
function text(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  return result.content.map(item => item.type === 'text' ? item.text : '').join('\n');
}
function bounded(result: Awaited<ReturnType<ToolDefinition['execute']>>) {
  assert.ok(Buffer.byteLength(text(result), 'utf8') <= DEFAULT_MAX_BYTES);
  assert.ok(text(result).split('\n').length <= DEFAULT_MAX_LINES);
}

test('omitted target bypasses translation despite saved target; explicit en works with saved target unset and records usage', { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  const original = await h.execute('original');
  assert.equal(text(original), '你好');
  assert.equal(h.counts().translationLookups, 0);
  delete h.configured.translation.targetLanguage;
  const translating = h.execute('translated', 'en');
  await h.remote.entered();
  assert.equal(h.remote.calls[0]!.text, '你好');
  assert.equal(h.remote.calls[0]!.prompt, 'Translate to English (en)');
  h.remote.calls[0]!.result.resolve(response());
  const translated = await translating;
  assert.equal(text(translated), 'Hello');
  assert.deepEqual(translated.usage, usage);
  assert.equal(h.hook('translated', translated), undefined);
});

for (const failure of ['incomplete', 'provider']) {
  test(`${failure} is labeled with original, hook marks error and preserves available usage exactly once`, { timeout: 3000 }, async (t) => {
    const h = await harness(t);
    const executing = h.execute('failed', 'en');
    await h.remote.entered();
    if (failure === 'provider') h.remote.calls[0]!.result.reject(new Error('fake provider failure'));
    else h.remote.calls[0]!.result.resolve(response('partial', 'length'));
    const result = await executing;
    bounded(result);
    assert.match(text(result), /^TRANSLATION FAILED:/);
    assert.match(text(result), /Original transcript \(NOT translated\):\n你好/);
    assert.equal(h.hook('failed', result, 'other_tool'), undefined);
    assert.deepEqual(h.hook('failed', result), { isError: true, ...(failure === 'incomplete' ? { usage } : {}) });
    assert.equal(h.hook('failed', result), undefined);
  });
}

for (const target of [undefined, 'en']) {
  for (const original of ['公開樣本'.repeat(20000), 'public sample\n'.repeat(DEFAULT_MAX_LINES + 20)]) {
    test(`long ${original.includes('\n') ? 'multiline' : 'UTF8'} original ${target ? 'translation failure' : 'ASR'} is complete in private file with bounded notice`, { timeout: 3000 }, async (t) => {
      const h = await harness(t, { text: original });
      const result = await h.execute('long', target);
      bounded(result);
      const full = await h.fullResult(result);
      assert.ok(full.endsWith(`${original}\n`));
      assert.equal(h.remote.calls.length, 0, '12 KiB cap fails before provider');
      if (target) { assert.match(full, /^TRANSLATION FAILED:/); assert.deepEqual(h.hook('long', result), { isError: true }); }
      else assert.equal(full, `${original}\n`);
    });
  }
}

test('failed result bookkeeping clears on shutdown and removes the registered hook', { timeout: 3000 }, async (t) => {
  const h = await harness(t, { text: 'sample'.repeat(3000) });
  await h.execute('failed', 'en');
  await h.controller.shutdown();
  assert.equal(h.hook('failed'), undefined);
  assert.equal(h.counts().unlistens, 1);
  await h.controller.shutdown();
  assert.equal(h.counts().unlistens, 1);
});

test('failure while saving full result leaves no failure-map entry', { timeout: 3000 }, async (t) => {
  const h = await harness(t, { text: 'sample'.repeat(15000) });
  const old = process.env.TMPDIR;
  process.env.TMPDIR = join(h.ctx.cwd, 'nonexistent');
  try { await assert.rejects(h.execute('failed-save', 'en'), /ENOENT/); }
  finally { if (old === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = old; }
  assert.equal(h.hook('failed-save'), undefined);
});

test('active and queued translation cancellation rejects, releases listeners, and ignores late responses', { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  const activeAbort = new AbortController();
  const queuedAbort = new AbortController();
  const active = h.execute('active', 'en', activeAbort.signal);
  const activeRejected = assert.rejects(active, /abort|cancel/i);
  await h.remote.entered();
  const queuedReady = deferred<void>();
  const originalTranslate = h.translation.translate.bind(h.translation);
  let queuedSignal: AbortSignal | undefined;
  t.mock.method(h.translation, 'translate', (request: Parameters<TranslationService['translate']>[0]) => {
    queuedSignal = request.signal;
    const result = originalTranslate(request); queuedReady.resolve(); return result;
  });
  const queued = h.execute('queued', 'en', queuedAbort.signal);
  const queuedRejected = assert.rejects(queued, /abort|cancel/i);
  await queuedReady.promise;
  queuedAbort.abort(); activeAbort.abort();
  await Promise.all([activeRejected, queuedRejected]);
  assert.equal(h.remote.calls.length, 1);
  assert.ok(queuedSignal);
  assert.equal(getEventListeners(queuedSignal, 'abort').length, 0);
  assert.equal(h.remote.calls[0]!.signal?.aborted, true);
  h.remote.calls[0]!.result.resolve(response('Late'));
  await turn();
  assert.equal(h.hook('active'), undefined); assert.equal(h.hook('queued'), undefined);
});

test('shutdown rejects active decoding and capacity-queued operations even if decoder ignores abort', { timeout: 3000 }, async (t) => {
  const decoding = deferred<void>();
  const release = deferred<{ pcm: Float32Array; seconds: number }>();
  const h = await harness(t, { decode: () => { decoding.resolve(); return release.promise; } });
  const first = h.execute('first');
  const rejected = [assert.rejects(first, /shut|abort|cancel/i)];
  await decoding.promise;
  const waiting = deferred<void>();
  for (const id of ['second', 'third']) {
    rejected.push(assert.rejects(h.execute(id, undefined, undefined, update => {
      if (text(update).includes('capacity')) waiting.resolve();
    }), /shut|abort|cancel/i));
  }
  await waiting.promise;
  const shutdown = h.controller.shutdown();
  release.resolve({ pcm: new Float32Array([0.1]), seconds: 1 });
  await Promise.all([...rejected, shutdown]);
  assert.equal(h.counts().asrCalls, 0);
  assert.equal(h.counts().decodes, 1);
  await assert.rejects(h.execute('after'), /shutting down/);
});

test('shutdown aborts active and translation-queued files; late provider responses never become results', { timeout: 3000 }, async (t) => {
  const h = await harness(t);
  const first = h.execute('active', 'en');
  const firstRejected = assert.rejects(first, /shut|abort|cancel/i);
  await h.remote.entered();
  const queuedReady = deferred<void>();
  const translate = h.translation.translate.bind(h.translation);
  let queuedSignal: AbortSignal | undefined;
  t.mock.method(h.translation, 'translate', (request: Parameters<TranslationService['translate']>[0]) => {
    queuedSignal = request.signal;
    const result = translate(request); queuedReady.resolve(); return result;
  });
  const second = h.execute('queued', 'en');
  const secondRejected = assert.rejects(second, /shut|abort|cancel/i);
  await queuedReady.promise;
  await Promise.all([h.controller.shutdown(), firstRejected, secondRejected]);
  assert.ok(queuedSignal);
  assert.equal(getEventListeners(queuedSignal, 'abort').length, 0);
  for (const call of h.remote.calls) call.result.reject(new Error('late synthetic provider rejection'));
  await turn();
  assert.equal(h.hook('active'), undefined); assert.equal(h.hook('queued'), undefined);
  // Core regression: finish(active) must not drain a job whose shared signal
  // is already aborted, even before that job's own listener has been invoked.
  assert.equal(h.remote.calls.length, 1);
});

test('actual file tools share runtime translation lane: active file is not preempted, waiting dictation precedes waiting file', { timeout: 3000 }, async (t) => {
  const runtime = createPiVoiceRuntime({} as ExtensionAPI, 'ctrl+alt+z', 'ctrl+alt+t', 'ctrl+alt+s');
  const h = await harness(t, { translation: runtime.translationService });
  const first = h.execute('first', 'en');
  await h.remote.entered();
  const queuedReady = deferred<void>();
  const translate = runtime.translationService.translate.bind(runtime.translationService);
  t.mock.method(runtime.translationService, 'translate', (request: Parameters<TranslationService['translate']>[0]) => {
    const work = translate(request);
    if (request.priority === 'file') queuedReady.resolve();
    return work;
  });
  const second = h.execute('second', 'en');
  await queuedReady.promise;
  const dictation = runtime.translationService.translate({ text: 'dictation', targetLanguage: 'en', settings: h.configured.translation,
    context: { model, modelRegistry: h.remote.registry }, priority: 'dictation' });
  assert.equal(h.remote.calls.length, 1);
  assert.equal(h.remote.calls[0]!.signal?.aborted, false);
  h.remote.calls[0]!.result.resolve(response('first'));
  await h.remote.entered(2);
  assert.equal(h.remote.calls[1]!.text, 'dictation');
  h.remote.calls[1]!.result.resolve(response('dictation'));
  await h.remote.entered(3);
  assert.equal(h.remote.calls[2]!.text, '你好');
  h.remote.calls[2]!.result.resolve(response('second'));
  assert.deepEqual((await Promise.all([first, second])).map(text), ['first', 'second']);
  assert.equal((await dictation).text, 'dictation');
  await runtime.shutdown(h.ctx);
});
