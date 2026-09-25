import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import { streamSimple as streamCodex } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import { TranslationService, type TranslationRegistry } from '../src/translation-service.js';
import { defaultTranslationSettings } from '../src/translation-settings.js';

const model: Model<Api> = {
  id: 'codex-test', name: 'Codex test', api: 'openai-codex-responses', provider: 'openai-codex',
  baseUrl: 'https://chatgpt.com/backend-api', reasoning: false, input: ['text'],
  contextWindow: 16000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const response: AssistantMessage = {
  role: 'assistant', api: model.api, provider: model.provider, model: model.id,
  content: [{ type: 'text', text: 'Hello' }], stopReason: 'stop', timestamp: 1,
  usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};

for (const override of [false, true]) {
  test(`Codex translation uses the existing registry via ${override ? 'override' : 'current model'} without a hard output cap`, async () => {
    let calls = 0;
    const registry: TranslationRegistry = {
      find: (provider, id) => provider === model.provider && id === model.id ? model : undefined,
      hasConfiguredAuth: selected => selected.provider === model.provider,
      streamSimple: (selected, context, options) => {
        calls++;
        assert.equal(selected.api, 'openai-codex-responses');
        assert.equal(context.messages.length, 1);
        assert.equal(context.messages[0]?.content, '你好');
        assert.equal(context.tools, undefined);
        assert.deepEqual([options?.toolChoice, options?.cacheRetention, options?.maxRetries, options?.timeoutMs, options?.transport],
          ['none', 'none', 0, 90000, 'sse']);
        assert.equal(options?.onPayload?.({ store: false }, selected), undefined);
        return { result: async () => response };
      },
    };
    const result = await new TranslationService().translate({
      text: '你好', targetLanguage: 'en',
      settings: { ...defaultTranslationSettings(), ...(override ? { model: { provider: model.provider, id: model.id } } : {}) },
      context: { model: override ? { ...model, api: 'unverified-api' } : model, modelRegistry: registry }, priority: 'dictation',
    });
    assert.equal(calls, 1);
    assert.equal(result.text, 'Hello');
    assert.deepEqual(result.usage, response.usage);
  });
}

test('Codex output-cap exception still requires explicit disabled response storage', async () => {
  for (const payload of [undefined, {}, { store: true }, { store: 'false' }]) {
    let checked = false;
    const registry: TranslationRegistry = {
      find: () => model, hasConfiguredAuth: () => true,
      streamSimple: (selected, _context, options) => {
        checked = true;
        options?.onPayload?.(payload, selected);
        assert.fail('Unsafe storage must be rejected before transport');
      },
    };
    await assert.rejects(new TranslationService().translate({ text: '你好', targetLanguage: 'en',
      settings: defaultTranslationSettings(), context: { model, modelRegistry: registry }, priority: 'file' }),
    { code: 'configuration' });
    assert.equal(checked, true);
  }
});

test('Codex retains input limits, authentication, cancellation and active timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let authenticated = false;
  let calls = 0;
  let signal: AbortSignal | undefined;
  const registry: TranslationRegistry = {
    find: () => model, hasConfiguredAuth: () => authenticated,
    streamSimple: (_selected, _context, options) => {
      calls++;
      signal = options?.signal;
      return { result: () => new Promise<AssistantMessage>(() => {}) };
    },
  };
  const service = new TranslationService();
  t.after(() => service.shutdown());
  const request = { text: '你好', targetLanguage: 'en', settings: defaultTranslationSettings(),
    context: { model, modelRegistry: registry }, priority: 'file' as const };
  await assert.rejects(service.translate({ ...request, text: '中'.repeat(5000) }), { code: 'limit' });
  await assert.rejects(service.translate(request), { code: 'configuration' });
  assert.equal(calls, 0);
  authenticated = true;
  const abort = new AbortController();
  const cancelled = service.translate({ ...request, signal: abort.signal });
  const cancelledCheck = assert.rejects(cancelled, { code: 'cancelled' });
  abort.abort();
  await cancelledCheck;
  assert.equal(signal?.aborted, true);
  const timedOut = service.translate(request);
  const timeoutCheck = assert.rejects(timedOut, { code: 'timeout' });
  t.mock.timers.tick(90000);
  await timeoutCheck;
  assert.equal(signal?.aborted, true);
  assert.equal(calls, 2);
});

test('real Codex adapter uses the subscription endpoint with no storage or retry, entirely offline', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('Real network forbidden'); });
  // Deliberately unsigned synthetic claims; never read a real credential.
  const token = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-account' } })).toString('base64')}.test`;
  let payload: unknown;
  let headers: Headers | undefined;
  const urls: string[] = [];
  const registry: TranslationRegistry = {
    find: () => model, hasConfiguredAuth: () => true,
    streamSimple: (selected, context, options) => {
      // Never enter the adapter unless production selected the network-isolatable SSE path.
      assert.equal(options?.transport, 'sse');
      return streamCodex({ ...selected, api: 'openai-codex-responses' }, normalizeContext(context), {
        ...options, apiKey: token,
        onPayload: async (candidate, used) => {
          const guarded = await options?.onPayload?.(candidate, used);
          payload = guarded ?? candidate;
        },
        fetch: async (url, init) => {
          urls.push(String(url));
          headers = new Headers(init?.headers);
          return new Response(JSON.stringify({ error: { message: 'Synthetic rate limit' } }), { status: 429 });
        },
      });
    },
  };
  await assert.rejects(new TranslationService().translate({ text: '你好', targetLanguage: 'en',
    settings: defaultTranslationSettings(), context: { model, modelRegistry: registry }, priority: 'file' }), { code: 'response' });
  assert.deepEqual(urls, ['https://chatgpt.com/backend-api/codex/responses']);
  assert.equal(headers?.get('authorization'), `Bearer ${token}`);
  assert.equal(headers?.get('chatgpt-account-id'), 'synthetic-account');
  assert.ok(payload && typeof payload === 'object');
  assert.ok('store' in payload && payload.store === false);
  assert.ok('tool_choice' in payload && payload.tool_choice === 'none');
  assert.ok(!('tools' in payload));
  assert.ok(!('max_output_tokens' in payload));
  assert.ok(!('prompt_cache_key' in payload) || payload.prompt_cache_key === undefined);
  assert.ok('input' in payload && Array.isArray(payload.input) && payload.input.length === 1);
  assert.match(JSON.stringify(payload.input), /你好/u);
  assert.ok('instructions' in payload && typeof payload.instructions === 'string');
  assert.match(payload.instructions, /English/u);
});
