import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsForModel } from '../src/settings.js';
import { normalizeTargetLanguage, normalizeTranslationSettings, translationInstructions, validateTranslationPrompt } from '../src/translation-settings.js';

test('translation defaults are separate and validated when constructing settings', () => {
  const settings = settingsForModel('parakeet-unified-en-0.6b', '/tmp/model');
  assert.equal(settings.translation.shortcut, 'ctrl+alt+t');
  assert.equal(settings.translation.swapShortcut, 'ctrl+alt+s');
  assert.equal(settings.translation.targetLanguage, undefined);
  assert.match(settings.translation.prompt, /\{targetLanguage\}/);
});

test('validates and clones translation configuration, shortcuts and locale independently', () => {
  const original = { shortcut: 'Alt+Ctrl+T', swapShortcut: 'Ctrl+Alt+S', targetLanguage: 'ZH-tw', model: { provider: 'demo', id: 'model' }, prompt: 'Translate to {targetLanguage}. Plain text.' };
  const { swapShortcut: _legacyMissingSwap, ...legacy } = original;
  const settings = settingsForModel('parakeet-unified-en-0.6b', '/tmp/model', { translation: original });
  assert.deepEqual(settings.translation, { ...original, shortcut: 'ctrl+alt+t', swapShortcut: 'ctrl+alt+s', targetLanguage: 'zh-TW' });
  original.model.id = 'changed';
  assert.equal(settings.translation.model?.id, 'model');
  assert.equal(normalizeTargetLanguage('zh-CN'), undefined);
  assert.equal(normalizeTargetLanguage('en-US'), undefined);
  assert.equal(normalizeTargetLanguage('ja'), 'ja');
  assert.equal(validateTranslationPrompt('translate to {targetLanguage} {text}'), false);
  assert.equal(validateTranslationPrompt('translate to {targetLanguage} {model-id}'), false);
  assert.equal(validateTranslationPrompt('translate to {targetLanguage} ordinary prose'), true);
  assert.match(translationInstructions('To {targetLanguage}', 'ja'), /Japanese \(ja\)/);
  assert.equal(normalizeTranslationSettings({ ...original, shortcut: 'CTRL+ALT+Z' })?.shortcut, 'ctrl+alt+z');
  assert.equal(normalizeTranslationSettings({ ...legacy, shortcut: 'CTRL+ALT+Z' })?.swapShortcut, 'ctrl+alt+s');
  assert.equal(normalizeTranslationSettings({ ...legacy, shortcut: 'CTRL+ALT+S' }, 'ctrl+alt+z')?.swapShortcut, 'ctrl+alt+d');
  assert.equal(normalizeTranslationSettings({ ...legacy, shortcut: 'CTRL+ALT+D' }, 'ctrl+alt+s')?.swapShortcut, 'ctrl+alt+w');
  assert.equal(normalizeTranslationSettings({ ...original, shortcut: 'CTRL+ALT+Z' }, 'ctrl+alt+z'), undefined);
  assert.equal(normalizeTranslationSettings({ ...original, shortcut: 'CTRL+ALT+Z', swapShortcut: 'ctrl+alt+z' }), undefined);
  assert.equal(normalizeTranslationSettings({ ...original, shortcut: 'CTRL+ALT+Z', swapShortcut: 'ctrl+alt+x' }, 'ctrl+alt+x'), undefined);
  assert.throws(() => settingsForModel('parakeet-unified-en-0.6b', '/tmp/model', { shortcut: 'ctrl+alt+z', translation: { ...original, shortcut: 'CTRL+ALT+Z' } }));
  assert.throws(() => settingsForModel('parakeet-unified-en-0.6b', '/tmp/model', { translation: { ...original, prompt: 'bad {text}' } }));
});
