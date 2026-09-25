import assert from 'node:assert/strict';
import { test } from 'node:test';
import { streamSimple as streamOpenAICompletions } from '@earendil-works/pi-ai/api/openai-completions';
import { normalizeContext } from '@earendil-works/pi-ai/utils/transcript';
import type { Api, Model } from '@earendil-works/pi-ai';
import { TranslationService, type TranslationRegistry } from '../src/translation-service.js';
import { defaultTranslationSettings } from '../src/translation-settings.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

test('OpenAI adapter payload cannot inherit sampling overrides for output cap or storage', async () => {
  const selected: Model<Api> = {
    id: 'demo',
    name: 'Demo',
    api: 'openai-completions',
    provider: 'demo',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 16000,
    maxTokens: 4096,
    compat: { supportsStore: true, maxTokensField: 'max_completion_tokens' },
    samplingParams: { max_completion_tokens: 16000, store: true },
  };
  let payload: unknown;
  let networkCalls = 0;
  const registry: TranslationRegistry = {
    find: () => selected,
    hasConfiguredAuth: () => true,
    streamSimple: (chosen, context, options) => {
      const adapterModel = { ...chosen, api: 'openai-completions' as const };
      return streamOpenAICompletions(adapterModel, normalizeContext(context), {
        ...options,
        apiKey: 'synthetic-test-key',
        fetch: async () => {
          networkCalls += 1;
          throw new Error('network must not be reached');
        },
        onPayload: async (candidate, usedModel) => {
          const guarded = await options?.onPayload?.(candidate, usedModel);
          payload = guarded ?? candidate;
          throw new Error('stop before transport');
        },
      });
    },
  };

  await assert.rejects(
    new TranslationService().translate({
      text: 'source',
      targetLanguage: 'en',
      settings: defaultTranslationSettings(),
      context: { model: selected, modelRegistry: registry },
      priority: 'file',
    }),
    { code: 'response' },
  );

  assert.ok(isRecord(payload));
  assert.equal(payload.max_completion_tokens, 4096);
  assert.equal(payload.store, false);
  assert.equal(networkCalls, 0);
  assert.deepEqual(selected.samplingParams, { max_completion_tokens: 16000, store: true });
});
