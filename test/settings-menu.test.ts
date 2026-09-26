import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { showSettingsMenu, shortcutSettingsNeedReload } from "../src/settings-menu.js";
import { readSettings, settingsForModel, writeSettings, type TranscribeSettings } from "../src/settings.js";
import { DEFAULT_TRANSLATION_PROMPT } from "../src/translation-settings.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

function isolatedSettings(t: TestContext): void {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = mkdtempSync(join(tmpdir(), "pi-shout-settings-menu-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(directory, { recursive: true, force: true });
  });
}

function settings(): TranscribeSettings {
  return settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+z",
    preferredLanguages: ["en"],
    translation: {
      shortcut: "ctrl+alt+t",
      swapShortcut: "ctrl+alt+s",
      prompt: DEFAULT_TRANSLATION_PROMPT,
    },
  });
}

function scriptedContext(results: unknown[], editors: (string | undefined)[] = []) {
  let index = 0;
  let editorIndex = 0;
  const notices: string[] = [];
  const ctx = {
    mode: "tui",
    modelRegistry: {
      getAvailable: () => [{ provider: "mock", id: "translator" }],
    },
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        let selected: unknown;
        const pane = await factory(
          testTui(),
          testTheme(),
          keybindings() as Parameters<typeof factory>[2],
          (value) => { selected = value; },
        );
        const scripted = results[index++];
        if (typeof scripted === "function") scripted(pane);
        else selected = scripted;
        pane.dispose?.();
        return selected;
      },
      editor: async () => editors[editorIndex++],
      notify: (message: string) => { notices.push(message); },
    },
  } as unknown as ExtensionContext;
  return { ctx, notices, assertFinished: () => assert.equal(index, results.length) };
}

const pi = {} as ExtensionAPI;
const permissionProbe = async () => ({ status: "granted" as const });

test("settings workflow persists target, model, custom prompt, and translated shortcut", async (t) => {
  isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const script = scriptedContext([
    "translation-target", "zh-TW",
    "translation-model", JSON.stringify(["mock", "translator"]),
    "translation-prompt", "edit",
    "translation-shortcut", "ctrl+alt+r",
    "translation-swap-shortcut", "ctrl+alt+w",
    undefined,
  ], ["Translate into {targetLanguage}. Keep identifiers unchanged."]);

  assert.equal(await showSettingsMenu(
    pi, script.ctx, configured, "ctrl+alt+z", "ctrl+alt+t", "ctrl+alt+s", permissionProbe,
  ), true);
  script.assertFinished();

  const reloaded = (await readSettings()).settings;
  assert.equal(reloaded?.translation.targetLanguage, "zh-TW");
  assert.deepEqual(reloaded?.translation.model, { provider: "mock", id: "translator" });
  assert.equal(reloaded?.translation.prompt, "Translate into {targetLanguage}. Keep identifiers unchanged.");
  assert.equal(reloaded?.translation.shortcut, "ctrl+alt+r");
  assert.equal(reloaded?.translation.swapShortcut, "ctrl+alt+w");
});

test("settings workflow persists prompt reset", async (t) => {
  isolatedSettings(t);
  const configured = settings();
  configured.translation.prompt = "Custom {targetLanguage}";
  await writeSettings(configured);
  const script = scriptedContext([
    "translation-prompt", "reset", undefined,
  ]);

  await showSettingsMenu(pi, script.ctx, configured, configured.shortcut, configured.translation.shortcut, configured.translation.swapShortcut, permissionProbe);
  script.assertFinished();
  assert.equal((await readSettings()).settings?.translation.prompt, DEFAULT_TRANSLATION_PROMPT);
});

test("cancelled and invalid translation edits leave saved settings unchanged", async (t) => {
  isolatedSettings(t);
  const configured = settings();
  await writeSettings(configured);
  const script = scriptedContext([
    "translation-target", undefined,
    "translation-prompt", "edit",
    undefined,
  ], ["Translate {text}"]);

  assert.equal(await showSettingsMenu(
    pi, script.ctx, configured, configured.shortcut, configured.translation.shortcut, configured.translation.swapShortcut, permissionProbe,
  ), false);
  script.assertFinished();
  assert.deepEqual((await readSettings()).settings, settings());
  assert.match(script.notices.join("\n"), /must contain \{targetLanguage\}/u);
});

test("reload remains required until all shortcut registrations match", () => {
  const configured = settings();
  assert.equal(shortcutSettingsNeedReload(configured, "ctrl+alt+z", "ctrl+alt+t", "ctrl+alt+s"), false);

  configured.shortcut = "ctrl+alt+x";
  assert.equal(shortcutSettingsNeedReload(configured, "ctrl+alt+z", "ctrl+alt+t"), true);

  configured.translation.shortcut = "ctrl+alt+r";
  assert.equal(shortcutSettingsNeedReload(configured, "ctrl+alt+z", "ctrl+alt+t"), true);

  configured.shortcut = "ctrl+alt+z";
  assert.equal(shortcutSettingsNeedReload(configured, "ctrl+alt+z", "ctrl+alt+t"), true);

  configured.translation.shortcut = "ctrl+alt+t";
  assert.equal(shortcutSettingsNeedReload(configured, "ctrl+alt+z", "ctrl+alt+t", "ctrl+alt+s"), false);

  configured.translation.swapShortcut = "ctrl+alt+w";
  assert.equal(shortcutSettingsNeedReload(configured, "ctrl+alt+z", "ctrl+alt+t", "ctrl+alt+s"), true);
});
