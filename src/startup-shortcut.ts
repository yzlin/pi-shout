import { readFileSync } from 'node:fs';
import { DEFAULT_SHORTCUT, normalizeShortcut } from './shortcut-core.js';
import { settingsPath } from './settings-path.js';
import { DEFAULT_TRANSLATION_SHORTCUT, DEFAULT_TRANSLATION_SWAP_SHORTCUT, defaultTranslationSettings, normalizeTranslationSettings } from './translation-settings.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Synchronous, lightweight startup read; no model or native imports. */
export function readShortcutsForRegistration(): { original: string; translated: string; swap: string } {
  const defaults = {
    original: DEFAULT_SHORTCUT,
    translated: DEFAULT_TRANSLATION_SHORTCUT,
    swap: DEFAULT_TRANSLATION_SWAP_SHORTCUT,
  };
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.shortcut !== 'string') return defaults;
    const original = normalizeShortcut(parsed.shortcut);
    const translation = parsed.translation === undefined ? defaultTranslationSettings(original) : parsed.translation;
    const normalizedTranslation = original && normalizeTranslationSettings(translation, original);
    // A partially valid set is unsafe at registration time: falling back only
    // one binding can still collide with another default.
    if (!original || !normalizedTranslation) return defaults;
    return {
      original,
      translated: normalizedTranslation.shortcut,
      swap: normalizedTranslation.swapShortcut,
    };
  } catch { return defaults; }
}
