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

  it("classifies preferences complete as continue not overlay", () => {
    const snap = {
      pageKind: "form",
      fieldCount: 3,
      passwordFieldCount: 0,
      authForm: false,
      hasApplyModal: true,
      hasBlockingOverlay: true,
      continueCount: 1,
      continueCandidates: [{ text: "Sign up now for free", score: 80 }],
      applyModalTitle: "Tell us about yourself",
      pageText: "Salary expectations Desired job title Location Germany",
      fields: [
        { label: "Location", type: "text", filled: true },
        { label: "Salary expectations", type: "select", filled: true },
        { label: "Desired job title", type: "text", filled: true },
      ],
    };
    const c = classifyApplyStep(snap, { filled: [{ type: "salary" }], unfilled: [] }, []);
    assert.equal(c.step, "continue");
  });

  it("waits after preferences signup instead of dismissing modal-close on listing", () => {
    const snap = {
      pageKind: "listing",
      fieldCount: 0,
      entryCount: 3,
      modalCount: 1,
      hasApplyModal: false,
      hasBlockingOverlay: false,
      cookieBanner: true,
      entryCandidates: [{ text: "I'm interested", testId: "job-preview-apply-button", score: 203 }],
      dismissCandidates: [{ text: "", testId: "modal-close", score: 200 }],
      url: "https://www.jobleads.com/us/job/example",
      title: "Platform Engineer | JobLeads.com",
    };
    const history = [{ action: "smart_fill", ok: true, progress: true, preferencesSignup: true }];
    const c = classifyApplyStep(snap, { filled: [{ type: "salary" }], unfilled: [] }, history);
    assert.equal(c.step, "loading");
    assert.match(c.reason || "", /post-preferences/i);
  });

  it("suppresses entry replay after learned affordance entry act on same page", () => {
    const snap = {
      pageKind: "listing",
      fieldCount: 0,
      entryCount: 3,
      entryCandidates: [{ text: "I'm interested", testId: "job-preview-apply-button", score: 203 }],
      url: "https://www.jobleads.com/us/job/example",
      title: "Platform Engineer | JobLeads.com",
    };
    const fp = pageFingerprintFromSnap(snap);
    const history = [
      { action: "act", applyStep: "entry", ok: true, progress: true, fromFingerprint: fp },
    ];
    const c = classifyApplyStep(snap, { filled: [] }, history);
    assert.notEqual(c.step, "entry");
  });

  it("never classifies identity registration as overlay dismiss", () => {
    const snap = {
      pageKind: "auth",
      fieldCount: 4,
      passwordFieldCount: 1,
      emailFieldCount: 1,
      hasBlockingOverlay: true,
      hasApplyModal: true,
      fields: [
        { label: "First name", type: "text", filled: false },
        { label: "Last name", type: "text", filled: false },
        { label: "Email", type: "email", filled: false },
        { label: "Password", type: "password", filled: false },
      ],
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.notEqual(c.step, "overlay");
    assert.equal(c.step, "form");
  });

  it("classifies Ashby job board filters as entry not preferences form", () => {
    const snap = {
      pageKind: "content",
      fieldCount: 4,
      passwordFieldCount: 0,
      authForm: false,
      hasApplyModal: false,
      entryCount: 0,
      fileInputCount: 0,
      url: "https://jobs.ashbyhq.com/ditto",
      pageText: "Open Positions",
      fields: [
        { name: "departmentId", label: "Department", type: "select-one" },
        { name: "employmentType", label: "Employment Type", type: "select-one" },
        { name: "locationId", label: "Location", type: "select-one" },
        { name: "workplaceType", label: "Location Type", type: "select-one" },
      ],
    };
    const c = classifyApplyStep(snap, { filled: [] }, [], { job: { title: "Engineer", company: "Ditto" } });
    assert.equal(c.step, "entry");
    assert.match(c.reason, /job board index/i);
  });

  it("classifies preferences gate with empty salary as form not continue", () => {
    const snap = {
      pageKind: "modal",
      fieldCount: 3,
      passwordFieldCount: 0,
      authForm: false,
      hasApplyModal: true,
      continueCount: 1,
      continueCandidates: [{ text: "Sign up now for free", score: 80 }],
      applyModalTitle: "Tell us about yourself",
      pageText: "Salary expectations Desired job title Location",
      fields: [
        { label: "Location", type: "text", filled: true },
        { label: "Salary expectations", type: "select", filled: false },
        { label: "Desired job title", type: "text", filled: true },
      ],
    };
    const c = classifyApplyStep(snap, { filled: [], unfilled: [{ type: "salary" }] }, []);
    assert.equal(c.step, "form");
    assert.match(c.reason, /preferences/i);
  });

  it("never smart_fills when fieldCount is 0", () => {
    const c = classifyApplyStep({ ...listingSnap, fieldCount: 0 }, { filled: [] }, [
      { action: "click_apply", ok: true },
    ]);
    assert.notEqual(stepToPlan(c, { ...listingSnap, fieldCount: 0 }, [])?.type, "smart_fill");
  });

  it("classifies cookie banner as consent with high confidence", () => {
    const snap = {
      ...listingSnap,
      cookieBanner: true,
      structuralCookieBanner: true,
      cookieCandidates: [{ text: "Accept all cookies", score: 90 }],
      entryCount: 0,
      pageKind: "consent",
      pageText: "We use cookies",
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "consent");
    assert.equal(c.confidence, "high");
    assert.equal(stepToPlan(c, snap, []).type, "accept_cookies");
  });

  it("classifies job-alert popup as overlay not consent", () => {
    const snap = {
      pageKind: "form",
      fieldCount: 7,
      modalCount: 1,
      cookieBanner: true,
      entryCount: 0,
      pageText: "Be the first to know Receive the Latest Jobs",
      fields: [
        { label: "Email Address", type: "email" },
        { label: "Receive the Latest Jobs", type: "submit" },
      ],
      dismissCandidates: [{ text: "×", score: 150, testId: "close" }],
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "overlay");
    assert.notEqual(c.step, "consent");
  });

  it("classifies weak cookie candidate as medium confidence consent", () => {
    const snap = {
      ...listingSnap,
      cookieBanner: true,
      structuralCookieBanner: true,
      cookieCandidates: [{ text: "Agree", score: 65 }],
      pageText: "cookie policy",
      fieldCount: 0,
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "consent");
    assert.equal(c.confidence, "medium");
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
      overlayHints: ["interstitial-dismiss"],
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

  it("prefers upload when apply wizard is open despite upsell copy in page text", () => {
    const snap = {
      pageKind: "modal",
      fieldCount: 0,
      fileInputCount: 1,
      entryCount: 3,
      modalStepCount: 1,
      hasApplyModal: true,
      hasBlockingOverlay: false,
      cookieBanner: true,
      continueCount: 0,
      submitCount: 0,
      pageText: "increase your chances tailor your resume AUTO-REJECTED",
      overlayHints: ["interstitial-dismiss"],
      dismissCandidates: [{ text: "Skip", score: 220, source: "interstitial-dismiss" }],
      applyModalTitle: "Continue application",
      modalCandidates: [{ text: "Upload resume", score: 90, testId: "ui-uploader-label" }],
      fileInputCandidates: [{ selector: '[data-testid="ui-uploader"]', testId: "ui-uploader", score: 120 }],
      title: "Platform Engineer | JobLeads.com",
      url: "https://www.jobleads.com/us/job/example",
      bodyTextLength: 8000,
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "upload");
    assert.equal(stepToPlan(c, snap, []).type, "upload_resume");
  });

  it("classifies second upsell with Skip to application after upload", () => {
    const snap = {
      pageKind: "listing",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 3,
      modalStepCount: 0,
      hasApplyModal: false,
      hasBlockingOverlay: true,
      modalCount: 1,
      cookieBanner: false,
      continueCount: 0,
      submitCount: 0,
      pageText: "Increase your chances by 78% to get invited tailor your resume in minutes",
      overlayHints: ["interstitial-dismiss"],
      dismissCandidates: [{ text: "Skip to application", score: 300, source: "interstitial-dismiss" }],
      title: "Platform Engineer | JobLeads.com",
      url: "https://www.jobleads.com/us/job/example",
      bodyTextLength: 8000,
    };
    const history = [{ action: "upload_resume", ok: true, progress: true }];
    const c = classifyApplyStep(snap, { filled: [] }, history);
    assert.equal(c.step, "overlay");
    assert.match(c.reason || "", /Skip to application/i);
  });

  it("classifies JobLeads resume score gate as overlay dismiss", () => {
    const snap = {
      pageKind: "listing",
      fieldCount: 0,
      fileInputCount: 0,
      entryCount: 3,
      modalStepCount: 0,
      hasApplyModal: false,
      hasBlockingOverlay: true,
      modalCount: 1,
      cookieBanner: false,
      continueCount: 0,
      submitCount: 0,
      pageText:
        "Applying with a 36/100 resume score is not recommended! Save your free expert resume review to improve it",
      overlayHints: ["interstitial-dismiss"],
      dismissCandidates: [{ text: "Skip free expert review", score: 320, source: "interstitial-dismiss" }],
      title: "Platform Engineer | JobLeads.com",
      url: "https://www.jobleads.com/us/job/example",
      bodyTextLength: 8000,
    };
    const history = [{ action: "upload_resume", ok: true, progress: true }];
    const c = classifyApplyStep(snap, { filled: [] }, history);
    assert.equal(c.step, "overlay");
    assert.match(c.reason || "", /Skip free expert review/i);
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

  it("blocks devitjobs alert signup after apply redirect", () => {
    const snap = {
      url: "https://devitjobs.uk/jobs/Assura-Protect-Azure-Data-DevOps-Engineer",
      hostname: "devitjobs.uk",
      pageKind: "form",
      fieldCount: 3,
      entryCount: 0,
      submitCount: 0,
      fileInputCount: 0,
      title: "Azure Data DevOps Engineer Job in London | Assura Protect",
      pageText: "Data Alert £60,000 Full-Time",
      fields: [
        { name: "techCategory", label: "DevOps Java JavaScript", type: "select-one" },
        { name: "personName", label: "Your name", type: "text" },
        { name: "personEmail", label: "Your email", type: "email" },
      ],
    };
    const history = [{ action: "click_apply", ok: true, progress: true }];
    const c = classifyApplyStep(snap, { filled: [] }, history);
    assert.equal(c.step, "blocked");
    assert.equal(c.hardStop, true);
    assert.match(c.reason, /alert signup|no apply/i);
    assert.notEqual(stepToPlan(c, snap, history)?.type, "smart_fill");
  });

  it("classifies Jobright sign-up-to-apply modal as signup not smart_fill", () => {
    const snap = {
      url: "https://jobright.ai/jobs/info/6a286da82d6c332ee52e5fcb",
      hostname: "jobright.ai",
      pageKind: "modal",
      fieldCount: 1,
      passwordFieldCount: 0,
      emailFieldCount: 1,
      hasApplyModal: true,
      applyModalTitle: "Apply to Technical Support Specialist @Baker Tilly Canada",
      pageText: "Sign Up to Apply",
      fields: [{ id: "sign-up_email", label: "Email", type: "text" }],
      submitCandidates: [{ text: "SIGN UP TO APPLY" }],
    };
    const c = classifyApplyStep(
      snap,
      { filled: [] },
      [{ action: "click_apply", ok: true }],
      { applicant: { email: "test@example.com", fullName: "Test User" } },
    );
    assert.equal(c.step, "signup");
    assert.equal(stepToPlan(c, snap, [])?.type, "auth_signup");
    assert.notEqual(stepToPlan(c, snap, [])?.type, "smart_fill");
  });

  it("prefers sign-in when a verified site account already exists", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const { initTestRuntime } = await import("./helpers/runtime.js");
    const { saveAccountForHost } = await import("../src/accountStore.js");

    const accountsFile = path.join(os.tmpdir(), `ql-verified-acc-${process.pid}.json`);
    initTestRuntime({
      settings: {
        site_accounts_path: accountsFile,
        auto_signup_enabled: true,
        account_email_base: "test@example.com",
      },
    });
    saveAccountForHost("jobright.ai", {
      email: "test+jobright@example.com",
      username: "jobrightuser",
      password: "Passw0rd!",
      pending: false,
      verified: true,
    });

    const snap = {
      url: "https://jobright.ai/jobs/info/abc",
      hostname: "jobright.ai",
      pageKind: "modal",
      fieldCount: 1,
      emailFieldCount: 1,
      hasApplyModal: true,
      applyModalTitle: "Apply to Role",
      pageText: "Sign Up to Apply Already a member? Sign in now",
      fields: [{ id: "sign-up_email", label: "Email", type: "text" }],
      signInCount: 1,
      signInCandidates: [{ text: "Sign in now", score: 90 }],
      submitCandidates: [{ text: "SIGN UP TO APPLY" }],
    };

    const c = classifyApplyStep(
      snap,
      { filled: [] },
      [{ action: "click_apply", ok: true }],
      { applicant: { email: "test@example.com", fullName: "Test User" } },
    );
    assert.equal(c.step, "signin_entry");
    assert.equal(stepToPlan(c, snap, [])?.type, "click_signin");
    try {
      fs.unlinkSync(accountsFile);
    } catch {
      /* ignore */
    }
  });

  it("blocks Jooble jdp when original job requires local presence", () => {
    const snap = {
      url: "https://jooble.org/jdp/9177318897283547463",
      hostname: "jooble.org",
      pageKind: "listing",
      fieldCount: 1,
      entryCount: 1,
      fileInputCount: 0,
      title: "[Full Remote] Junior Web Developer at Joinrs US – Jooble",
      pageText:
        "This position requires local presence. Please view similar jobs below. Similar jobs that could be interesting for you",
      entryCandidates: [{ text: "Apply", score: 90, href: "https://jooble.org/away/9177318897283547463" }],
      fields: [{ name: "email", placeholder: "example@mail.com", type: "text" }],
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "blocked");
    assert.equal(c.hardStop, true);
    assert.match(c.reason, /unavailable|similar jobs/i);
    assert.notEqual(stepToPlan(c, snap, [])?.type, "click_apply");
  });

  it("blocks Jooble SearchResult when closedJob=True in URL", () => {
    const snap = {
      url: "https://jooble.org/SearchResult?closedJob=True&ukw=junior%20web%20developer",
      hostname: "jooble.org",
      pageKind: "form",
      fieldCount: 1,
      entryCount: 0,
      pageText: "Subscribe and receive similar vacancies",
      fields: [{ name: "email", type: "email" }],
    };
    const c = classifyApplyStep(snap, { filled: [] }, [{ action: "click_apply", ok: true }]);
    assert.equal(c.step, "blocked");
    assert.match(c.reason, /closed/i);
  });

  it("classifies Jobright Boost Your Resume upsell as overlay dismiss, not smart_fill", () => {
    const snap = {
      url: "https://jobright.ai/jobs/recommend",
      hostname: "jobright.ai",
      pageKind: "modal",
      fieldCount: 1,
      fileInputCount: 0,
      entryCount: 0,
      hasApplyModal: true,
      hasBlockingOverlay: false,
      modalCount: 1,
      applyModalTitle: "Boost Your Resume Here!",
      pageText: "Boost Your Resume Here! Paste any LinkedIn profile URL to improve your resume",
      fields: [{ name: "linkedin", placeholder: "Paste LinkedIn profile URL", type: "text" }],
      dismissCandidates: [{ text: "Close", aria: "Close", score: 80 }],
      interactives: [{ text: "Close", aria: "Close" }],
    };
    const c = classifyApplyStep(snap, { filled: [] }, []);
    assert.equal(c.step, "overlay");
    assert.match(c.reason, /resume upsell|boost/i);
    assert.equal(stepToPlan(c, snap, []).type, "dismiss_overlay");
  });
});
