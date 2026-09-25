import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { test } from 'node:test';
import type { Api, AssistantMessage, Model, Usage } from '@earendil-works/pi-ai';
import { TranslationService, TranslationError, type TranslationRegistry } from '../src/translation-service.js';
import { defaultTranslationSettings, translationInstructions } from '../src/translation-settings.js';
import { settingsForModel } from '../src/settings.js';

const usage: Usage = { input: 4, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const model: Model<Api> = { id: 'demo', name: 'Demo', api: 'openai-completions', provider: 'demo', baseUrl: 'https://example.invalid', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 16000, maxTokens: 4096 };
function response(text: string, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [{ type: 'text', text }], usage, stopReason, timestamp: 1 };
}
function setup() {
  const pending: Array<(message: AssistantMessage) => void> = [];
  const calls: Array<{ context: Parameters<TranslationRegistry['streamSimple']>[1]; options: Parameters<TranslationRegistry['streamSimple']>[2] }> = [];
  const registry: TranslationRegistry = {
    find: () => model,
    hasConfiguredAuth: () => true,
    streamSimple: (_model, context, options) => {
      calls.push({ context, options });
      return { result: () => new Promise(resolve => pending.push(resolve)) };
    },
  };
  const service = new TranslationService();
  const translate = (text: string, priority: 'dictation' | 'file' = 'file', signal?: AbortSignal) => service.translate({ text, targetLanguage: 'en', settings: defaultTranslationSettings(), context: { model, modelRegistry: registry }, priority, signal });
  return { service, translate, calls, pending, registry };
}

test('swapped shortcuts accepted by settings reach provider without an implicit shortcut collision', async () => {
  const { service } = setup();
  const settings = settingsForModel('parakeet-unified-en-0.6b', '/tmp/model', {
    shortcut: 'ctrl+alt+x', translation: { shortcut: 'ctrl+alt+z', prompt: 'Translate to {targetLanguage}', targetLanguage: 'en' },
  });
  let called = false;
  const registry: TranslationRegistry = {
    find: () => model,
    hasConfiguredAuth: () => true,
    streamSimple: () => { called = true; return { result: async () => response('English') }; },
  };
  const result = await service.translate({ text: 'source', targetLanguage: 'en', settings: settings.translation, context: { model, modelRegistry: registry }, priority: 'file' });
  assert.equal(called, true);
  assert.equal(result.text, 'English');
});

test('isolated request sends only transcript and safe instructions with bounded options and usage', async () => {
  const { translate, calls, pending } = setup();
  const result = translate('你好 {targetLanguage}');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.context.messages.length, 1);
  assert.equal(calls[0]?.context.messages[0]?.role, 'user');
  assert.equal(calls[0]?.context.messages[0]?.content, '你好 {targetLanguage}');
  assert.equal(calls[0]?.context.tools, undefined);
  assert.ok(!calls[0]?.context.systemPrompt?.includes('你好'));
  assert.deepEqual([calls[0]?.options?.toolChoice, calls[0]?.options?.cacheRetention, calls[0]?.options?.maxRetries, calls[0]?.options?.timeoutMs], ['none', 'none', 0, 90000]);
  assert.equal(typeof calls[0]?.options?.sessionId, 'string');
  assert.ok(calls[0]?.options?.sessionId);
  pending.shift()?.(response('Hello'));
  assert.deepEqual(await result, { text: 'Hello', usage, model: { provider: 'demo', id: 'demo' } });
});

test('rejects partial and terminal-control output, preserves usage', async () => {
  for (const [text, stop] of [['partial', 'length'], ['bad\u001b[201~', 'stop'], ['bad\u009b201~', 'stop'], ['', 'stop'], ['  \n  ', 'stop'], ['partial', 'error'], ['partial', 'aborted'], ['partial', 'pending'], ['partial', 'toolUse'], ['partial', 'deferred']] as const) {
    const { translate, pending } = setup();
    const result = translate('source');
    pending.shift()?.(response(text, stop));
    await assert.rejects(result, (error: unknown) => error instanceof TranslationError && error.code === 'response' && error.usage === usage);
  }
});

test('each request uses fresh provider affinity without chat session identity', async () => {
  const { service, calls, pending } = setup();
  const context = { model, modelRegistry: {
    find: () => model, hasConfiguredAuth: () => true,
    streamSimple: (_model: Model<Api>, streamContext: Parameters<TranslationRegistry['streamSimple']>[1], options?: Parameters<TranslationRegistry['streamSimple']>[2]) => {
      calls.push({ context: streamContext, options });
      return { result: () => new Promise<AssistantMessage>(resolve => pending.push(resolve)) };
    },
  }, sessionId: 'chat-session' };
  const translate = (text: string) => service.translate({ text, targetLanguage: 'en', settings: defaultTranslationSettings(), context, priority: 'file' });
  const first = translate('one');
  pending.shift()?.(response('first'));
  await first;
  const second = translate('two');
  pending.shift()?.(response('second'));
  await second;
  const ids = calls.map(call => call.options?.sessionId);
  assert.equal(typeof ids[0], 'string');
  assert.equal(typeof ids[1], 'string');
  assert.notEqual(ids[0], ids[1]);
  assert.ok(ids.every(id => id !== 'chat-session'));
});

test('queued dictation takes priority, cancellation removes queued job, late response is ignored', async () => {
  const { translate, calls, pending, service } = setup();
  const first = translate('first');
  const cancelled = new AbortController();
  const waiting = translate('cancelled', 'file', cancelled.signal);
  const dictation = translate('dictation', 'dictation');
  const file = translate('last', 'file');
  cancelled.abort();
  await assert.rejects(waiting, { code: 'cancelled' });
  pending.shift()?.(response('one'));
  await first;
  assert.equal(calls[1]?.context.messages[0]?.role, 'user');
  assert.equal(calls[1]?.context.messages[0]?.content, 'dictation');
  pending.shift()?.(response('two'));
  await dictation;
  pending.shift()?.(response('three'));
  await file;
  service.shutdown();
  await assert.rejects(translate('late'), { code: 'shutdown' });
});

for (const priority of ['file', 'dictation'] as const) {
  test(`shared abort never authenticates or dispatches queued ${priority} jobs and preserves unrelated FIFO work`, async (t) => {
    const { service, translate, calls, pending, registry } = setup();
    t.after(async () => {
      service.shutdown();
      await Promise.allSettled([first, second]);
    });
    const auth = t.mock.method(registry, 'hasConfiguredAuth');
    const shared = new AbortController();
    const unrelated = new AbortController();
    const cancelled = [
      translate('private active', 'file', shared.signal),
      translate('private queued one', priority, shared.signal),
      translate('private queued two', priority, shared.signal),
    ].map(result => assert.rejects(result, (error: unknown) =>
      error instanceof TranslationError && error.code === 'cancelled' && error.message === 'Translation cancelled.'));
    const first = translate('unrelated first', 'file', unrelated.signal);
    const second = translate('unrelated second', 'file', unrelated.signal);
    assert.equal(calls.length, 1); // Queued dictation must not preempt active work.
    assert.equal(getEventListeners(shared.signal, 'abort').length, 3);
    assert.equal(getEventListeners(unrelated.signal, 'abort').length, 2);

    shared.abort(new Error('private cancellation reason'));
    await Promise.all(cancelled);
    assert.equal(calls[0]?.options?.signal?.aborted, true);
    assert.equal(getEventListeners(shared.signal, 'abort').length, 0);
    assert.deepEqual(calls.map(call => call.context.messages[0]?.content), ['private active', 'unrelated first']);
    assert.equal(auth.mock.callCount(), 2);

    pending.shift()?.(response('late cancelled result'));
    await Promise.resolve();
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.options?.signal?.aborted, false);
    pending.shift()?.(response('first result'));
    assert.equal((await first).text, 'first result');
    assert.equal(getEventListeners(unrelated.signal, 'abort').length, 1);
    assert.deepEqual(calls.map(call => call.context.messages[0]?.content), ['private active', 'unrelated first', 'unrelated second']);
    pending.shift()?.(response('second result'));
    assert.equal((await second).text, 'second result');
    assert.equal(auth.mock.callCount(), 3);
    assert.equal(getEventListeners(unrelated.signal, 'abort').length, 0);
  });
}

test('explicit unavailable model fails closed, inherited model absence is actionable', async () => {
  const { service, calls } = setup();
  const registry: TranslationRegistry = {
    find: () => undefined,
    hasConfiguredAuth: () => true,
    streamSimple: () => { throw new Error('must not call provider'); },
  };
  const settings = { ...defaultTranslationSettings(), model: { provider: 'missing', id: 'model' } };
  await assert.rejects(service.translate({ text: 'source', targetLanguage: 'en', settings, context: { model, modelRegistry: registry }, priority: 'file' }), { code: 'configuration' });
  await assert.rejects(service.translate({ text: 'source', targetLanguage: 'en', settings: defaultTranslationSettings(), context: { modelRegistry: registry }, priority: 'file' }), { code: 'configuration' });
  assert.equal(calls.length, 0);
});

test('active cancellation aborts stream and ignores late completion', async () => {
  const { translate, calls, pending } = setup();
  const controller = new AbortController();
  const result = translate('source', 'dictation', controller.signal);
  const signal = calls[0]?.options?.signal;
  controller.abort();
  assert.equal(signal?.aborted, true);
  await assert.rejects(result, { code: 'cancelled' });
  pending.shift()?.(response('late'));
});

test('active timeout rejects noncooperating provider and allows next request', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { translate, pending, calls } = setup();
  const result = translate('first');
  const failure = assert.rejects(result, { code: 'timeout' });
  t.mock.timers.tick(90000);
  await failure;
  const next = translate('second');
  assert.equal(calls.length, 2);
  pending.shift()?.(response('late'));
  pending.shift()?.(response('done'));
  assert.equal((await next).text, 'done');
});

test('provider errors are sanitized and shutdown rejects queued/active work', async () => {
  const service = new TranslationService();
  const registry: TranslationRegistry = {
    find: () => model,
    hasConfiguredAuth: () => true,
    streamSimple: () => { throw new Error('secret credential and transcript'); },
  };
  await assert.rejects(service.translate({ text: 'private transcript', targetLanguage: 'en', settings: defaultTranslationSettings(), context: { model, modelRegistry: registry }, priority: 'file' }), (error: unknown) => error instanceof TranslationError && error.code === 'provider' && !error.message.includes('secret'));
  const { translate, service: waitingService, pending } = setup();
  const active = translate('active');
  const queued = translate('queued');
  waitingService.shutdown();
  waitingService.shutdown();
  await assert.rejects(active, { code: 'shutdown' });
  await assert.rejects(queued, { code: 'shutdown' });
  pending.shift()?.(response('late'));
});

test('context exhaustion blocks stream and output budget respects all three limits', async () => {
  for (const [contextWindow, modelLimit, expected] of [[200, 4096, undefined], [20000, 8000, 4096], [20000, 300, 300], [400, 8000, 131]] as const) {
    const selected = { ...model, contextWindow, maxTokens: modelLimit };
    let streamed = false;
    let budget: number | undefined;
    const registry: TranslationRegistry = {
      find: () => selected, hasConfiguredAuth: () => true,
      streamSimple: (_model, _context, options) => { streamed = true; budget = options?.maxTokens; return { result: async () => response('translated') }; },
    };
    const result = new TranslationService().translate({ text: 'x', targetLanguage: 'en', settings: { shortcut: 'ctrl+alt+t', prompt: '{targetLanguage}' }, context: { model: selected, modelRegistry: registry }, priority: 'file' });
    if (expected === undefined) { await assert.rejects(result, { code: 'limit' }); assert.equal(streamed, false); }
    else { await result; assert.equal(budget, expected); }
  }
});

test('unsupported and unenforceable adapters fail before streaming', async () => {
  for (const selected of [
    { ...model, api: 'custom-unverified-api' },
    { ...model, api: 'openai-responses', compat: { supportsMaxOutputTokens: false } },
    { ...model, api: 'openai-responses', contextWindow: 270 },
    { ...model, api: 'azure-openai-responses', contextWindow: 4100 },
  ]) {
    let streamed = false;
    const registry: TranslationRegistry = {
      find: () => selected,
      hasConfiguredAuth: () => true,
      streamSimple: () => { streamed = true; return { result: async () => response('must not translate') }; },
    };
    await assert.rejects(
      new TranslationService().translate({ text: 'x', targetLanguage: 'en', settings: { shortcut: 'ctrl+alt+t', prompt: '{targetLanguage}' }, context: { model: selected, modelRegistry: registry }, priority: 'file' }),
      (error: unknown) => error instanceof TranslationError && (error.code === 'configuration' || error.code === 'limit') && /supported translation|output limit/u.test(error.message),
    );
    assert.equal(streamed, false);
  }
});

test('Responses preflight uses the conservative input bound at the 16-token floor without expanding caps', async () => {
  const settings = { shortcut: 'ctrl+alt+t', prompt: '{targetLanguage}' };
  const instructions = translationInstructions(settings.prompt, 'en');
  for (const api of ['openai-responses', 'azure-openai-responses'] as const) {
    for (const text of ['x', '你好世界']) {
      const inputTokens = Buffer.byteLength(instructions) + Buffer.byteLength(text) + 256;
      // Pi's fresh text-only estimate is smaller; the preflight deliberately rejects sooner.
      const adapterEstimate = Math.ceil(instructions.length / 4) + Math.ceil(text.length / 4);
      assert.ok(inputTokens > adapterEstimate);
      for (const [room, modelLimit, accepted] of [[15, 4096, false], [16, 4096, true], [16, 15, false], [16, 16, true]] as const) {
        const selected = { ...model, api, contextWindow: inputTokens + 4096 + room, maxTokens: modelLimit };
        let authCalls = 0;
        let streamCalls = 0;
        const registry: TranslationRegistry = {
          find: () => selected,
          hasConfiguredAuth: () => { authCalls += 1; return true; },
          streamSimple: (chosen, _context, options) => {
            streamCalls += 1;
            const cap = Math.min(4096, modelLimit, selected.contextWindow - inputTokens);
            assert.equal(options?.maxTokens, cap);
            const serializedLimit = Math.max(16, Math.min(cap, Math.max(1, selected.contextWindow - adapterEstimate - 4096)));
            assert.ok(serializedLimit <= cap, 'The Responses floor must never expand the requested cap');
            assert.equal(options?.onPayload?.({ max_output_tokens: serializedLimit }, chosen), undefined);
            return { result: async () => response('translated') };
          },
        };
        const result = new TranslationService().translate({ text, targetLanguage: 'en', settings, context: { model: selected, modelRegistry: registry }, priority: 'file' });
        if (accepted) assert.equal((await result).text, 'translated');
        else await assert.rejects(result, { code: 'limit' });
        assert.equal(authCalls, accepted ? 1 : 0);
        assert.equal(streamCalls, accepted ? 1 : 0);
      }
    }
  }
});

test('request snapshot removes advanced sampling defaults without mutating the selected model', async () => {
  const selected: Model<Api> = { ...model, samplingParams: { max_completion_tokens: 16000, store: true } };
  let chosen: Model<Api> | undefined;
  const registry: TranslationRegistry = {
    find: () => selected,
    hasConfiguredAuth: () => true,
    streamSimple: (used) => { chosen = used; return { result: async () => response('translated') }; },
  };
  await new TranslationService().translate({ text: 'source', targetLanguage: 'en', settings: defaultTranslationSettings(), context: { model: selected, modelRegistry: registry }, priority: 'file' });
  assert.equal(chosen?.samplingParams, undefined);
  assert.deepEqual(selected.samplingParams, { max_completion_tokens: 16000, store: true });
});

test('missing authentication blocks stream and explicit override wins over current model', async () => {
  const selected = { ...model, id: 'override' };
  let calls = 0;
  const used: Model<Api>[] = [];
  const registry: TranslationRegistry = {
    find: (provider, id) => provider === 'demo' && id === 'override' ? selected : undefined,
    hasConfiguredAuth: () => calls++ > 0,
    streamSimple: (chosen) => { used.push(chosen); return { result: async () => response('translated') }; },
  };
  const service = new TranslationService();
  const settings = { ...defaultTranslationSettings(), model: { provider: 'demo', id: 'override' } };
  const request = { text: 'source', targetLanguage: 'en', settings, context: { model, modelRegistry: registry }, priority: 'file' as const };
  await assert.rejects(service.translate(request), { code: 'configuration' });
  assert.equal(used.length, 0);
  await service.translate(request);
  assert.equal(used[0]?.id, 'override');
});

test('queued requests snapshot settings and selected model without chat history or tools', async () => {
  const selected = { ...model };
  const settings = defaultTranslationSettings();
  const contexts: Array<Parameters<TranslationRegistry['streamSimple']>[1]> = [];
  const chosen: Model<Api>[] = [];
  const pending: Array<(value: AssistantMessage) => void> = [];
  const registry: TranslationRegistry = {
    find: () => selected, hasConfiguredAuth: () => true,
    streamSimple: (used, context) => { chosen.push(used); contexts.push(context); return { result: () => new Promise(resolve => pending.push(resolve)) }; },
  };
  const service = new TranslationService();
  const context = { model: selected, modelRegistry: registry };
  const first = service.translate({ text: 'first', targetLanguage: 'en', settings, context, priority: 'file' });
  const second = service.translate({ text: 'literal {targetLanguage}', targetLanguage: 'en', settings, context, priority: 'file' });
  settings.prompt = 'Changed {targetLanguage}';
  selected.id = 'changed';
  pending.shift()?.(response('first result'));
  await first;
  assert.equal(chosen[1]?.id, 'demo');
  assert.match(contexts[1]?.systemPrompt ?? '', /^Translate the following transcript/);
  assert.deepEqual(contexts[1]?.messages.map(message => message.role), ['user']);
  assert.equal(contexts[1]?.messages[0]?.content, 'literal {targetLanguage}');
  assert.equal(contexts[1]?.tools, undefined);
  pending.shift()?.(response('second result'));
  await second;
});

test('rejects tool calls, error messages and deferred output with usage; permits newlines and tabs', async () => {
  const failures: AssistantMessage[] = [
    { ...response('text'), content: [{ type: 'toolCall', id: 'call', name: 'run', arguments: {} }] },
    { ...response('text'), errorMessage: 'private provider details' },
    { ...response('text'), deferred: { provider: 'demo', modelId: 'demo', api: model.api, id: 'pending' } },
  ];
  for (const message of failures) {
    const { translate, pending } = setup();
    const result = translate('source');
    pending.shift()?.(message);
    await assert.rejects(result, (error: unknown) => error instanceof TranslationError && error.code === 'response' && error.usage === usage && !error.message.includes('private'));
  }
  const { translate, pending } = setup();
  const result = translate('source');
  pending.shift()?.(response('one\n\ttwo'));
  assert.equal((await result).text, 'one\n\ttwo');
});

test('input cap and missing inherited model fail before provider request', async () => {
  const { translate, calls, service } = setup();
  await assert.rejects(translate('中'.repeat(5000)), { code: 'limit' });
  assert.equal(calls.length, 0);
  service.shutdown();
});
