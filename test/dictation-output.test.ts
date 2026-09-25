import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { DictationDestination, safeEditorText } from '../src/dictation-output.js';

test('destination blocks edits even after revert, branch/session change and unavailable observations', () => {
  let text = 'draft'; let session = 'one'; let leaf: string | null = 'a'; let input: ((data: string) => void) | undefined;
  const ctx = { mode: 'tui', hasUI: true, ui: { getEditorText: () => text, onTerminalInput: (handler: (data: string) => void) => { input = handler; return () => { input = undefined; }; } },
    sessionManager: { getSessionId: () => session, getLeafId: () => leaf } } as unknown as ExtensionContext;
  const guard = new DictationDestination(ctx);
  assert.equal(guard.unchanged(), true);
  text = 'changed'; assert.equal(guard.unchanged(), false);
  text = 'draft'; input?.('x'); assert.equal(guard.unchanged(), false);
  guard.dispose(); assert.equal(input, undefined);
  const branchGuard = new DictationDestination(ctx);
  leaf = 'b'; assert.equal(branchGuard.unchanged(), false);
  leaf = 'a'; session = 'two'; assert.equal(branchGuard.unchanged(), false);
  branchGuard.dispose();
  assert.equal(new DictationDestination({ ...ctx, hasUI: false } as ExtensionContext).unchanged(), false);
  assert.equal(new DictationDestination({ ...ctx, mode: 'rpc', hasUI: true } as ExtensionContext).unchanged(), false);
});

test('destination ignores key releases but not presses, repeats, cursor movement or paste', () => {
  let input: ((data: string) => unknown) | undefined;
  const ctx = { mode: 'tui', hasUI: true,
    ui: { getEditorText: () => 'draft', onTerminalInput: (handler: (data: string) => unknown) => {
      input = handler; return () => { input = undefined; };
    } },
    sessionManager: { getSessionId: () => 'session', getLeafId: () => 'leaf' },
  } as unknown as ExtensionContext;
  for (const [data, unchanged] of [
    ['\u001b[116;7:3u', true], // Ctrl+Alt+T release
    ['\u001b[122;7:3u', true], // Ctrl+Alt+Z release
    ['\u001b[57442;1:3u', true], // Modifier release
    ['\u001b[1;1:3D', true], // Cursor-key release
    ['x', false],
    ['\u001b[116;7:1u', false], // Press
    ['\u001b[116;7:2u', false], // Repeat
    ['\u001b[D', false],
    ['\u001b[200~paste containing :3u\u001b[201~', false],
  ] as const) {
    const guard = new DictationDestination(ctx);
    assert.equal(input?.(data), undefined, 'The guard never consumes terminal input');
    assert.equal(guard.unchanged(), unchanged, JSON.stringify(data));
    input?.('x');
    input?.('\u001b[116;7:3u');
    assert.equal(guard.unchanged(), false, 'A release must not clear prior dirty state');
    guard.dispose();
    assert.equal(input, undefined);
  }
});

test('unsafe controls, including bracketed paste terminators, never reach editor', () => {
  assert.equal(safeEditorText('你好 English\n'), true);
  for (const value of ['bad\u001b[201~injection', '\u0000', '\u009b']) assert.equal(safeEditorText(value), false);
});
