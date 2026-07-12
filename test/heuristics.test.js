import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  candidateSuggestsFileUpload,
  computeApplyOutcome,
  countRecentAction,
  isActiveApplyWizard,
  isBlockingInterstitial,
  isExpertReviewGate,
  findBestDismissCandidate,
  isResumeChoiceStep,
  isStuck,
  outcomeJobStatus,
  pageFingerprintFromSnap,
  shouldPreferUpload,
  snapSuggestsFileUpload,
  textMatchesInterstitialDismiss,
  textSuggestsFileUpload,
  uploadAlreadySucceeded,
} from "../src/heuristics.js";

describe("heuristics", () => {
  it("detects resume-choice wizard steps", () => {
    const snap = {
      modalCandidates: [{ text: "I have a resume", testId: "umja-option-upload-resume" }],
    };
    assert.equal(isResumeChoiceStep(snap), true);
  });

  it("detects active apply wizard and suppresses upsell interstitial", () => {
    const snap = {
      hasApplyModal: true,
      fileInputCount: 1,
      applyModalTitle: "Continue application",
      modalCandidates: [{ text: "Upload resume", testId: "ui-uploader" }],
      fileInputCandidates: [{ testId: "ui-uploader", selector: '[data-testid="ui-uploader"]' }],
      pageText: "increase your chances tailor your resume",
      overlayHints: ["interstitial-dismiss"],
    };
    assert.equal(isActiveApplyWizard(snap), true);
    assert.equal(isBlockingInterstitial(snap), false);
  });

  it("matches extended interstitial dismiss labels", () => {
    assert.equal(textMatchesInterstitialDismiss("Skip to application"), true);
    assert.equal(textMatchesInterstitialDismiss("Skip and continue"), true);
    assert.equal(textMatchesInterstitialDismiss("Skip & continue"), true);
    assert.equal(textMatchesInterstitialDismiss("Continue without documents"), true);
    assert.equal(textMatchesInterstitialDismiss("Tailor your resume"), false);
  });

  it("detects expert review gate and prefers Skip and continue dismiss", () => {
    const snap = {
      hasApplyModal: true,
      fileInputCount: 1,
      applyModalTitle: "Get a free expert review to improve your resume",
      modalCandidates: [{ text: "Upload resume", testId: "ds-button" }],
      dismissCandidates: [
        { text: "Continue without documents", score: 200 },
        { text: "Skip and continue", score: 280, source: "interstitial-dismiss" },
      ],
      pageText: "Your resume is not ready yet? Get a free expert review",
    };
    assert.equal(isExpertReviewGate(snap), true);
    assert.equal(isActiveApplyWizard(snap), false);
    assert.equal(isBlockingInterstitial(snap), true);
    const best = findBestDismissCandidate(snap);
    assert.match(best.text, /skip and continue/i);
  });

  it("detects file upload copy", () => {
    assert.equal(textSuggestsFileUpload("Upload a resume to continue"), true);
    assert.equal(textSuggestsFileUpload("Next step"), false);
  });

  it("detects upload from candidate / snap signals", () => {
    assert.equal(
      candidateSuggestsFileUpload({ text: "Choose file", testId: "resume-upload" }),
      true,
    );
    assert.equal(snapSuggestsFileUpload({ fileInputCount: 1 }), true);
    assert.equal(
      snapSuggestsFileUpload({
        fileInputCount: 0,
        applyModalTitle: "Upload a resume",
        modalCandidates: [],
        continueCandidates: [],
      }),
      true,
    );
  });

  it("tracks upload success and recent actions", () => {
    const history = [
      { action: "click_modal", ok: false },
      { action: "upload_resume", ok: true },
      { action: "click_modal", ok: false },
    ];
    assert.equal(uploadAlreadySucceeded(history), true);
    assert.equal(countRecentAction(history, "click_modal", 3), 2);
    assert.equal(shouldPreferUpload({ fileInputCount: 1 }, history), false);
  });

  it("prefers upload when file input exists", () => {
    const snap = { fileInputCount: 1, modalCandidates: [] };
    assert.equal(shouldPreferUpload(snap, []), true);
  });

  it("does not prefer upload after resume-choice without file input", () => {
    const snap = {
      fileInputCount: 0,
      modalCandidates: [{ text: "I have a resume", testId: "option-upload-resume" }],
    };
    assert.equal(shouldPreferUpload(snap, []), false);
  });

  it("detects stuck agent loops", () => {
    const snap = { pageKind: "listing", fieldCount: 0, entryCount: 1 };
    const fp = pageFingerprintFromSnap(snap);
    const history = [
      { action: "click_apply", fingerprint: fp, ok: true, progress: false },
      { action: "click_apply", fingerprint: fp, ok: true, progress: false },
      { action: "click_apply", fingerprint: fp, ok: true, progress: false },
    ];
    assert.equal(isStuck(history, snap), true);
  });

  it("keeps page fingerprints stable for identical snaps", () => {
    const snap = {
      pageKind: "form",
      fieldCount: 4,
      entryCount: 0,
      modalStepCount: 0,
      fileInputCount: 0,
      continueCount: 1,
      cookieBanner: false,
      modalCandidates: [{ text: "Next" }],
      url: "https://example.com/apply?x=1",
    };
    assert.equal(pageFingerprintFromSnap(snap), pageFingerprintFromSnap({ ...snap }));
  });

  it("scores ready outcome when fields are filled", () => {
    const outcome = computeApplyOutcome({
      pipeline: {
        fillResult: { filled: [{ type: "email" }, { type: "name" }] },
        snap: { fieldCount: 5, pageKind: "form", url: "https://example.com/apply" },
        agentHistory: [],
      },
    });
    assert.equal(outcome.outcome, "ready");
    assert.equal(outcomeJobStatus(outcome.outcome), "browser_ready");
  });

  it("scores ready when fill + resume upload both succeeded", () => {
    const outcome = computeApplyOutcome({
      pipeline: {
        fillResult: { filled: [{ type: "email" }] },
        snap: { fieldCount: 1, pageKind: "form", url: "https://example.com/apply" },
        agentHistory: [{ action: "upload_resume", ok: true }],
      },
    });
    assert.equal(outcome.outcome, "ready");
    assert.equal(outcome.resume_uploaded, true);
  });

  it("scores partial outcome when only surface reached", () => {
    const outcome = computeApplyOutcome({
      pipeline: {
        fillResult: { filled: [] },
        snap: { fieldCount: 3, pageKind: "form", url: "https://example.com/apply" },
        agentHistory: [],
      },
    });
    assert.equal(outcome.outcome, "partial");
  });

  it("scores stopped outcome when pipeline was halted", () => {
    const outcome = computeApplyOutcome({
      pipeline: {
        fillResult: { filled: [] },
        snap: { fieldCount: 0, pageKind: "listing", url: "https://example.com/job" },
        agentHistory: [],
      },
      stopped: true,
    });
    assert.equal(outcome.outcome, "stopped");
    assert.equal(outcomeJobStatus(outcome.outcome), null);
  });

  it("scores error outcome with error payload", () => {
    const outcome = computeApplyOutcome({
      pipeline: {
        fillResult: { filled: [] },
        snap: { fieldCount: 0, pageKind: "unknown", url: "https://example.com/x" },
        agentHistory: [],
      },
      error: "navigation failed",
    });
    assert.equal(outcome.outcome, "error");
    assert.equal(outcome.error, "navigation failed");
  });

  it("scores stuck when history loops without reaching a surface", () => {
    const snap = { pageKind: "listing", fieldCount: 0, entryCount: 1, url: "https://example.com/job" };
    const fp = pageFingerprintFromSnap(snap);
    const outcome = computeApplyOutcome({
      pipeline: {
        fillResult: { filled: [] },
        snap,
        agentHistory: [
          { action: "click_apply", fingerprint: fp, ok: true, progress: false },
          { action: "click_apply", fingerprint: fp, ok: true, progress: false },
          { action: "click_apply", fingerprint: fp, ok: true, progress: false },
        ],
      },
    });
    assert.equal(outcome.outcome, "stuck");
    assert.equal(outcomeJobStatus(outcome.outcome), null);
  });
});
