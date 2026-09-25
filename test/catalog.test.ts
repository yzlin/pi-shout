import assert from "node:assert/strict";
import { readFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import source from "../catalog/catalog.json" with { type: "json" };
import benchmark from "../catalog/recommendations.json" with { type: "json" };
import { CATALOG_MODELS } from "../src/catalog.js";
import { readSettings, settingsForModel, writeSettings } from "../src/settings.js";
import { readShortcutsForRegistration } from "../src/startup-shortcut.js";

test("generated catalog matches its source and benchmarks contain no stale model IDs", () => {
  assert.deepEqual(CATALOG_MODELS, source.models);
  const ids = new Set(CATALOG_MODELS.map((model) => model.id));
  assert.equal(ids.size, CATALOG_MODELS.length);
  for (const id of Object.keys(benchmark.models)) {
    assert.ok(ids.has(id), `Stale benchmark: ${id}`);
  }
});

test("an unknown saved model requests reconfiguration without rewriting settings", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-shout-retired-model-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const current = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model");
  const saved = { ...current, model: { ...current.model, id: "retired-model" } };
  await writeSettings(saved);

  const result = await readSettings();
  assert.equal(result.settings, undefined);
  assert.match(result.warning ?? "", /configuration is required/);
  const onDisk = JSON.parse(
    await readFile(join(directory, "pi-shout.json"), "utf8"),
  ) as unknown;
  assert.deepEqual(onDisk, saved);
});

test("startup preserves a custom original shortcut when translation settings are absent", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-shout-legacy-translation-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const settings = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+x",
  });
  const { translation: _translation, ...legacySettings } = settings;
  await writeFile(join(directory, "pi-shout.json"), `${JSON.stringify(legacySettings)}\n`);

  assert.deepEqual(readShortcutsForRegistration(), {
    original: "ctrl+alt+x",
    translated: "ctrl+alt+t",
  });
  assert.deepEqual((await readSettings()).settings, settings);
});

test("foreign voice and transcribe settings are neither loaded nor modified", async (t) => {
  const previous = process.env.PI_CODING_AGENT_DIR;
  const directory = await mkdtemp(join(tmpdir(), "pi-shout-isolation-test-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });

  const foreign = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+x",
  });
  const content = `${JSON.stringify(foreign)}\n`;
  for (const name of ["pi-voice.json", "pi-transcribe.json"]) {
    await writeFile(join(directory, name), content);
  }

  assert.equal(readShortcutsForRegistration().original, "ctrl+alt+z");
  assert.deepEqual(await readSettings(), {});
  await assert.rejects(readFile(join(directory, "pi-shout.json"), "utf8"), { code: "ENOENT" });

  const own = settingsForModel("parakeet-unified-en-0.6b", "/tmp/model", {
    shortcut: "ctrl+alt+y",
  });
  await writeSettings(own);
  assert.equal(readShortcutsForRegistration().original, "ctrl+alt+y");
  assert.deepEqual(readShortcutsForRegistration(), { original: 'ctrl+alt+y', translated: 'ctrl+alt+t' });
  assert.deepEqual((await readSettings()).settings, own);
  await writeSettings({ ...own, translation: { ...own.translation, shortcut: 'ctrl+alt+r', targetLanguage: 'en' } });
  assert.deepEqual(readShortcutsForRegistration(), { original: 'ctrl+alt+y', translated: 'ctrl+alt+r' });
  await writeSettings({ ...own, translation: { ...own.translation, shortcut: 'ctrl+alt+y' } });
  assert.equal(readShortcutsForRegistration().translated, 'ctrl+alt+t');
  for (const name of ["pi-voice.json", "pi-transcribe.json"]) {
    assert.equal(await readFile(join(directory, name), "utf8"), content);
  }
});
