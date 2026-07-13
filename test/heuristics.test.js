import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  candidateSuggestsFileUpload,
  computeApplyOutcome,
  countRecentAction,
  isActiveApplyWizard,
  isBlockingInterstitial,
  isJobAlertInterstitial,
  isExpertReviewGate,
  findBestDismissCandidate,
  isResumeChoiceStep,
  isStuck,
  looksLikeFakeJobListing,
  looksLikeJobAlertSignupForm,
  looksLikeApplySignupGate,
  looksLikeJobBoardIndex,
  hasRealApplyAffordance,
  outcomeJobStatus,
  pageFingerprintFromSnap,
  shouldPreferUpload,
  snapSuggestsFileUpload,
  textMatchesInterstitialDismiss,
  textSuggestsFileUpload,
  uploadAlreadySucceeded,
} from "../src/heuristics.js";

describe("heuristics", () => {
  it("detects Ashby job board index with filter dropdowns", () => {
    const snap = {
      url: "https://jobs.ashbyhq.com/ditto",
      title: "Ditto Careers",
      pageText: "Open Positions Join our team",
      passwordFieldCount: 0,
      fileInputCount: 0,
      fieldCount: 4,
      fields: [
        { name: "departmentId", label: "Department", type: "select-one" },
        { name: "employmentType", label: "Employment Type", type: "select-one" },
        { name: "locationId", label: "Location", type: "select-one" },
        { name: "workplaceType", label: "Location Type", type: "select-one" },
      ],
    };
    assert.equal(looksLikeJobBoardIndex(snap), true);
  });

  it("detects Greenhouse and Lever board indices", () => {
    assert.equal(
      looksLikeJobBoardIndex({
        url: "https://boards.greenhouse.io/acme",
        pageText: "Open Positions",
        passwordFieldCount: 0,
        fileInputCount: 0,
        fieldCount: 2,
        fields: [
          { name: "department", label: "Department", type: "select-one" },
          { name: "office", label: "Office", type: "select-one" },
        ],
      }),
      true,
    );
    assert.equal(
      looksLikeJobBoardIndex({
        url: "https://jobs.lever.co/acme",
        pageText: "Current openings",
        passwordFieldCount: 0,
        fileInputCount: 0,
        fieldCount: 0,
        fields: [],
      }),
      true,
    );
  });

  it("does not treat Greenhouse apply form as board index", () => {
    assert.equal(
      looksLikeJobBoardIndex({
        url: "https://boards.greenhouse.io/acme/jobs/12345",
        passwordFieldCount: 0,
        fileInputCount: 1,
        fieldCount: 3,
        fields: [
          { name: "email", label: "Email", type: "email" },
          { name: "name", label: "Full name", type: "text" },
          { name: "resume", label: "Resume", type: "file" },
        ],
      }),
      false,
    );
  });

  it("does not treat real apply form as job board index", () => {
    const snap = {
      url: "https://jobs.ashbyhq.com/ditto/apply",
      passwordFieldCount: 0,
      fileInputCount: 1,
      fieldCount: 3,
      fields: [
        { name: "email", label: "Email", type: "email" },
        { name: "name", label: "Full name", type: "text" },
        { name: "resume", label: "Resume", type: "file" },
      ],
    };
    assert.equal(looksLikeJobBoardIndex(snap), false);
  });

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

  it("detects WhatJobs job-alert popup as interstitial", () => {
    const snap = {
      fieldCount: 7,
      modalCount: 1,
      pageText: "Be the first to know when new jobs like this one gets posted",
      fields: [
        { label: "Email Address", type: "email" },
        { label: "Receive the Latest Jobs", type: "submit" },
      ],
    };
    assert.equal(isJobAlertInterstitial(snap), true);
  });

  it("detects devitjobs inline alert signup form", () => {
    const snap = {
      fieldCount: 3,
      entryCount: 0,
      fileInputCount: 0,
      pageText: "Data Alert Azure Data DevOps Engineer",
      title: "Azure Data DevOps Engineer Job in London | Assura Protect",
      fields: [
        { name: "techCategory", label: "C# DevOps Java JavaScript PHP", type: "select-one" },
        { name: "personName", label: "Your name", type: "text" },
        { name: "personEmail", label: "Your email", type: "email" },
      ],
    };
    assert.equal(looksLikeJobAlertSignupForm(snap), true);
    assert.equal(hasRealApplyAffordance(snap), false);
    const fake = looksLikeFakeJobListing(snap, [{ action: "click_apply", ok: true }]);
    assert.equal(fake.fake, true);
    assert.match(fake.reason, /alert signup/i);
  });

  it("does not flag real apply forms as job-alert signup", () => {
    const snap = {
      fieldCount: 5,
      fileInputCount: 1,
      fields: [
        { label: "Full name", type: "text" },
        { label: "Email", type: "email" },
        { label: "Phone", type: "tel" },
        { label: "Resume", type: "file" },
        { label: "Cover letter", type: "textarea" },
      ],
    };
    assert.equal(looksLikeJobAlertSignupForm(snap), false);
  });

  it("detects job-board sign up to apply modal (Jobright-style)", () => {
    const snap = {
      hostname: "jobright.ai",
      hasApplyModal: true,
      applyModalTitle: "Apply to Technical Support Specialist @Baker Tilly Canada",
      pageText: "Sign Up to Apply Sign up with Google",
      fieldCount: 1,
      fields: [{ id: "sign-up_email", label: "Email", type: "text" }],
      submitCandidates: [{ text: "SIGN UP TO APPLY" }],
    };
    assert.equal(looksLikeApplySignupGate(snap), true);
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
