import { test } from "node:test";
import assert from "node:assert/strict";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  paneRowBudget,
  SingleSelectPicker,
  selectedWindow,
  windowSizeForBudget,
} from "../src/ui-components.js";
import { keybindings, testTheme, testTui } from "./ui-helpers.js";

initTheme("dark");

test("pane sizing reserves host rows and centers the selected window", () => {
  assert.equal(paneRowBudget(testTui(24)), 22);
  assert.equal(paneRowBudget(testTui()), undefined);
  assert.equal(windowSizeForBudget(5, 10), 5);
  assert.equal(windowSizeForBudget(20, 10), 10);
  assert.deepEqual(selectedWindow(Array.from({ length: 20 }), 10, 5), [8, 13]);
});

test("single-select pickers move with j/k unless typing searches", () => {
  const choices = [
    { value: "a", label: "Alpha" },
    { value: "b", label: "Bravo" },
    { value: "c", label: "Charlie" },
  ] as const;
  const pick = (searchable: boolean, input: string[]) => {
    let picked: string | undefined;
    const picker = new SingleSelectPicker(
      testTui(24), testTheme(), keybindings(), choices, "a",
      { title: "Pick", searchable }, (value) => { picked = value; },
    );
    for (const data of [...input, "\r"]) picker.handleInput(data);
    return picked;
  };
  assert.equal(pick(false, ["j", "j"]), "c");
  assert.equal(pick(false, ["k"]), "c");
  assert.equal(pick(false, ["j", "k"]), "a");
  // Searchable: "j" filters to nothing, so confirm picks nothing.
  assert.equal(pick(true, ["j"]), undefined);
});
