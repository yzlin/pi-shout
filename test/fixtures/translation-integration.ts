import type { Api, AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { TranslationRegistry } from '../../src/translation-service.js';
import { rm } from 'node:fs/promises';

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const turn = () => new Promise<void>(resolve => setImmediate(resolve));
export const trash = (path: string) => rm(path, { recursive: true, force: true });
export const model: Model<Api> = {
  id: 'fake', name: 'Fake', api: 'openai-completions', provider: 'fake',
  baseUrl: 'https://example.invalid', reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16000, maxTokens: 4096,
};
export const usage = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3,
  cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } };
export function response(text = 'Hello', stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
    content: [{ type: 'text', text }], stopReason, timestamp: 1, usage };
}
export function provider() {
  const calls: { text: unknown; prompt: string | undefined; signal: AbortSignal | undefined; result: ReturnType<typeof deferred<AssistantMessage>> }[] = [];
  const arrivals = new Map<number, ReturnType<typeof deferred<void>>>();
  const registry: TranslationRegistry = {
    find: () => model, hasConfiguredAuth: () => true,
    streamSimple: (_model, context, options) => {
      const result = deferred<AssistantMessage>();
      calls.push({ text: context.messages[0]?.content, prompt: context.systemPrompt, signal: options?.signal, result });
      arrivals.get(calls.length)?.resolve();
      return { result: () => result.promise };
    },
  };
  return { registry, calls, async entered(count = 1) {
    if (calls.length >= count) return;
    const ready = arrivals.get(count) ?? deferred<void>();
    arrivals.set(count, ready);
    await ready.promise;
  } };
}
