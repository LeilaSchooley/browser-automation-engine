import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isWorkflowGateModal, shouldNeverDismiss } from "../src/workflowGates.js";
import { deriveRecoveryPlan } from "../src/layers/semanticRecovery.js";

describe("workflowGates", () => {
  it("treats tell-us-about-yourself as workflow gate", () => {
    const snap = {
      applyModalTitle: "Tell us about yourself",
      fieldCount: 3,
      passwordFieldCount: 0,
      pageText: "Salary expectations",
    };
    assert.equal(isWorkflowGateModal(snap), true);
    assert.equal(shouldNeverDismiss(snap), true);
  });

  it("recovery rewrites dismiss_overlay on workflow gate to smart_fill", () => {
    const snap = {
      applyModalTitle: "Tell us about yourself",
      fieldCount: 3,
      passwordFieldCount: 0,
      pageText: "salary expectations desired job title",
      fields: [{ label: "?", type: "select", filled: false }],
    };
    const plan = deriveRecoveryPlan({
      verdict: { recovery: "dismiss_overlay", reason: "modal blocking" },
      snap,
      history: [],
      lastPlan: null,
    });
    assert.equal(plan.type, "smart_fill");
  });
});
