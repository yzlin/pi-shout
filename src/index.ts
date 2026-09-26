import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { registerFileTranscriptionTool } from "./file-transcription.js";
import type { PiVoiceRuntime } from "./runtime.js";
import { displayShortcut, STATUS_WIDGET_KEY } from "./shortcut-core.js";
import { initLog, log, logStep, markKeyPress, watchEventLoop } from "./log.js";
import { logPath, settingsPath } from "./settings-path.js";
import { readShortcutsForRegistration } from "./startup-shortcut.js";

// Pi awaits extension module evaluation before continuing startup. Keep this
// entry point registration-only and load feature implementations on first use.
export default function piVoice(pi: ExtensionAPI): void {
  // Opens nothing yet: the first line written creates the file.
  initLog({ path: logPath(), level: process.env.PI_VOICE_DEBUG === "1" ? "debug" : "info" });
  const {
    original: registeredShortcut,
    translated: registeredTranslationShortcut,
    swap: registeredSwapShortcut,
  } = readShortcutsForRegistration();
  let runtimePromise: Promise<PiVoiceRuntime> | undefined;
  let shuttingDown = false;

  function loadRuntime(): Promise<PiVoiceRuntime> {
    if (shuttingDown) return Promise.reject(new Error("Pi Voice is shutting down"));
    if (runtimePromise) return runtimePromise;

    const loadStarted = performance.now();
    logStep("loading runtime");
    const loading = import("./runtime.js").then(({ createPiVoiceRuntime }) => {
      log.debug(`runtime loaded in ${Math.round(performance.now() - loadStarted)} ms`);
      return createPiVoiceRuntime(pi, registeredShortcut, registeredTranslationShortcut, registeredSwapShortcut);
    });
    runtimePromise = loading;
    void loading.catch(() => {
      if (runtimePromise === loading) runtimePromise = undefined;
    });
    return loading;
  }

  pi.on("session_start", async (_event, ctx) => {
    const runtime = await runtimePromise?.catch(() => undefined);
    runtime?.invalidate();
    if (!existsSync(settingsPath())) {
      ctx.ui.notify(
        `Pi Shout installed · press ${displayShortcut(registeredShortcut)} or run /voice-settings to set up`,
        "info",
      );
    }
  });

  const fileTranscription = registerFileTranscriptionTool(pi, {
    getSettings: async () => (await loadRuntime()).requireConfiguredSettingsForTool(),
    getService: async () => (await loadRuntime()).service,
    getTranslationService: async () => (await loadRuntime()).translationService,
  });

  pi.registerShortcut(
    registeredShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
    {
      description: "Toggle microphone transcription",
      handler: async (ctx) => {
        markKeyPress();
        const release = watchEventLoop();
        // The first press pays deferred module loading before the runtime can
        // show anything; paint feedback synchronously. Later presses reach the
        // memoized runtime in a microtask and it paints its own status.
        if (!runtimePromise && ctx.hasUI) {
          ctx.ui.setWidget(STATUS_WIDGET_KEY, [
            ctx.ui.theme.fg("muted", "Starting microphone…"),
          ]);
        }
        try {
          await (await loadRuntime()).toggleCapture(ctx);
        } catch (error) {
          if (ctx.hasUI) ctx.ui.setWidget(STATUS_WIDGET_KEY, undefined);
          throw error;
        } finally {
          release();
        }
      },
    },
  );

  pi.registerShortcut(registeredTranslationShortcut as Parameters<ExtensionAPI['registerShortcut']>[0], {
    description: 'Toggle translated microphone dictation',
    handler: async (ctx) => (await loadRuntime()).toggleCapture(ctx, 'translated'),
  });

  pi.registerShortcut(registeredSwapShortcut as Parameters<ExtensionAPI['registerShortcut']>[0], {
    description: 'Swap translated dictation draft',
    handler: async (ctx) => {
      const runtime = await runtimePromise?.catch(() => undefined);
      runtime?.swap(ctx);
    },
  });

  const openSettings = async (
    _args: string,
    ctx: ExtensionCommandContext,
  ): Promise<void> => (await loadRuntime()).showSettings(ctx);

  pi.registerCommand("voice-settings", {
    description: "Open Pi Shout settings",
    handler: openSettings,
  });
  pi.registerCommand("transcribe", {
    description: "Open Pi Shout settings (alias for /voice-settings)",
    handler: openSettings,
  });

  pi.registerCommand('voice-recover', {
    description: 'Resolve a pending dictation result',
    handler: async (_args, ctx) => (await loadRuntime()).recover(ctx),
  });

  if (process.env.PI_VOICE_DEBUG === "1") {
    pi.registerCommand("voice-onboarding", {
      description: "Replay Pi Shout onboarding (debug)",
      handler: async (_args, ctx) => (await loadRuntime()).replayOnboarding(ctx),
    });
  }

  const invalidateRuntime = async () => { const runtime = await runtimePromise?.catch(() => undefined); runtime?.invalidate(); };
  pi.on('session_before_switch', invalidateRuntime);
  pi.on('session_before_fork', invalidateRuntime);
  pi.on('session_before_tree', invalidateRuntime);
  pi.on('session_tree', invalidateRuntime);
  pi.on("session_shutdown", async (_event, ctx) => {
    shuttingDown = true;
    const loading = runtimePromise;
    const runtime = await loading?.catch(() => undefined);
    // Abort the shared provider lane before waiting for queued file operations.
    const runtimeShutdown = runtime?.shutdown(ctx).catch(() => undefined);
    await Promise.all([fileTranscription.shutdown().catch(() => undefined), runtimeShutdown]);
  });
}
