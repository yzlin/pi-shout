# Pi Shout

A replacement fork of [Pi Voice](https://github.com/earendil-works/pi-voice): local speech recognition, with optional translation before inserting text into Pi's editor. Based on upstream revision `7f3bf4b31962930c779726dc33188b8dcb5be640`; the upstream MIT attribution is preserved in [LICENSE](LICENSE).

## Load a local checkout

Remove Pi Voice before loading this replacement: do not co-install them, because commands, tools, and microphone controls overlap. This checkout is not a published npm package.

Node.js **>=22** is declared. Development and local verification use Pi **0.87.1** packages, pinned in dev dependencies; peer dependencies allow **>=0.87.1**, but newer Pi compatibility is not verified. From this checkout:

```bash
npm install --ignore-scripts
pi -e /absolute/path/to/pi-shout
```

Skipping install scripts is suitable for local verification, **not evidence that native audio/transcription dependencies are hardware-ready**. Run `/voice-settings` in Pi's interactive TUI to choose and, after confirmation, download a local speech-recognition model. On macOS, allow your terminal microphone access in System Settings → Privacy & Security → Microphone if needed.

Settings live in `~/.pi/agent/pi-shout.json` (or `$PI_CODING_AGENT_DIR/pi-shout.json`). Pi Voice settings are neither read nor migrated. Downloaded models reuse the standard Hugging Face cache: `HF_HUB_CACHE`, then `HUGGINGFACE_HUB_CACHE`, then `$HF_HOME/hub`, otherwise `${XDG_CACHE_HOME:-~/.cache}/huggingface/hub`.

## Dictation and settings

- **Ctrl+Alt+Z** starts original dictation; **Ctrl+Alt+T** starts translated dictation. The starting shortcut fixes the mode; either shortcut stops recording.
- `/voice-settings` configures preferred languages, local model, transcription language, Chinese output, microphone, and both shortcuts. `/transcribe` remains its compatibility alias, not a file-transcription command. `/voice` remains reserved for a future voice mode (not registered).
- Choose a translation target using the searchable picker (for example `en` or `zh-TW`). With no target selected, translated capture is refused, not auto-guessed. For Chinese → English, choose a **Chinese-capable local ASR model** and English as the translation target; target languages are independent of ASR coverage.
- Translation uses the current Pi chat model unless you select a configured model override. An unavailable override fails rather than silently falling back. A picker-listed model can still fail translation preflight if its adapter is unsupported.
- **Codex subscription:** use Codex as the current chat model and select **Current chat model (reset override)** under **Translation model**, or choose a Codex override. Translation reuses Pi's existing Codex login, not a separate OpenAI API key. Codex is the only output-cap exception described below.
- Customize or reset translation instructions in settings. Include `{targetLanguage}`; the transcript is supplied separately, and `{text}` is not supported. Defaults request faithful translation, preserving identifiers, filenames, code, and spoken questions rather than answering them; model fidelity is not guaranteed.
- Shortcut editing rejects reuse of the other dictation shortcut and warns about built-in collisions; Pi checks other-extension collisions on reload. **Either shortcut change requires reload**: closing settings reloads this Pi process when needed; reload other open processes separately with `/reload`.

### Cancellation and recovery

Escape while recording discards the audio. Escape during translation (including queue wait) cancels it and retains the original for `/voice-recover`. Translation failure never automatically falls back to pasting the original.

`/voice-recover` manages **one pending item in session memory**: retry translation using current settings/current model without rerunning ASR, explicitly insert the original or a completed translation, or discard. After retry, use recovery again to insert. Pending results block new recordings; processing also blocks another recording start.

Auto-paste requires an unchanged editor, session, and branch, with no intervening terminal input since recording stopped (key-release notifications are ignored); uncertain destinations are held for recovery. Text is **never auto-submitted**. Session/branch lifecycle changes, reload, and exit clear pending state and prevent late insertion. Nothing is persisted for dictation recovery: reload, exit, or crash loses it. Cancellation prevents late paste; it cannot make a provider unsee text already sent.

## File transcription and FFmpeg

`transcribe_file` is an **agent tool**, not a slash command. Example JSON tool arguments:

```json
{"path":"/absolute/path/to/audio.wav"}
```

This returns the original transcript regardless of the saved dictation target. To explicitly translate, even when the saved target is unset:

```json
{"path":"/absolute/path/to/audio.wav","targetLanguage":"en"}
```

Translation failure returns a clearly labeled failure and original transcript, with an actual Pi tool error set by the `tool_result` hook. Provider usage is included when available. Text output is bounded; if truncated, a temporary file holds the complete result and its path is returned. Both original and translated file output can enter chat history and temporary files: the memory-only dictation recovery rule does **not** apply to this tool.

Decoded audio is limited to **128 MiB** (about 35 minutes at 16 kHz mono float32). File decoding requires the `ffmpeg` executable. Install FFmpeg with your system package manager if needed:

```bash
# macOS with Homebrew
brew install ffmpeg

# Debian or Ubuntu
sudo apt install ffmpeg

# Windows with winget
winget install Gyan.FFmpeg
```

If FFmpeg is installed outside `PATH`, point Pi Shout at it before starting Pi:

```bash
export PI_VOICE_FFMPEG_PATH=/path/to/ffmpeg
```

The legacy `PI_TRANSCRIBE_FFMPEG_PATH` variable remains supported when `PI_VOICE_FFMPEG_PATH` is not set. When FFmpeg is unavailable, the tool reports platform-specific guidance; the agent should ask before running a package-manager command.

## Translation privacy and limits

Speech recognition stays local. Translation sends **only translation instructions and transcript text** to the selected provider, not audio, chat history, workspace content, or agent tools. Provider billing and retention policies still apply; this is not a zero-retention promise.

- Input: **12 KiB UTF-8** total expanded instructions plus transcript, rejected rather than truncated. This is not an exact token or cost budget.
- Active request: **90 seconds**. Non-Codex adapters enforce at most **4,096 output tokens**, clamped to model/context limits. **Codex does not enforce that output ceiling**: timeout and cancellation are not a guarantee on subscription usage. Input limits, isolated context, and response checks still apply. No automatic retries or chunking. Empty, unsafe, partial, length-limited, or otherwise incomplete responses are rejected.
- Dictation and files share one active translation lane. Queued dictation has priority over queued files without preempting active work; queue waits are cancellable.
- Apart from the explicit `openai-codex-responses` subscription exception, adapters unable to enforce the output ceiling are rejected **before transcript disclosure**. This still includes `openai-responses` models with `compat.supportsMaxOutputTokens: false`. Codex uses SSE with retries disabled and requires `store: false`; provider retention and subscription limits still apply. The maintained API allowlist and payload checks are in [src/translation-service.ts](src/translation-service.ts).

## Developing & Building Pi Shout

Local checks (no microphone, provider credentials, model downloads, or real AI calls required):

```bash
npm test                          # typecheck + automated/mocked tests
npm run check                     # typecheck only; already included in npm test
npm pack --dry-run --ignore-scripts # inspect package contents, no tarball or publish
```

Tests were verified locally with **Node 24.11.0**. Integration fixtures use Node's experimental module mocks and require the external **`trash` executable on `PATH`** for cleanup (test-only, not a runtime dependency). The suite verifies mocked local behavior and includes an isolated Pi 0.87.1 resource-loader check that registers the source extension with network access blocked; it does not invoke capture, model requests, or a session runtime. Live microphone/provider speech-to-translation quality samples, native hardware readiness, cross-platform native verification, and compatibility with newer Pi versions remain deferred; this is not production certification.

To replay onboarding, enable the debug-only `/voice-onboarding` command:

```bash
PI_VOICE_DEBUG=1 pi -e /absolute/path/to/pi-shout
```

In the source checkout, `CONTEXT.md` documents the product contract and `CONTEXT-MAP.md` documents implementation boundaries.
