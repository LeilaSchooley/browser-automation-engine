import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isLikelyNoopClick,
  normalizeRecoveryAction,
  parseValidatorResponse,
} from "../src/layers/actionValidator.js";
import { reflectFromHistory } from "../src/learningRecorder.js";
import { recoveryToPlanType } from "../src/layers/semanticRecovery.js";

describe("robustness stack", () => {
  it("normalizes validator recovery aliases to catalog actions", () => {
    assert.equal(normalizeRecoveryAction("dismiss"), "dismiss_overlay");
    assert.equal(normalizeRecoveryAction("Continue"), "click_continue");
    assert.equal(normalizeRecoveryAction("smart_fill"), "smart_fill");
    assert.equal(recoveryToPlanType("upload"), "upload_resume");
    assert.equal(recoveryToPlanType("ai_replan"), null);
  });

  it("detects noop clicks from flat mechanical signals", () => {
    const signals = {
      fingerprintChanged: false,
      urlChanged: false,
      modalAppeared: false,
      pickerClosed: false,
      commitCompleted: false,
      fieldCountDelta: 0,
      fileInputDelta: 0,
      filledDelta: 0,
    };
    assert.equal(isLikelyNoopClick(signals, false, true), true);
    assert.equal(isLikelyNoopClick({ ...signals, urlChanged: true }, false, true), false);
  });

  it("parses validator JSON with normalized recovery", () => {
    const v = parseValidatorResponse('{"progressed": false, "reason": "still on ads", "recovery": "dismiss"}');
    assert.equal(v.progressed, false);
    assert.equal(v.recovery, "dismiss_overlay");
  });

  it("reflects failed history into suggestedNext", () => {
    const reflection = reflectFromHistory(
      [
        { action: "smart_fill", ok: true, progress: false, reason: "blocked by modal" },
        { action: "smart_fill", ok: true, progress: false },
      ],
      { hasBlockingOverlay: true },
    );
    assert.ok(reflection);
    assert.equal(reflection.suggestedNext, "dismiss_overlay");
    assert.ok(reflection.failedActions.includes("smart_fill"));
  });
});
