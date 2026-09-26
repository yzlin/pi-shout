import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { renderDictationPreview } from '../src/dictation-preview.js';

test('dictation preview sanitizes controls and limits wrapped CJK text to three rows', () => {
  const lines = renderDictationPreview(8, {
    label: 'Original',
    text: '你好世界你好世界\u001b[31m危險\u0007繼續內容',
    hint: 'Ctrl+Alt+S to swap',
  });
  assert.equal(lines.length, 5);
  assert.equal(lines[3]?.endsWith('…'), true);
  assert.equal(stripTerminalSequences(lines.join('')).includes('[31m'), false);
  assert.equal(lines.join('').includes('\u0007'), false);
  assert.equal(lines.every(line => visibleWidth(line) <= 8), true);
});

test('dictation preview remains width-safe at a one-column viewport', () => {
  const lines = renderDictationPreview(1, { label: 'Original', text: '中文abc', hint: 'swap' });
  assert.equal(lines.every(line => visibleWidth(line) <= 1), true);
  assert.equal(lines.filter(line => line === '…').length, 1);
});
