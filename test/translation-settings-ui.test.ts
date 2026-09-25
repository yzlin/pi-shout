import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { chooseTranslationTarget, chooseTranslationModel, editTranslationPrompt } from "../src/translation-settings-ui.js";
import { defaultTranslationSettings, DEFAULT_TRANSLATION_PROMPT } from "../src/translation-settings.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";
initTheme("dark");


function context(input: (pane: Component) => void, editor?: () => string | undefined) {
  const notices: string[] = [];
  const ctx = {
    modelRegistry: { getAvailable: () => [{ provider: "mock", id: "translator" }] },
    ui: {
      custom: async (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => {
        let selected: unknown;
        const pane = await factory(testTui(), testTheme(), keybindings() as Parameters<typeof factory>[2], (value) => { selected = value; });
        input(pane);
        pane.dispose?.();
        return selected;
      },
      editor: async () => editor?.(),
      notify: (message: string) => { notices.push(message); },
    },
  } as unknown as ExtensionContext;
  return { ctx, notices };
}

test("target picker is searchable, includes locale tags, and can unset target", async () => {
  const current = defaultTranslationSettings();
  const { ctx } = context((pane) => { pane.handleInput?.("taiwan"); pane.handleInput?.("\r"); });
  const chosen = await chooseTranslationTarget(ctx, current);
  assert.equal(chosen?.targetLanguage, "zh-TW");
  const reset = context((pane) => { pane.handleInput?.("no target"); pane.handleInput?.("\r"); });
  assert.equal((await chooseTranslationTarget(reset.ctx, chosen!))?.targetLanguage, undefined);
  const cancel = context((pane) => { pane.handleInput?.("\x1b"); });
  assert.equal(await chooseTranslationTarget(cancel.ctx, current), undefined);
});

test("model picker explains the Codex-only output ceiling exception", async () => {
  let rendered = "";
  const picker = context((pane) => {
    rendered = pane.render(100).join("\n");
    pane.handleInput?.("\x1b");
  });
  await chooseTranslationModel(picker.ctx, defaultTranslationSettings());
  assert.match(rendered.replace(/\s+/gu, ' '), /Codex uses Pi login; no hard output cap/iu);
});

test("model picker saves an available override and explicitly resets to current chat model", async () => {
  const current = defaultTranslationSettings();
  const picker = context((pane) => { pane.handleInput?.("\x1b[B"); pane.handleInput?.("\r"); });
  const selected = await chooseTranslationModel(picker.ctx, current);
  assert.deepEqual(selected?.model, { provider: "mock", id: "translator" });
  const reset = context((pane) => { pane.handleInput?.("\x1b[A"); pane.handleInput?.("\r"); });
  assert.equal((await chooseTranslationModel(reset.ctx, selected!))?.model, undefined);
});

test("instructions edit, reset, cancel, and invalid placeholders do not save", async () => {
  const current = defaultTranslationSettings();
  const edited = context((pane) => pane.handleInput?.("\r"), () => "Translate to {targetLanguage}.\nKeep names.");
  const saved = await editTranslationPrompt(edited.ctx, current);
  assert.equal(saved?.prompt, "Translate to {targetLanguage}.\nKeep names.");
  const reset = context((pane) => { pane.handleInput?.("\x1b[B"); pane.handleInput?.("\r"); });
  assert.equal((await editTranslationPrompt(reset.ctx, saved!))?.prompt, DEFAULT_TRANSLATION_PROMPT);
  const cancelled = context((pane) => pane.handleInput?.("\x1b"));
  assert.equal(await editTranslationPrompt(cancelled.ctx, current), undefined);
  for (const invalid of ["  ", "Translate {text}", "Translate {targetLanguage} {text}"]) {
    const testCtx = context((pane) => pane.handleInput?.("\r"), () => invalid);
    assert.equal(await editTranslationPrompt(testCtx.ctx, current), undefined);
    assert.equal(testCtx.notices.length, 1);
  }
});
