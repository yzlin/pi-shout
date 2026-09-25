import { readFileSync } from 'node:fs';
import { DEFAULT_SHORTCUT, normalizeShortcut } from './shortcut-core.js';
import { settingsPath } from './settings-path.js';
import { DEFAULT_TRANSLATION_SHORTCUT, defaultTranslationSettings, normalizeTranslationSettings } from './translation-settings.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Synchronous, lightweight startup read; no model or native imports. */
export function readShortcutsForRegistration(): { original: string; translated: string } {
  const defaults = { original: DEFAULT_SHORTCUT, translated: DEFAULT_TRANSLATION_SHORTCUT };
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'));
    if (!isObject(parsed) || parsed.version !== 1 || typeof parsed.shortcut !== 'string') return defaults;
    const original = normalizeShortcut(parsed.shortcut);
    const translation = parsed.translation === undefined ? defaultTranslationSettings() : parsed.translation;
    const translated = original && normalizeTranslationSettings(translation, original)?.shortcut;
    // A partially valid pair is unsafe at registration time: falling back only
    // one side can still collide with the other default.
    if (!original || !translated || translated === original) return defaults;
    return { original, translated };
  } catch { return defaults; }
}
