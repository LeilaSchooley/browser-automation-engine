import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverCustomControlsFromSnap } from "../src/fillCustomControls.js";
import { mergeControlSkills } from "../src/siteLearnings.js";

describe("fillCustomControls", () => {
  it("discoverCustomControlsFromSnap uses snapshot customControls", () => {
    const snap = {
      customControls: [{ label: "Salary expectations", mappedTo: "salary", filled: false }],
    };
    const found = discoverCustomControlsFromSnap(snap);
    assert.equal(found.length, 1);
    assert.equal(found[0].label, "Salary expectations");
  });

  it("discoverCustomControlsFromSnap infers from page text", () => {
    const snap = {
      pageText: "Tell us about yourself. Salary expectations. Location.",
      fields: [],
    };
    const found = discoverCustomControlsFromSnap(snap);
    assert.ok(found.some((c) => c.mappedTo === "salary" || c.type === "salary"));
  });
});

describe("mergeControlSkills", () => {
  it("dedupes by mappedTo and label", () => {
    const merged = mergeControlSkills(
      [{ label: "salary expectations", mappedTo: "salary", successCount: 2 }],
      [{ label: "salary expectations", mappedTo: "salary", triggerSelector: "#combo", successCount: 1 }],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].successCount, 3);
    assert.equal(merged[0].triggerSelector, "#combo");
  });
});
