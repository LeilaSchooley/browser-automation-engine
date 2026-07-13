import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeMechanicalSignals, isStrongMechanicalProgress } from "../src/layers/actionValidator.js";

describe("actionValidator layout fix", () => {
  it("computeMechanicalSignals tracks commitCompleted", () => {
    const signals = computeMechanicalSignals(
      { pickerOpen: true, customControls: [{ mappedTo: "salary", filled: false }] },
      { pickerOpen: false, customControls: [{ mappedTo: "salary", filled: true }] },
      { uiPhaseBefore: "option_selected_uncommitted", uiPhaseAfter: "ready_to_continue" },
    );
    assert.ok(signals.commitCompleted);
    assert.ok(isStrongMechanicalProgress(signals, true, true, { type: "smart_fill" }));
  });
});
