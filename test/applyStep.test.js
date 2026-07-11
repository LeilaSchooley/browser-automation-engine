import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyApplyStep,
  stepToPlan,
  STEP_ACTIONS,
  actionFailedTwiceOnFingerprint,
} from "../src/layers/applyStep.js";
import { pageFingerprintFromSnap } from "../src/heuristics.js";

const jobLeadsModalSnap = {
  pageKind: "modal",
  fieldCount: 0,
  fileInputCount: 0,
  entryCount: 1,
  modalStepCount: 2,
  hasApplyModal: true,
  cookieBanner: false,
  continueCount: 0,
  submitCount: 0,
  applyModalTitle: "Start your application",
  modalCandidates: [
    { text: "I have a resume", testId: "umja-option-upload-resume", score: 140 },
    { text: "I need a resume", testId: "umja-option-open-resume-builder", score: 55 },
  ],
  entryCandidates: [{ text: "I'm interested", testId: "job-preview-apply-button", score: 203 }],
  title: "Platform Engineer | JobLeads.com",
  url: "https://www.jobleads.com/us/job/example",
};

const listingSnap = {
  pageKind: "listing",
  fieldCount: 0,
  fileInputCount: 0,
  entryCount: 1,
  modalStepCount: 0,
  hasApplyModal: false,
  cookieBanner: false,
  continueCount: 0,
  submitCount: 0,
  entryCandidates: [{ text: "Apply", score: 100 }],
  title: "Software Engineer",
  url: "https://example.com/jobs/1",
};

const formSnap = {
  pageKind: "form",
  fieldCount: 5,
  fileInputCount: 0,
  entryCount: 0,
  modalStepCount: 0,
  hasApplyModal: false,
  cookieBanner: false,
  continueCount: 0,
  submitCount: 0,
  fields: [{ type: "text", label: "Name" }],
  title: "Application",
  url: "https://example.com/apply",
};

describe("applyStep", () => {
  it("classifies wizard modal as wizard_choice", () => {
    const c = classifyApplyStep(jobLeadsModalSnap, { filled: [], unfilled_count: 0 }, [
      { action: "click_apply", ok: true, progress: true },
    ]);
    assert.equal(c.step, "wizard_choice");
    assert.equal(stepToPlan(c, jobLeadsModalSnap, []).type, "click_modal");
  });

  it("classifies listing CTA as entry", () => {
    const c = classifyApplyStep(listingSnap, { filled: [], unfilled_count: 0 }, []);
    assert.equal(c.step, "entry");
    assert.equal(stepToPlan(c, listingSnap, []).type, "click_apply");
  });

  it("classifies visible fields as form", () => {
    const c = classifyApplyStep(formSnap, { filled: [], unfilled_count: 5 }, [
      { action: "click_apply", ok: true, progress: true },
    ]);
    assert.equal(c.step, "form");
    assert.equal(stepToPlan(c, formSnap, []).type, "smart_fill");
  });

  it("never smart_fills when fieldCount is 0", () => {
    const c = classifyApplyStep({ ...listingSnap, fieldCount: 0 }, { filled: [] }, [
      { action: "click_apply", ok: true },
    ]);
    assert.notEqual(stepToPlan(c, { ...listingSnap, fieldCount: 0 }, [])?.type, "smart_fill");
  });

  it("classifies cookie banner as consent", () => {
    const snap = {
      ...listingSnap,
      cookieBanner: true,
      cookieCandidates: [{ text: "Accept all cookies", score: 90 }],
      entryCount: 0,
      pageKind: "consent",
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "consent");
    assert.equal(stepToPlan(c, snap, []).type, "accept_cookies");
  });

  it("classifies blocking ad overlay before consent", () => {
    const snap = {
      ...listingSnap,
      hasBlockingOverlay: true,
      bodyLocked: true,
      dismissCandidates: [{ text: "Close", score: 120 }],
      cookieBanner: true,
      cookieCandidates: [{ text: "Accept all cookies", score: 90 }],
      entryCount: 1,
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "overlay");
    assert.equal(stepToPlan(c, snap, []).type, "dismiss_overlay");
  });

  it("classifies login wall as blocked", () => {
    const snap = {
      ...listingSnap,
      title: "Sign in to apply — Example Jobs",
      fieldCount: 0,
      entryCount: 0,
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "blocked");
    assert.equal(stepToPlan(c, snap, []).type, "wait_user");
  });

  it("stops smart_fill after two failures on same fingerprint", () => {
    const fp = pageFingerprintFromSnap(formSnap);
    const history = [
      { action: "smart_fill", fingerprint: fp, ok: false, progress: false },
      { action: "smart_fill", fingerprint: fp, ok: false, progress: false },
    ];
    const c = classifyApplyStep(formSnap, { filled: [] }, history);
    assert.equal(stepToPlan(c, formSnap, history), null);
    assert.equal(actionFailedTwiceOnFingerprint(history, "smart_fill", fp), true);
  });

  it("maps wizard_choice to click_modal action", () => {
    assert.equal(STEP_ACTIONS.wizard_choice, "click_modal");
  });

  it("classifies continue control as continue", () => {
    const snap = {
      pageKind: "content",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 0,
      modalStepCount: 0,
      hasApplyModal: false,
      cookieBanner: false,
      continueCount: 1,
      submitCount: 0,
      continueCandidates: [{ text: "Continue", testId: "continue-cta", score: 90 }],
      title: "Application — Continue",
      url: "https://example.com/apply/step-2",
      bodyTextLength: 200,
    };
    const c = classifyApplyStep(snap, { filled: [] }, [
      { action: "click_apply", ok: true, progress: true },
    ]);
    assert.equal(c.step, "continue");
    assert.equal(stepToPlan(c, snap, []).type, "click_continue");
  });

  it("classifies submit after fill as review via submit path", () => {
    const snap = {
      pageKind: "content",
      fieldCount: 1,
      fileInputCount: 0,
      entryCount: 0,
      modalStepCount: 0,
      hasApplyModal: false,
      cookieBanner: false,
      continueCount: 0,
      submitCount: 1,
      submitCandidates: [{ text: "Submit application", score: 100 }],
      title: "Review",
      url: "https://example.com/apply/review",
      bodyTextLength: 120,
    };
    // filled >= 2 but fieldCount < 2 skips the looksLikeApplyForm review branch
    const fillResult = { filled: [{}, {}], unfilled_count: 0 };
    const c = classifyApplyStep(snap, fillResult, [{ action: "smart_fill", ok: true }]);
    assert.equal(c.step, "review");
    assert.equal(stepToPlan(c, snap, []).type, "done");
  });

  it("classifies low-confidence continue when affordances compete", () => {
    const snap = {
      pageKind: "content",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 1,
      modalStepCount: 0,
      hasApplyModal: false,
      cookieBanner: false,
      continueCount: 1,
      submitCount: 0,
      entryCandidates: [{ text: "Apply", score: 100 }],
      continueCandidates: [{ text: "Continue", score: 80 }],
      title: "Mixed page",
      url: "https://example.com/mixed",
      bodyTextLength: 300,
    };
    // click_apply already succeeded → entry suppressed; continue + entry affordances compete
    const c = classifyApplyStep(snap, { filled: [] }, [{ action: "click_apply", ok: true }]);
    assert.equal(c.step, "continue");
    assert.equal(c.confidence, "low");
  });

  it("classifies competing long-text continue as ambiguous", () => {
    const snap = {
      pageKind: "content",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 1,
      modalStepCount: 0,
      hasApplyModal: false,
      cookieBanner: false,
      continueCount: 1,
      submitCount: 0,
      entryCandidates: [{ text: "Apply", score: 100 }],
      continueCandidates: [
        {
          text: "A".repeat(90),
          score: 80,
        },
      ],
      title: "Mixed page",
      url: "https://example.com/mixed",
      bodyTextLength: 300,
    };
    const c = classifyApplyStep(snap, { filled: [] }, [{ action: "click_apply", ok: true }]);
    assert.equal(c.step, "ambiguous");
    assert.equal(c.confidence, "low");
  });

  it("falls back to ambiguous when no clear step", () => {
    const snap = {
      pageKind: "content",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 0,
      modalStepCount: 0,
      hasApplyModal: false,
      cookieBanner: false,
      continueCount: 0,
      submitCount: 0,
      title: "Empty surface",
      url: "https://example.com/empty",
      bodyTextLength: 80,
    };
    const c = classifyApplyStep(snap, { filled: [] }, [{ action: "click_apply", ok: true }]);
    assert.equal(c.step, "ambiguous");
    assert.equal(stepToPlan(c, snap, []), null);
  });

  it("classifies loading after successful upload with 0 fields", () => {
    const snap = {
      pageKind: "modal",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 0,
      modalStepCount: 0,
      hasApplyModal: true,
      cookieBanner: false,
      continueCount: 0,
      submitCount: 0,
      title: "Uploading",
      url: "https://example.com/apply",
      bodyTextLength: 40,
    };
    const history = [{ action: "upload_resume", ok: true, progress: true }];
    const c = classifyApplyStep(snap, { filled: [] }, history);
    assert.equal(c.step, "loading");
    assert.equal(stepToPlan(c, snap, history).type, "wait_load");
  });

  it("classifies JobLeads resume review upsell as overlay dismiss", () => {
    const snap = {
      pageKind: "modal",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 3,
      modalStepCount: 0,
      hasApplyModal: false,
      hasBlockingOverlay: true,
      cookieBanner: false,
      continueCount: 0,
      submitCount: 0,
      pageText: "AUTO-REJECTED Your resume won't reach a human ATS software will filter you out",
      overlayHints: ["resume-review-upsell"],
      dismissCandidates: [{ text: "Skip", score: 220 }],
      title: "Platform Engineer | JobLeads.com",
      url: "https://www.jobleads.com/us/job/example",
      bodyTextLength: 8000,
    };
    const history = [{ action: "upload_resume", ok: true, progress: true }];
    const c = classifyApplyStep(snap, { filled: [] }, history);
    assert.equal(c.step, "overlay");
    assert.equal(stepToPlan(c, snap, history).type, "dismiss_overlay");
  });

  it("classifies unloaded page as loading", () => {
    const snap = {
      pageKind: "unknown",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 0,
      modalStepCount: 0,
      hasApplyModal: false,
      cookieBanner: false,
      continueCount: 0,
      submitCount: 0,
      title: "",
      url: "about:blank",
      bodyTextLength: 0,
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "loading");
  });

  it("suppresses entry after successful click_apply", () => {
    const c = classifyApplyStep(listingSnap, { filled: [] }, [
      { action: "click_apply", ok: true, progress: true },
    ]);
    assert.notEqual(c.step, "entry");
  });
});
