import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type ExtensionAPI,
  type TruncationResult,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { Type } from "typebox";
import { AsyncLimiter } from "./async-limiter.js";
import type { TranscribeSettings } from "./settings.js";
import type { TranscriptionService } from "./transcription-service.js";
import type { TranslationService } from './translation-service.js';
import { TranslationError } from './translation-service.js';
import { normalizeTargetLanguage } from './translation-settings.js';
import type { Usage } from '@earendil-works/pi-ai';

const CONTEXT_LINE_LENGTH = 1_000;
const MAX_FILE_OPERATIONS = 2;
const MAX_FILE_DECODERS = 1;

type FileTranscriptionDetails = {
  inputPath: string;
  modelId: string;
  seconds: number;
  truncation?: TruncationResult;
  fullTranscriptPath?: string;
  translationFailed?: boolean;
};

type FileTranscriptionOptions = {
  getSettings: () => Promise<TranscribeSettings>;
  getService: () => Promise<TranscriptionService>;
  getTranslationService: () => Promise<TranslationService>;
  decodeFileAudio?: typeof import('./file-audio.js').decodeFileAudio;
};

export type FileTranscriptionController = {
  shutdown(): Promise<void>;
};

function normalizeToolPath(path: string): string {
  return path.startsWith("@") ? path.slice(1) : path;
}

/** Wrap long model output lines so Pi's line-aware truncation can retain useful text. */
function wrapLongLines(text: string): string {
  const output: string[] = [];
  for (const originalLine of text.split("\n")) {
    let line = originalLine;
    while (line.length > CONTEXT_LINE_LENGTH) {
      let split = line.lastIndexOf(" ", CONTEXT_LINE_LENGTH);
      if (split <= 0) split = CONTEXT_LINE_LENGTH;
      output.push(line.slice(0, split));
      line = line.slice(split).trimStart();
    }
    output.push(line);
  }
  return output.join("\n");
}

async function saveFullTranscript(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-shout-"));
  const path = join(directory, "transcript.txt");
  await writeFile(path, `${text}\n`, "utf8");
  return path;
}

export function registerFileTranscriptionTool(
  pi: ExtensionAPI,
  options: FileTranscriptionOptions,
): FileTranscriptionController {
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | undefined;
  const operations = new Set<Promise<unknown>>();
  const fileOperations = new AsyncLimiter(MAX_FILE_OPERATIONS);
  const fileDecoders = new AsyncLimiter(MAX_FILE_DECODERS);
  const shutdownController = new AbortController();
  const failed = new Map<string, Usage | undefined>();
  const stopResults = pi.on('tool_result', (event) => {
    if (event.toolName !== 'transcribe_file' || !failed.has(event.toolCallId)) return;
    const usage = failed.get(event.toolCallId);
    failed.delete(event.toolCallId);
    return { isError: true, ...(usage ? { usage } : {}) };
  });

  function track<T>(operation: Promise<T>): Promise<T> {
    const tracked = operation.finally(() => {
      operations.delete(tracked);
    });
    operations.add(tracked);
    return tracked;
  }

  pi.registerTool({
    name: "transcribe_file",
    label: "Transcribe File",
    description: `Transcribe speech from a local audio or video file using Pi Shout's configured local model. Requires the ffmpeg executable on PATH (or PI_VOICE_FFMPEG_PATH). Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}; a complete transcript is saved to a temporary file when needed.`,
    promptSnippet: "Transcribe speech from local audio or video files with a local model",
    promptGuidelines: [
      "If FFmpeg is unavailable, ask before installing it with a system package manager.",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "Local media file path, absolute or relative to the current working directory",
      }),
      targetLanguage: Type.Optional(Type.String({ description: 'Explicit translation target language tag (e.g. en, zh-TW); omit to return the original transcript.' })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (shuttingDown) throw new Error("Pi Voice is shutting down");
      const operationSignal = signal
        ? AbortSignal.any([signal, shutdownController.signal])
        : shutdownController.signal;

      return track(
        (async () => {
          operationSignal.throwIfAborted();
          const targetLanguage = params.targetLanguage === undefined ? undefined : normalizeTargetLanguage(params.targetLanguage);
          if (params.targetLanguage !== undefined && !targetLanguage) throw new Error('Unsupported target language; choose a supported language tag.');
          const translationModel = ctx.model;
          const input = normalizeToolPath(params.path.trim());
          if (!input) throw new Error("A media file path is required");
          const inputPath = resolve(ctx.cwd, input);
          const inputStat = await stat(inputPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") throw new Error(`Media file not found: ${inputPath}`);
            throw error;
          });
          if (!inputStat.isFile()) throw new Error(`Media path is not a regular file: ${inputPath}`);
          operationSignal.throwIfAborted();

          const configured = await options.getSettings();
          const translationSettings = targetLanguage ? { ...configured.translation, model: configured.translation.model && { ...configured.translation.model } } : undefined;
          const service = await options.getService();
          if (fileOperations.saturated) {
            onUpdate?.({
              content: [{ type: "text", text: "Waiting for file transcription capacity…" }],
              details: { inputPath, modelId: configured.model.id, seconds: 0 },
            });
          }

          return fileOperations.run(async () => {
            if (fileDecoders.saturated) {
              onUpdate?.({
                content: [{ type: "text", text: `Waiting to decode ${basename(inputPath)}…` }],
                details: { inputPath, modelId: configured.model.id, seconds: 0 },
              });
            }
            const audio = await fileDecoders.run(async () => {
              onUpdate?.({
                content: [{ type: "text", text: `Decoding ${basename(inputPath)} with FFmpeg…` }],
                details: { inputPath, modelId: configured.model.id, seconds: 0 },
              });
              const decodeFileAudio = options.decodeFileAudio ?? (await import('./file-audio.js')).decodeFileAudio;
              return decodeFileAudio(inputPath, operationSignal);
            }, operationSignal);

            onUpdate?.({
              content: [
                {
                  type: "text",
                  text: `Queued ${audio.seconds.toFixed(1)}s from ${basename(inputPath)} for local transcription…`,
                },
              ],
              details: {
                inputPath,
                modelId: configured.model.id,
                seconds: audio.seconds,
              },
            });
            const transcript = await service.transcribeFile(
              configured,
              audio.pcm,
              operationSignal,
            );
            const details: FileTranscriptionDetails = {
              inputPath,
              modelId: configured.model.id,
              seconds: audio.seconds,
            };

            if (!transcript) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: `No speech detected in ${audio.seconds.toFixed(1)}s of audio from ${inputPath}`,
                  },
                ],
                details,
              };
            }

            let output = transcript;
            let usage: Usage | undefined;
            if (targetLanguage && translationSettings) {
              try {
                const translated = await (await options.getTranslationService()).translate({
                  text: transcript, targetLanguage, settings: translationSettings,
                  context: { model: translationModel, modelRegistry: ctx.modelRegistry },
                  priority: 'file', signal: operationSignal,
                });
                output = translated.text;
                usage = translated.usage;
              } catch (error) {
                operationSignal.throwIfAborted();
                if (error instanceof TranslationError && ['cancelled', 'shutdown'].includes(error.code)) throw error;
                usage = error instanceof TranslationError ? error.usage : undefined;
                output = `TRANSLATION FAILED: ${error instanceof TranslationError ? error.message : 'Translation request failed.'}\n\nOriginal transcript (NOT translated):\n${transcript}`;
                details.translationFailed = true;
              }
            }
            const contextTranscript =
              Buffer.byteLength(output, "utf8") > DEFAULT_MAX_BYTES
                ? wrapLongLines(output)
                : output;
            // Reserve room for the path/notice inside Pi's total model-facing budget.
            const truncation = truncateHead(contextTranscript, {
              maxLines: DEFAULT_MAX_LINES - 3,
              maxBytes: DEFAULT_MAX_BYTES - 512,
            });
            let resultText = truncation.content;
            if (truncation.truncated) {
              const fullTranscriptPath = await saveFullTranscript(output);
              details.truncation = truncation;
              details.fullTranscriptPath = fullTranscriptPath;
              resultText += `\n\n[Transcript truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full result saved to: ${fullTranscriptPath}]`;
            }

            operationSignal.throwIfAborted();
            // Publish failure metadata only when a complete result is ready.
            // Formatting/file-write errors must not leave an orphaned entry.
            if (details.translationFailed) failed.set(_toolCallId, usage);
            return {
              content: [{ type: "text" as const, text: resultText }],
              details,
              ...(usage ? { usage } : {}),
            };
          }, operationSignal);
        })(),
      );
    },
  });

  return {
    shutdown() {
      if (!shutdownPromise) {
        shuttingDown = true;
        shutdownController.abort(new Error("Pi Voice is shutting down"));
        stopResults?.();
        failed.clear();
        shutdownPromise = Promise.allSettled([...operations]).then(() => { failed.clear(); });
      }
      return shutdownPromise;
    },
  };
}
