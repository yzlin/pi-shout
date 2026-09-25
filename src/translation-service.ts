import { randomUUID } from 'node:crypto';
import type { Api, AssistantMessage, Context, Model, ModelsSimpleStreamOptions, Usage } from '@earendil-works/pi-ai';
import type { ModelRegistry } from '@earendil-works/pi-coding-agent';
import { normalizeTargetLanguage, normalizeTranslationSettings, translationInstructions, type TranslationSettings } from './translation-settings.js';

export type TranslationRegistry = Pick<ModelRegistry, 'find' | 'hasConfiguredAuth'> & {
  streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): { result(): Promise<AssistantMessage> };
};
export type TranslationContext = { model?: Model<Api>; modelRegistry: TranslationRegistry };
export type TranslationRequest = {
  text: string;
  targetLanguage: string;
  settings: TranslationSettings;
  context: TranslationContext;
  priority: 'dictation' | 'file';
  signal?: AbortSignal;
};
export type TranslationResult = { text: string; usage: Usage; model: { provider: string; id: string } };
export type TranslationErrorCode = 'configuration' | 'limit' | 'cancelled' | 'timeout' | 'provider' | 'response' | 'shutdown';
export class TranslationError extends Error {
  constructor(readonly code: TranslationErrorCode, message: string, readonly usage?: Usage) {
    super(message);
    this.name = 'TranslationError';
  }
}

const fail = (code: TranslationErrorCode, message: string, usage?: Usage) => new TranslationError(code, message, usage);
const DEADLINE_MS = 90_000;
const BYTE_LIMIT = 12 * 1024;
const FRAMING_TOKENS = 256;
const ADAPTER_CONTEXT_SAFETY_TOKENS = 4096;
const RESPONSES_MIN_OUTPUT_TOKENS = 16;
const SUPPORTED_APIS = new Set<Api>([
  'openai-completions',
  'openai-codex-responses',
  'openai-responses',
  'azure-openai-responses',
  'anthropic-messages',
  'google-generative-ai',
  'google-vertex',
  'bedrock-converse-stream',
  'mistral-conversations',
  'pi-messages',
]);

function prepare(request: TranslationRequest) {
  const settings = normalizeTranslationSettings(request.settings);
  const language = normalizeTargetLanguage(request.targetLanguage);
  if (!settings || !language) throw fail('configuration', 'Configure a valid translation target and instructions.');
  const instructions = translationInstructions(settings.prompt, language);
  const text = request.text;
  if (!text.trim()) throw fail('configuration', 'The transcript is empty.');
  const bytes = Buffer.byteLength(instructions, 'utf8') + Buffer.byteLength(text, 'utf8');
  if (bytes > BYTE_LIMIT) throw fail('limit', 'Translation input exceeds 12 KiB; shorten the transcript or instructions.');
  const registry = request.context.modelRegistry;
  let selected: Model<Api> | undefined;
  try {
    selected = settings.model
      ? registry.find(settings.model.provider, settings.model.id)
      : request.context.model;
  } catch {
    throw fail('configuration', 'Could not resolve the translation model; check Pi model configuration.');
  }
  if (!selected) throw fail('configuration', settings.model
    ? 'Configured translation model is unavailable; choose an available model.'
    : 'Select a current chat model before translating.');
  if (!SUPPORTED_APIS.has(selected.api) || selected.api === 'openai-responses' && isRecord(selected.compat) && selected.compat.supportsMaxOutputTokens === false)
    throw fail('configuration', `Selected model API "${selected.api}" cannot enforce the translation output limit; choose a supported translation model override.`);
  // A byte can be a token; reserve framing overhead instead of using chars/4 (unsafe for CJK).
  // This is a conservative estimate, not an exact cross-provider tokenizer or cost guarantee.
  const inputTokens = bytes + FRAMING_TOKENS;
  const maxTokens = Math.min(4096, selected.maxTokens, selected.contextWindow - inputTokens);
  if (!Number.isFinite(maxTokens) || maxTokens < 1) throw fail('limit', 'Model context is too small for this translation.');
  const context: Context = { systemPrompt: instructions, messages: [{ role: 'user', content: text, timestamp: Date.now() }] };
  if (selected.api === 'openai-responses' || selected.api === 'azure-openai-responses') {
    // Reuse the stricter byte bound for this fresh text-only context; Pi's loader cannot alias utility subpaths.
    const adapterMaxTokens = selected.contextWindow <= 0
      ? maxTokens
      : Math.min(maxTokens, Math.max(1, selected.contextWindow - inputTokens - ADAPTER_CONTEXT_SAFETY_TOKENS));
    if (adapterMaxTokens < RESPONSES_MIN_OUTPUT_TOKENS)
      throw fail('limit', 'Model context leaves too little room to enforce the translation output limit; choose another translation model.');
  }
  // Advanced model sampling defaults can override named safety fields in Pi adapters.
  const { samplingParams: _ignoredSamplingParams, ...model } = selected;
  return { context, model, registry, maxTokens };
}

type Prepared = ReturnType<typeof prepare>;
type Job = { prepared: Prepared; priority: 'dictation' | 'file'; signal?: AbortSignal; resolve: (result: TranslationResult) => void; reject: (error: TranslationError) => void; detach: () => void; controller?: AbortController; timer?: ReturnType<typeof setTimeout>; done: boolean };

/** Serialized requests; dictation takes precedence only among waiting jobs. */
export class TranslationService {
  private waiting: Job[] = [];
  private active?: Job;
  private closed = false;

  translate(request: TranslationRequest): Promise<TranslationResult> {
    if (this.closed) return Promise.reject(fail('shutdown', 'Translation service is shut down.'));
    if (request.signal?.aborted) return Promise.reject(fail('cancelled', 'Translation cancelled.'));
    let prepared: Prepared;
    try { prepared = prepare(request); }
    catch (error) { return Promise.reject(error instanceof TranslationError ? error : fail('configuration', 'Invalid translation configuration.')); }
    return new Promise((resolve, reject) => {
      const job: Job = { prepared, priority: request.priority, signal: request.signal, resolve, reject, detach: () => {}, done: false };
      const cancel = () => this.finish(job, fail('cancelled', 'Translation cancelled.'));
      job.detach = () => request.signal?.removeEventListener('abort', cancel);
      request.signal?.addEventListener('abort', cancel, { once: true });
      this.waiting.push(job);
      if (request.signal?.aborted) cancel();
      else this.drain();
    });
  }

  shutdown(): void {
    if (this.closed) return;
    this.closed = true;
    for (const job of [...this.waiting, ...(this.active ? [this.active] : [])]) this.finish(job, fail('shutdown', 'Translation service is shut down.'));
  }

  private finish(job: Job, result: TranslationResult | TranslationError): void {
    if (job.done) return;
    job.done = true;
    job.detach();
    if (job.timer) clearTimeout(job.timer);
    job.controller?.abort();
    this.waiting = this.waiting.filter(candidate => candidate !== job);
    if (this.active === job) this.active = undefined;
    if (result instanceof TranslationError) job.reject(result);
    else job.resolve(result);
    this.drain();
  }

  private drain(): void {
    if (this.closed || this.active) return;
    const index = this.waiting.findIndex(job => job.priority === 'dictation');
    const job = this.waiting.splice(index < 0 ? 0 : index, 1)[0];
    if (!job) return;
    // Shared-signal abort may reach drain before this queued job's listener runs.
    if (job.signal?.aborted) {
      this.finish(job, fail('cancelled', 'Translation cancelled.'));
      return;
    }
    this.active = job;
    const controller = new AbortController();
    job.controller = controller;
    // Timer begins only when provider work starts, never during queue wait.
    job.timer = setTimeout(() => this.finish(job, fail('timeout', 'Translation timed out; retry explicitly.')), DEADLINE_MS);
    void (async () => {
      try {
        const { model, registry, context, maxTokens } = job.prepared;
        if (!registry.hasConfiguredAuth(model)) throw fail('configuration', 'Authenticate the selected translation provider in Pi.');
        if (job.done) return;
        const options: ModelsSimpleStreamOptions = {
          signal: controller.signal,
          maxRetries: 0,
          // Codex's automatic WebSocket fallback can retry independently of maxRetries.
          transport: model.api === 'openai-codex-responses' ? 'sse' : undefined,
          timeoutMs: DEADLINE_MS,
          maxTokens,
          toolChoice: 'none',
          cacheRetention: 'none',
          sessionId: randomUUID(),
          onPayload: payload => validatePayloadLimit(model.api, payload, maxTokens),
        };
        const response = await registry.streamSimple(model, context, options).result();
        if (!job.done) this.finish(job, validateResponse(response, model));
      } catch (error) {
        if (!job.done) this.finish(job, error instanceof TranslationError ? error : fail('provider', 'Translation provider request failed; check model and authentication, then retry.'));
      }
    })();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function numericField(payload: unknown, ...path: string[]): number | undefined {
  let value = payload;
  for (const key of path) {
    if (!isRecord(value)) return undefined;
    value = value[key];
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Validate adapter safeguards before transport; Codex alone permits no serialized ceiling. */
function validatePayloadLimit(api: Api, payload: unknown, maxTokens: number): undefined {
  let serializedLimit: number | undefined;
  switch (api) {
    case 'openai-codex-responses':
      // Subscription access is explicitly allowed without a provider-side token cap.
      if (!isRecord(payload) || payload.store !== false)
        throw fail('configuration', 'Codex translation did not disable response storage.');
      return undefined;
    case 'openai-completions':
      serializedLimit = numericField(payload, 'max_tokens') ?? numericField(payload, 'max_completion_tokens');
      break;
    case 'openai-responses':
    case 'azure-openai-responses':
      serializedLimit = numericField(payload, 'max_output_tokens');
      break;
    case 'anthropic-messages':
      serializedLimit = numericField(payload, 'max_tokens');
      break;
    case 'google-generative-ai':
    case 'google-vertex':
      serializedLimit = numericField(payload, 'config', 'maxOutputTokens');
      break;
    case 'bedrock-converse-stream':
      serializedLimit = numericField(payload, 'inferenceConfig', 'maxTokens');
      break;
    case 'mistral-conversations':
      serializedLimit = numericField(payload, 'maxTokens');
      break;
    case 'pi-messages':
      serializedLimit = numericField(payload, 'options', 'maxTokens');
      break;
  }
  if (serializedLimit === undefined || serializedLimit > maxTokens)
    throw fail('configuration', `Selected model API "${api}" did not preserve the translation output limit; choose a supported translation model override.`);
  if ((api === 'openai-completions' || api === 'openai-responses' || api === 'azure-openai-responses') && isRecord(payload) && payload.store !== undefined && payload.store !== false)
    throw fail('configuration', `Selected model API "${api}" did not disable response storage; choose a supported translation model override.`);
  return undefined;
}

function validateResponse(response: AssistantMessage, model: Model<Api>): TranslationResult | TranslationError {
  if (response.stopReason !== 'stop' || response.errorMessage || response.deferred || response.content.some(item => item.type === 'toolCall'))
    return fail('response', 'Translation did not complete; retry or recover the original transcript.', response.usage);
  const text = response.content.filter(item => item.type === 'text').map(item => item.text).join('').trim();
  if (!text || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/u.test(text))
    return fail('response', 'Translation returned empty or unsafe text; recover the original transcript.', response.usage);
  return { text, usage: response.usage, model: { provider: model.provider, id: model.id } };
}
