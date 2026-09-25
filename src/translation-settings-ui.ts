import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SingleSelectPicker, type SingleSelectChoice } from "./ui-components.js";
import { createShortcutPicker } from "./shortcuts.js";
import { displayShortcut } from "./shortcut-core.js";
import {
  DEFAULT_TRANSLATION_PROMPT, DEFAULT_TRANSLATION_SHORTCUT,
  TARGET_LANGUAGES, validateTranslationPrompt, type TranslationSettings,
} from "./translation-settings.js";

type ModelChoice = { provider: string; id: string };
const INHERIT = "__inherit__";
const UNSET = "__unset__";

export function targetName(tag: string): string {
  return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
}

/** Undefined means cancelled; unset is represented by a settings object without a target. */
export async function chooseTranslationTarget(
  ctx: ExtensionContext, current: TranslationSettings,
): Promise<TranslationSettings | undefined> {
  const choices: SingleSelectChoice<string>[] = [
    { value: UNSET, label: "No target (translated dictation unavailable)", description: "Choose a target before using translated dictation" },
    ...TARGET_LANGUAGES.map((tag) => ({ value: tag, label: `${targetName(tag)} (${tag})` })),
  ];
  const selected = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) =>
    new SingleSelectPicker(tui, theme, keys, choices, current.targetLanguage ?? UNSET,
      { title: "Translation target language", searchable: true, cancelLabel: "back" }, done));
  if (selected === undefined) return undefined;
  if (selected === UNSET) {
    const { targetLanguage: _removed, ...rest } = current;
    return rest;
  }
  return { ...current, targetLanguage: selected };
}

export async function chooseTranslationModel(
  ctx: ExtensionContext, current: TranslationSettings,
): Promise<TranslationSettings | undefined> {
  const models = ctx.modelRegistry.getAvailable();
  const supportNotice = "Codex uses Pi login; no hard output cap. Other adapters must support an output ceiling.";
  const choices: SingleSelectChoice<string>[] = [
    { value: INHERIT, label: "Current chat model (reset override)", description: `Inherit the current Pi model for each request. ${supportNotice}` },
    ...models.map((model) => ({
      value: JSON.stringify([model.provider, model.id]),
      label: `${model.provider} / ${model.id}`,
      description: supportNotice,
    })),
  ];
  const selected = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) =>
    new SingleSelectPicker(tui, theme, keys, choices,
      current.model ? JSON.stringify([current.model.provider, current.model.id]) : INHERIT,
      { title: "Translation model", searchable: true, cancelLabel: "back" }, done));
  if (selected === undefined) return undefined;
  if (selected === INHERIT) {
    const { model: _removed, ...rest } = current;
    return rest;
  }
  const model = models.find((candidate) => JSON.stringify([candidate.provider, candidate.id]) === selected);
  if (!model) return undefined;
  const override: ModelChoice = { provider: model.provider, id: model.id };
  return { ...current, model: override };
}

export async function editTranslationPrompt(
  ctx: ExtensionContext, current: TranslationSettings,
): Promise<TranslationSettings | undefined> {
  const action = await ctx.ui.custom<"edit" | "reset" | undefined>((tui, theme, keys, done) =>
    new SingleSelectPicker(tui, theme, keys, [
      { value: "edit", label: "Edit instructions", description: "Transcript is supplied separately; use literal {targetLanguage} for the target" },
      { value: "reset", label: "Reset to default", description: "Faithful, natural translation without answering speech" },
    ], "edit", { title: "Translation instructions", cancelLabel: "back" }, done));
  if (action === undefined) return undefined;
  if (action === "reset") return { ...current, prompt: DEFAULT_TRANSLATION_PROMPT };
  const prompt = await ctx.ui.editor("Translation instructions — use {targetLanguage}; transcript supplied separately", current.prompt);
  if (prompt === undefined) return undefined;
  if (!validateTranslationPrompt(prompt)) {
    ctx.ui.notify("Instructions must contain {targetLanguage}, not be blank, and have no unknown placeholders (e.g. {text}).", "error");
    return undefined;
  }
  return { ...current, prompt };
}

export async function chooseTranslationShortcut(
  ctx: ExtensionContext, current: TranslationSettings, originalShortcut: string,
): Promise<TranslationSettings | undefined> {
  const shortcut = await ctx.ui.custom<string | undefined>((tui, theme, keys, done) =>
    createShortcutPicker(tui, theme, keys, current.shortcut, done,
      { defaultShortcut: DEFAULT_TRANSLATION_SHORTCUT, forbiddenShortcut: originalShortcut }));
  return shortcut ? { ...current, shortcut } : undefined;
}

export function translationModelSummary(settings: TranslationSettings): string {
  return settings.model ? `${settings.model.provider} / ${settings.model.id}` : "Current chat model";
}

export function translationShortcutSummary(settings: TranslationSettings): string {
  return displayShortcut(settings.shortcut);
}
