import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piVoice from "../src/index.js";
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

function registeredCommands(debug: string | undefined): string[] {
  const previous = process.env.PI_VOICE_DEBUG;
  if (debug === undefined) delete process.env.PI_VOICE_DEBUG;
  else process.env.PI_VOICE_DEBUG = debug;

  const commands: string[] = [];
  const pi = {
    on() {},
    registerTool() {},
    registerShortcut() {},
    registerCommand(name: string) { commands.push(name); },
  } as unknown as ExtensionAPI;

  try {
    piVoice(pi);
  } finally {
    if (previous === undefined) delete process.env.PI_VOICE_DEBUG;
    else process.env.PI_VOICE_DEBUG = previous;
  }
  return commands;
}

test("registers voice settings and recovery without consuming the reserved voice command", () => {
  assert.deepEqual(registeredCommands(undefined), ["voice-settings", "transcribe", "voice-recover"]);
});

test("the renamed debug flag registers only the renamed onboarding command", () => {
  assert.deepEqual(registeredCommands("1"), [
    "voice-settings",
    "transcribe",
    "voice-recover",
    "voice-onboarding",
  ]);
});

test("foreign settings do not suppress first-run setup notice", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-shout-startup-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, "pi-voice.json"), "{}\n");
  await writeFile(join(directory, "pi-transcribe.json"), "{}\n");

  let start: (() => Promise<void>) | undefined;
  const notices: string[] = [];
  const pi = {
    on(event: string, handler: (_event: unknown, ctx: unknown) => Promise<void>) {
      if (event === "session_start") {
        start = () => handler({}, { mode: "tui", ui: { notify: (text: string) => notices.push(text) } });
      }
    },
    registerTool() {},
    registerShortcut() {},
    registerCommand() {},
  } as unknown as ExtensionAPI;
  piVoice(pi);
  assert.ok(start);
  await start();
  assert.equal(notices.length, 1);
  assert.match(notices[0]!, /Pi Shout installed/);
});

test('registers both recording modes, without registering /voice', () => {
  const shortcuts: string[] = [];
  const pi = {
    on() {}, registerTool() {}, registerCommand() {},
    registerShortcut(key: string) { shortcuts.push(key); },
  } as unknown as ExtensionAPI;
  piVoice(pi);
  assert.deepEqual(shortcuts, ['ctrl+alt+z', 'ctrl+alt+t']);
});

test('colliding persisted shortcuts fall back to two distinct defaults', async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'pi-shout-shortcut-test-'));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  await writeFile(join(directory, 'pi-shout.json'), JSON.stringify({
    version: 1,
    shortcut: 'ctrl+alt+t',
    translation: { shortcut: 'ctrl+alt+t', prompt: 'Translate to {targetLanguage}' },
  }));
  const shortcuts: string[] = [];
  const pi = {
    on() {}, registerTool() {}, registerCommand() {},
    registerShortcut(key: string) { shortcuts.push(key); },
  } as unknown as ExtensionAPI;
  piVoice(pi);
  assert.deepEqual(shortcuts, ['ctrl+alt+z', 'ctrl+alt+t']);
  assert.equal(new Set(shortcuts).size, 2);
});

test('isolated extension uses one runtime/service, refreshes retry settings, and wires every invalidation hook', { timeout: 10000 }, async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    '--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/index-integration.js', import.meta.url)),
  ], { timeout: 8000 });
  assert.match(stdout, /index wiring, settings-cache retry, lifecycle hooks verified/);
});

test("the old debug flag is not a compatibility alias", () => {
  const previous = process.env.PI_TRANSCRIBE_DEBUG;
  process.env.PI_TRANSCRIBE_DEBUG = "1";
  try {
    assert.deepEqual(registeredCommands(undefined), ["voice-settings", "transcribe", "voice-recover"]);
  } finally {
    if (previous === undefined) delete process.env.PI_TRANSCRIBE_DEBUG;
    else process.env.PI_TRANSCRIBE_DEBUG = previous;
  }
});
