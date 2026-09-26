import { test } from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";

import assert from "node:assert/strict";
import { createShortcutPicker } from "../src/shortcuts.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";
initTheme("dark");


test("translated reset uses its own default, never accepts original binding", () => {
  const results: string[] = [];
  const pane = createShortcutPicker(testTui(), testTheme(), keybindings(), "ctrl+alt+y", (value) => {
    if (value) results.push(value);
  }, { defaultShortcut: "ctrl+alt+t", forbiddenShortcuts: ["ctrl+alt+z", "ctrl+alt+s"] });
  pane.handleInput?.("d"); // default key (see keybindings)
  pane.handleInput?.("\r");
  assert.deepEqual(results, ["ctrl+alt+t"]);
  const collision = createShortcutPicker(testTui(), testTheme(), keybindings(), "ctrl+alt+y", (value) => {
    if (value) results.push(value);
  }, { defaultShortcut: "ctrl+alt+t", forbiddenShortcuts: ["ctrl+alt+t", "ctrl+alt+s"] });
  collision.handleInput?.("d");
  collision.handleInput?.("\r");
  assert.deepEqual(results, ["ctrl+alt+t"]);
});

test("original default cannot collide with translated binding", () => {
  const results: string[] = [];
  const pane = createShortcutPicker(testTui(), testTheme(), keybindings(), "ctrl+alt+x", (value) => {
    if (value) results.push(value);
  }, { forbiddenShortcuts: ["ctrl+alt+z", "ctrl+alt+s"] });
  pane.handleInput?.("d");
  pane.handleInput?.("\r");
  assert.deepEqual(results, []);
});
