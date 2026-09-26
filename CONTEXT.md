---
summary: Implemented pi-shout product contract, including translated-dictation preview and session-memory draft swapping.
read_when:
  - Before planning or changing dictation, translation, settings, file-tool behavior, or recovery.
---

# CONTEXT

## Product purpose

pi-shout is a replacement fork of [pi-voice](https://github.com/earendil-works/pi-voice), adding user-configurable translation after local transcription. Primary example: speak Chinese, transcribe Chinese locally, translate to English, paste English into the editor.

The locked product contract is implemented locally, reusing upstream MIT-licensed recording and transcription. Automated/mocked behavior, isolated source-extension registration, and a narrow synthetic TUI exercise through Pi 0.87.1 are locally verified. Live microphone/provider quality and cross-platform native verification remain deferred. See [README.md](README.md) for local-checkout setup and operation.

## Domain model

```text
Original shortcut   -> record -> local transcription -> editor
Translated shortcut -> record -> local transcription -> translation -> guarded editor insertion
transcribe_file(path)                  -> original transcript
transcribe_file(path, targetLanguage)  -> translated tool result
```

- Starting shortcut fixes the recording mode. Either shortcut stops an active recording without changing its mode.
- While dictation is processing, reject additional recording starts. Escape cancels the active dictation operation.
- A failed translation or blocked insertion creates one pending dictation result. Resolve or explicitly discard it before another recording.
- Translation is a separate model request, not a chat turn. It receives configured instructions and transcript text, without chat history or workspace content.
- File-tool results remain ordinary tool results in the conversation; translation-request isolation does not keep those results out of chat history.

## Domain glossary

- **Original transcript** — Source-language text produced by local speech recognition. _Avoid_: translation.
- **Translated text** — Text returned by the translation model for the requested target language. _Avoid_: original transcript.
- **Recording mode** — Original or translated output, fixed by the shortcut that starts recording. _Avoid_: stopping-shortcut mode.
- **Target language** — Requested output language or locale, represented by a validated language tag. _Avoid_: transcription language.
- **Translation instructions** — User-editable instructions supporting `{targetLanguage}`, with transcript text supplied separately. _Avoid_: full transcript template.
- **Pending dictation result** — One session-memory recovery item containing original text and any completed translation awaiting explicit action. _Avoid_: transcript history.

## Product constraints

### Fork and settings ownership

- Replace pi-voice; side-by-side installation is out of scope. Installation guidance must require removing pi-voice to avoid duplicate commands, tools, and microphone controls.
- Keep familiar voice commands and the `transcribe_file` tool.
- Own pi-shout settings independently; do not silently migrate or mutate pi-voice settings.
- Reuse the downloaded-model cache rather than duplicating model downloads.
- Keep separate, configurable original (`Ctrl+Alt+Z`), translated (`Ctrl+Alt+T`), and draft-swap (`Ctrl+Alt+S`) shortcuts. All are registered at load; changes require reload. Older settings use `Ctrl+Alt+S` for a missing swap binding when free, then `Ctrl+Alt+D` or `Ctrl+Alt+W` as needed, preserving existing original and translated bindings. Settings reject three-way collisions, warn about built-in bindings, and leave other-extension collision reporting to Pi on reload.
- Settings use `pi-shout.json` in Pi's agent directory (`~/.pi/agent`, overridden by `PI_CODING_AGENT_DIR`); the shared cache follows Hugging Face environment-variable precedence documented in README.
- Node >=22 is declared. Pi packages are pinned to 0.87.1 for development, with peer ranges >=0.87.1; compatibility with newer versions is unverified. This is a local checkout, not a published npm package.

### Translation configuration and semantics

- Provide a searchable target-language picker backed by a curated, validated tag allowlist in `src/translation-settings.ts`, for example `en` and `zh-TW`. Canonicalization does not imply support for every valid language tag.
- Require target selection for translated dictation; do not guess a target. Translation targets are not limited to the speech-recognition model's supported languages.
- Use a saved translation-model override from Pi's configured models; when no override is configured, inherit the current chat model.
- An unavailable explicit override fails rather than silently selecting another provider. Picker availability is not proof of adapter support; translation preflight may still reject it.
- Codex translation reuses Pi's existing Codex authentication through the current chat model or an explicit Codex override. No separate API-key flow is added. Subscription access is permitted under the Codex-only output-cap exception below.
- Default instructions request faithful, natural translation: preserve intent, identifiers, filenames, and code; do not answer questions or add instructions to the spoken content.
- Allow customized translation instructions with `{targetLanguage}`. Send the transcript separately rather than exposing a `{text}` full-message template.
- Give the translation request no agent tools. User customization changes requested style; default translation fidelity is not a guarantee about every model response.

### Privacy and destination safety

- Speech recognition remains local. Translation may send transcript text, but not audio, to the chosen provider. Explain this boundary during setup.
- Provider latency, billing, and retention terms still apply. Local transcription does not imply local-only processing of text.
- Translation requests do not automatically include chat history, workspace content, or raw audio.
- Capture dictation destination state when recording stops. Auto-paste only in the TUI when editor text, session ID, and branch leaf remain unchanged and no intervening terminal input other than key-release notifications is observed; hold the completed result when destination safety is uncertain.
- Never automatically submit pasted text as a chat message.
- Session replacement, branch navigation/fork, reload, or exit clears pending dictation and prevents late insertion into another session. This supersedes holding a result across a session change.

### Recovery and cancellation

- On dictation translation failure, retain the original for recovery; do not automatically paste untranslated text.
- `/voice-recover` actions: retry translation using current settings/current model without rerunning local ASR, explicitly insert original/completed translated text, or discard. Retry does not auto-paste; insertion is a separate explicit action.
- Keep only one pending dictation result in session memory. Do not automatically persist dictation transcripts to disk. No crash/restart recovery in this version.
- Escape while recording discards the recording. Escape during translation aborts the request, discards partial translation, and retains the original for recovery.
- Cancellation prevents any late response from being pasted, but cannot retract text already sent to a provider. Queue waits are cancellable too.
- Empty, incomplete, output-limited, or failed translation responses must not be treated as successful translations.

### File-tool contract

- `transcribe_file` accepts JSON tool arguments `{ "path": "...", "targetLanguage": "en" }`; it is not a slash command. `targetLanguage` is optional.
- Without `targetLanguage`, preserve original-transcription behavior. Do not implicitly apply the saved dictation target to files.
- With an explicit target, transcribe locally and then translate through the shared translation service, even if the saved dictation target is unset. FFmpeg decoding is capped at 128 MiB of decoded audio.
- On translation failure, return a clearly labeled failure plus the original transcript. The `tool_result` hook marks an actual Pi tool error; provider usage is returned when available. Never present untranslated text as translated success.
- Preserve bounded tool output and the existing temporary full-transcript-file behavior when output is truncated.
- Original and translated file output can enter chat history and temporary files. The memory-only dictation rule does not apply to file-tool results.

### Request and concurrency limits

- One translation request per operation; no automatic chunking or retries. Retry is explicit.
- Fixed initial cap: 12 KiB of UTF-8 instructions plus transcript, checked before contacting the provider.
- Active request timeout: 90 seconds. Non-Codex output budget: up to 4,096 tokens, respecting smaller model limits and available context. Codex has no guaranteed provider-side output-token ceiling; timeout and cancellation do not guarantee a cap on subscription usage.
- Reject oversized input without silently truncating it; preserve the original according to the relevant dictation or file recovery contract.
- A byte cap is not an exact token count or a universal monetary-cost limit. Preflight conservatively reserves context space, including adapter-specific minimum-output behavior.
- Reject adapters that cannot enforce the output ceiling before sending transcript text, except for the explicitly authorized `openai-codex-responses` subscription path. That exception retains input/context preflight, isolated requests, no tools, response validation, timeout, cancellation, and mandatory `store: false`; SSE avoids automatic WebSocket fallback/retries. The allowlist and payload checks live in `src/translation-service.ts`. `openai-responses` models declaring `compat.supportsMaxOutputTokens: false` remain rejected; do not extend the exception to other APIs.
- Serialize translation requests. Queued dictation precedes queued file translations, but does not preempt an active file request.
- Queue waits remain cancellable. Dictation can wait behind an active file translation up to that request's timeout.

## Translated-dictation preview and draft swapping

Status: implemented as a reversible, TUI-only editor feature. Drafts are memory-only and swapping does not contact a provider.

### Vocabulary and scope

- **Dictation draft pair** — Two independently editable, session-memory drafts initialized from one original transcript and its completed translation. _Avoid_: pending dictation result, transcript history.
- **Inactive draft preview** — Read-only display above the editor of the draft not currently being edited, including its saved edits. _Avoid_: immutable original transcript, second editor.
- Applies only to translated microphone dictation, including eligible recovery insertion. Original-only dictation and `transcribe_file` behavior stay unchanged.
- The generated original transcript remains distinct from an editable original draft. Switching never reruns ASR or translation and never submits a message.

### Preview and switching

- Show the original transcript as soon as local ASR finishes, with a translating status while translation is queued or running.
- Show a version label, up to three wrapped text lines, an ellipsis for overflow, and a shortcut or availability/status hint. The preview must not render transcript content as terminal controls.
- After successful translation insertion into an empty editor, the editor contains the translation and the preview shows the original draft. Switching saves current editor edits, places the other full draft in the editor, and previews the saved inactive draft.
- Keep edits independently: edit translation, switch to original, edit original, switch back, and restore the edited translation. The preview can therefore contain user-edited text rather than the untouched ASR result.
- Default swap shortcut: `Ctrl+Alt+S`, configurable in `/voice-settings`. Reject collisions among all three voice shortcuts, warn about built-in collisions, and retain Pi's other-extension collision reporting on reload. Shortcut changes require reload, matching existing registration behavior.
- Swapping requires both versions and an empty editor at insertion time. Existing automatic-insertion destination guards still apply; an empty editor alone does not authorize insertion.
- For a nonempty editor, retain existing guarded paste behavior and the original preview, but do not enable swapping or attempt to track a dictated substring.
- Explicit recovery insertion also creates a draft pair when both versions exist and the editor is empty. A failed or cancelled translation leaves the original preview available with existing `/voice-recover` actions; no swap is available without a completed translation. Recovery retry still does not auto-insert.

### Ownership and lifetime

- Keep one current draft pair in session memory, separate from the pending recovery item. A successfully inserted pair must not block another recording as a pending recovery item would.
- Sending the editor content, clearing the editor completely after pair creation, or starting another recording clears the pair and preview. Starting another recording leaves current editor text intact but drops the inactive draft. If that recording fails, the previous pair is not restored.
- Session replacement, branch navigation/fork, reload, and exit clear the pair and preview and prevent late insertion across destinations.
- Clearing an inserted pair is not permission to discard an unresolved pending recovery item. Existing recovery resolution/discard rules continue to govern pending results and recording eligibility.
- Do not persist draft pairs or previews, add transcript history, or automatically submit text. Retain existing provider privacy, cancellation, request limits, and recovery guarantees.

### Implementation and verification boundaries

- Runtime editor observations enforce pair lifetime without adding a direct editor hook. Automated coverage verifies edit-preserving round trips, inactive-draft labels, early preview, three-line wrapping/truncation, nonempty-editor safety, eligible recovery insertion, failure/cancellation, clearing and lifecycle transitions, shortcut configuration/collisions, and unchanged original-dictation and file-tool behavior.
- Swapping uses Pi's native `setEditorText`: the pinned editor provides undo boundaries and moves the cursor according to that API. The feature does not preserve separate undo histories or cursor positions for each draft.
- Tests verify that switching makes no provider requests, does not alter unrelated editor text, and cannot revive a pair after its lifetime ends. RPC recovery insertion remains fire-and-forget and does not create TUI widgets or draft pairs.
- A real isolated Pi 0.87.1 TUI on macOS exercised synthetic translated dictation and actual TUI delivery of `Ctrl+Alt+S`, including independent edits, no additional synthetic provider call while swapping, and immediate clear followed by swap. This did not test a physical keyboard, other terminals or platforms, microphone capture, or a live provider.
- This reversible UI choice does not require an ADR.

## Acceptance and verification

- Local verification uses `npm test` (typecheck plus automated/mocked tests), `npm run check`, and `npm pack --dry-run --ignore-scripts`. Tests have been run with Node 24.11.0; integration fixtures require an external `trash` executable on `PATH` and Node experimental module mocks. No hardware, credentials, or provider calls are needed.
- Mocked coverage includes original/translated dictation and file calls, target/prompt/model configuration, all three shortcut collisions and reload behavior, input/output bounds, pre-disclosure adapter rejection, cancellation/timeouts/failures, queue priority, recovery, editor guards, preview rendering, editable draft swapping, settings-cache retry, and lifecycle teardown. Codex adapter tests use synthetic authentication and a stubbed subscription-endpoint response; they do not verify live quota accounting.
- `npm test` permanently includes `test/extension-loader.test.ts`, which registers the real source extension through Pi 0.87.1 `DefaultResourceLoader` with blocked network fetch, a fresh temporary agent/workspace directory, in-memory settings, and other resource discovery disabled. It does not invoke capture, model requests, or a session runtime.
- Package contents are locally checked. Packaging and isolated registration establish neither live hardware/provider behavior nor native-runtime readiness. `npm install --ignore-scripts` is a local-verification setup option, not native-runtime certification.

## Open questions

No unresolved product naming or API-version choices remain. Verification prerequisites:

- Before claiming the complete live pipeline works, verify microphone → Chinese-capable local ASR → provider → English editor text, alongside original Chinese dictation, using real hardware and an explicitly authorized provider.
- Default-prompt fidelity on mixed-language speech, identifiers, filenames, code, and spoken questions that must be translated rather than answered. Mocked text responses cannot establish speech or translation quality.
- Native audio/transcription and terminal-shortcut behavior on each intended platform; the narrow synthetic macOS TUI exercise does not establish physical-keyboard, terminal, or cross-platform compatibility.
- Pi releases newer than 0.87.1, including adapter output-limit serialization and editor/lifecycle APIs, before declaring compatibility beyond the tested development baseline.

No ADR is recorded: these choices have tradeoffs but were classified as reversible.

## Evidence and implementation direction

Current fork boundaries:

- `index.ts` → `src/index.ts`: registration and lazy runtime loading; no microphone/native initialization at registration.
- `src/runtime.ts`, `src/dictation-output.ts`, and `src/dictation-preview.ts`: capture mode, one pending recovery item, conservative safe-paste guards, early sanitized preview rendering, one editable draft pair, and lifecycle invalidation.
- `src/settings.ts`, `src/translation-settings.ts`, `src/settings-menu.ts`, and `src/translation-settings-ui.ts`: persisted configuration, validated targets/templates, model override, three-way shortcut collision handling, old-settings defaulting, and shortcut editing/reload.
- `src/translation-service.ts`: isolated provider context, preflight and payload bounds, response validation, and a cancellable shared priority queue.
- `src/file-transcription.ts`: explicit-target integration, failure hook, usage, bounded output, and temporary complete results.
- `src/transcription-service.ts`: retained local-ASR model scheduling and dictation priority, separate from the translation lane.

The links below are **upstream evidence**, not descriptions of translation in upstream. The fork reuses this pinned MIT source; its local integration boundaries above include the translation additions.

Inspected upstream revision: `7f3bf4b31962930c779726dc33188b8dcb5be640`.

- [README](https://github.com/earendil-works/pi-voice/blob/7f3bf4b31962930c779726dc33188b8dcb5be640/README.md): setup, shortcuts, file transcription, FFmpeg, and decoded-audio limits.
- [src/runtime.ts](https://github.com/earendil-works/pi-voice/blob/7f3bf4b31962930c779726dc33188b8dcb5be640/src/runtime.ts): dictation completion and `pasteToEditor` insertion point.
- [src/transcription-service.ts](https://github.com/earendil-works/pi-voice/blob/7f3bf4b31962930c779726dc33188b8dcb5be640/src/transcription-service.ts): existing local-model scheduling and dictation priority.
- [src/file-transcription.ts](https://github.com/earendil-works/pi-voice/blob/7f3bf4b31962930c779726dc33188b8dcb5be640/src/file-transcription.ts): tool contract, output truncation, and temporary transcripts.
- [src/settings.ts](https://github.com/earendil-works/pi-voice/blob/7f3bf4b31962930c779726dc33188b8dcb5be640/src/settings.ts) and [src/models.ts](https://github.com/earendil-works/pi-voice/blob/7f3bf4b31962930c779726dc33188b8dcb5be640/src/models.ts): upstream preferences and shared Hugging Face model cache.

## Context map

See [CONTEXT-MAP.md](CONTEXT-MAP.md).
