---
summary: Reading guide for pi-shout's locked product contract, implemented boundaries, and pinned upstream evidence.
read_when:
  - Before changing dictation, translation, settings, file tools, or verification claims.
---

# CONTEXT-MAP

## Read first

- [CONTEXT.md](CONTEXT.md) — locked purpose, vocabulary, flows, privacy, recovery, limits, and remaining live-verification questions. Read before changing product behavior.
- [README.md](README.md) — local-checkout loading, supported development baseline, user controls, FFmpeg, privacy, and local-test prerequisites. Read before changing setup or user-facing instructions.

## Integration boundaries

- **Registration / lazy runtime:** read [index.ts](index.ts), [src/index.ts](src/index.ts), and [src/startup-shortcut.ts](src/startup-shortcut.ts) before changing extension loading, shortcuts, commands, or lifecycle hooks. Registration must not initialize microphone/native capture.
- **Capture / recovery / editor destination:** read [src/runtime.ts](src/runtime.ts), [src/dictation-controller.ts](src/dictation-controller.ts), and [src/dictation-output.ts](src/dictation-output.ts) with CONTEXT's recovery and destination constraints before changing auto-paste, pending state, cancellation, or session teardown.
- **Local ASR / provider translation:** read [src/transcription-service.ts](src/transcription-service.ts) for retained local-model scheduling, and [src/translation-service.ts](src/translation-service.ts) for the separate isolated request, strict pre-disclosure output-cap checks with the documented Codex-only subscription exception, response validation, timeout, and priority queue. Read both before changing shared-resource scheduling; audio stays local while translated transcript text may leave the machine.
- **Configuration / UI:** read [src/settings.ts](src/settings.ts), [src/translation-settings.ts](src/translation-settings.ts), [src/settings-menu.ts](src/settings-menu.ts), [src/translation-settings-ui.ts](src/translation-settings-ui.ts), and [src/shortcuts.ts](src/shortcuts.ts) before changing targets, model selection, templates, collision checks, or reload behavior.
- **Isolated translation / conversational file output:** read [src/file-transcription.ts](src/file-transcription.ts) and [src/file-audio.ts](src/file-audio.ts) before changing `transcribe_file`, error hooks, usage, output truncation, temporary transcripts, FFmpeg, or decoded-audio limits. Original calls stay untranslated; explicit targets opt in. File output is not covered by memory-only dictation recovery.
- **Fork / upstream ownership:** read [package.json](package.json), [LICENSE](LICENSE), [src/settings-path.ts](src/settings-path.ts), and [src/models.ts](src/models.ts) before changing identity, compatibility, packaging, settings ownership, or caching. pi-shout replaces pi-voice; they share model cache, not mutable settings.
- **Local validation / live limits:** read [scripts/run-tests.mjs](scripts/run-tests.mjs), [test/extension-loader.test.ts](test/extension-loader.test.ts), [test/index-registration.test.ts](test/index-registration.test.ts), [test/runtime-translation.test.ts](test/runtime-translation.test.ts), [test/file-transcription.test.ts](test/file-transcription.test.ts), and [test/fixtures/translation-integration.ts](test/fixtures/translation-integration.ts) before changing verification instructions. Tests use mocked providers/audio, experimental module mocks, and test-only external `trash` cleanup; the loader test separately registers the real source extension through Pi 0.87.1 with isolated configuration and network access blocked. Live quality remains a separate check.

## External references

- CONTEXT's pinned upstream evidence identifies the reused pi-voice revision, not current-fork translation behavior. Read the matching upstream and local files before comparing or updating inherited functionality.
- For Pi SDK loading, read the installed `node_modules/@earendil-works/pi-coding-agent/docs/sdk.md`, `examples/sdk/06-extensions.ts`, and `dist/core/resource-loader.d.ts` (the latter two relative to that package). Use fresh isolated directories and `SettingsManager.inMemory` for local loader checks, not user configuration.
- Before changing provider calls or lifecycle handling, read that package's `docs/extensions.md`, `docs/models.md`, and `dist/core/extensions/types.d.ts`; before changing editor/recovery UI, read `docs/tui.md`. Development evidence is from pinned Pi 0.87.1. Local automated and registration checks do not establish live-provider, hardware, or newer-version compatibility.

## Architecture decisions

None recorded. Current choices were classified as reversible; no new ADR is needed merely to document implementation.

## Maintenance rules

- Keep implemented behavior, local verification, and deferred live validation distinct.
- Update CONTEXT when the product contract changes; do not silently weaken privacy, recovery, destination safety, or output ceilings, or extend the explicit Codex-only exception to other APIs.
- Add map entries only for real durable context boundaries or existing cross-cutting documents.
- Record integration constraints and unresolved verification questions with their next trigger; do not store transient progress, test counts, or raw transcripts here.
