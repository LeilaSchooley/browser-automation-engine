import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveRecoveryPlan,
  repeatedActionWithoutProgress,
  shouldAiOverrideHeuristic,
  shouldEscalateToAi,
  validatorRecentlyRejected,
} from "../src/layers/semanticRecovery.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("semanticRecovery", () => {
  it("derives dismiss_overlay from validator upsell reason", () => {
    const plan = deriveRecoveryPlan({
      verdict: { progressed: false, reason: "another upsell modal appeared", recovery: null },
      snap: { hasBlockingOverlay: true, pageText: "increase your chances tailor your resume" },
      history: [],
      lastPlan: { type: "dismiss_overlay" },
    });
    assert.equal(plan?.type, "dismiss_overlay");
  });

  it("uses explicit validator recovery hint", () => {
    const plan = deriveRecoveryPlan({
      verdict: { progressed: false, reason: "upload still needed", recovery: "upload_resume" },
      snap: { fileInputCount: 1 },
      history: [],
      lastPlan: { type: "dismiss_overlay" },
    });
    assert.equal(plan?.type, "upload_resume");
  });

  it("suggests upload after dismiss loop when file input visible", () => {
    const plan = deriveRecoveryPlan({
      verdict: { progressed: false, reason: "no real progress" },
      snap: { fileInputCount: 1, hasApplyModal: true, modalCandidates: [{ text: "Upload resume" }] },
      history: [{ action: "upload_resume", ok: false, progress: false }],
      lastPlan: { type: "dismiss_overlay" },
    });
    assert.equal(plan?.type, "upload_resume");
  });

  it("derives dismiss_overlay after upload on expert review gate", () => {
    const plan = deriveRecoveryPlan({
      verdict: {
        progressed: false,
        reason: "Clicked Upload resume but modal swapped to expert review upsell",
        recovery: null,
      },
      snap: {
        hasApplyModal: true,
        fileInputCount: 1,
        applyModalTitle: "Get a free expert review to improve your resume",
        pageText: "Your resume is not ready yet",
      },
      history: [{ action: "upload_resume", ok: true, progress: true }],
      lastPlan: { type: "click_modal" },
    });
    assert.equal(plan?.type, "dismiss_overlay");
  });

  it("does not restart apply after successful upload", () => {
    const plan = deriveRecoveryPlan({
      verdict: { progressed: false, reason: "still on job listing page" },
      snap: { entryCount: 1, hasApplyModal: false, pageKind: "listing", fieldCount: 0 },
      history: [{ action: "upload_resume", ok: true, progress: true }],
      lastPlan: { type: "act" },
    });
    assert.equal(plan?.type, "dismiss_overlay");
  });

  it("escalates to AI when validator recently rejected", () => {
    initTestRuntime({ settings: { agent_ai: true } });
    const history = [
      { action: "dismiss_overlay", ok: true, progress: false, progressSource: "validator" },
    ];
    assert.equal(validatorRecentlyRejected(history), true);
    assert.equal(
      shouldEscalateToAi({ pageKind: "listing" }, history, { step: "overlay", confidence: "high" }),
      true,
    );
    assert.equal(
      shouldAiOverrideHeuristic({ pageKind: "listing" }, history, { step: "overlay", confidence: "high" }),
      true,
    );
  });

  it("escalates when same action repeats without progress", () => {
    const history = [
      { action: "dismiss_overlay", ok: true, progress: false },
      { action: "dismiss_overlay", ok: true, progress: false },
    ];
    assert.equal(repeatedActionWithoutProgress(history, 2), true);
    assert.equal(
      shouldAiOverrideHeuristic({}, history, { step: "overlay", confidence: "high" }),
      true,
    );
  });
});
