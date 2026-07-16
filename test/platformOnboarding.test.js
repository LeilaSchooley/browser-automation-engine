import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikePlatformOnboarding,
  platformOnboardingIncomplete,
  looksLikeJobBoardWelcomeConfirm,
  looksLikeDidYouApplyPrompt,
  looksLikeBoardSignupOnboarding,
  looksLikeJobApplicationPage,
} from "../src/platformOnboarding.js";
import { continueLoopStalled } from "../src/heuristics.js";
import { classifyApplyStep, stepToPlan } from "../src/layers/applyStep.js";

describe("platformOnboarding", () => {
  it("detects Jobright diagnostics onboarding", () => {
    const snap = {
      url: "https://jobright.ai/onboarding-v3/diagnostics?id=abc",
      hostname: "jobright.ai",
      pageText: "What type of role are you looking for? Job Type Open to Remote",
      continueCount: 1,
      continueCandidates: [{ text: "Next", score: 100 }],
      fields: [{ label: "Please select/enter your expected job function", type: "text" }],
    };
    assert.equal(looksLikePlatformOnboarding(snap), true);
    assert.equal(looksLikeBoardSignupOnboarding(snap), false);
    assert.equal(platformOnboardingIncomplete(snap, { filled: [] }), true);
  });

  it("detects Remote Rocketship /onboard/ as board signup trap", () => {
    const snap = {
      url: "https://www.remoterocketship.com/us/onboard/?type=tangent_new_layout&step=2",
      hostname: "www.remoterocketship.com",
      pageText: "How long have you been searching for a job? Looking for my first remote job. Next",
      continueCount: 1,
      continueCandidates: [{ text: "Next", score: 100 }],
      fields: [],
      fileInputCount: 0,
    };
    assert.equal(looksLikeBoardSignupOnboarding(snap), true);
    assert.equal(looksLikePlatformOnboarding(snap), false);
    assert.equal(looksLikeJobApplicationPage(snap), false);

    const c = classifyApplyStep(snap, { filled: [] }, [], {
      applicant: { email: "test@example.com" },
      submitUrl: "https://www.remoterocketship.com/jobs/trevor-project",
    });
    assert.equal(c.step, "nav_recovery");
    assert.match(c.reason, /board signup/i);
    assert.equal(stepToPlan(c, snap, [])?.type, "nav_recovery");
  });

  it("escalates board onboard to blocked after nav_recovery attempt", () => {
    const snap = {
      url: "https://www.remoterocketship.com/us/onboard/?step=3",
      hostname: "www.remoterocketship.com",
      pageText: "Join Remote Rocketship and find your dream job",
      continueCount: 1,
      continueCandidates: [{ text: "Next", score: 100 }],
      fields: [],
    };
    const c = classifyApplyStep(
      snap,
      { filled: [] },
      [{ action: "nav_recovery", ok: true, progress: true }],
      { applicant: { email: "a@b.com" } },
    );
    assert.equal(c.step, "blocked");
    assert.equal(stepToPlan(c, snap, [])?.type, "wait_user");
  });

  it("does not treat ATS apply form as board onboard", () => {
    const snap = {
      url: "https://jobs.ashbyhq.com/company/apply",
      hostname: "jobs.ashbyhq.com",
      pageText: "Upload resume Cover letter Work authorization EEOC",
      continueCount: 1,
      continueCandidates: [{ text: "Next", score: 100 }],
      fields: [{ label: "Resume", type: "file" }],
      fileInputCount: 1,
    };
    assert.equal(looksLikeJobApplicationPage(snap), true);
    assert.equal(looksLikeBoardSignupOnboarding(snap), false);
  });

  it("continueLoopStalled fires when filled=0 even if steps marked progress", () => {
    const history = [
      { action: "click_continue", ok: true, progress: true },
      { action: "click_continue", ok: true, progress: true },
      { action: "click_continue", ok: true, progress: true },
    ];
    assert.equal(continueLoopStalled(history, { filled: [] }, 3), true);
    assert.equal(continueLoopStalled(history, { filled: [{ type: "email" }] }, 3), false);
  });

  it("classifies filled onboarding as continue not review stop", () => {
    const snap = {
      url: "https://jobright.ai/onboarding-v3/diagnostics?id=abc",
      hostname: "jobright.ai",
      pageText: "What type of role are you looking for?",
      continueCount: 1,
      continueCandidates: [{ text: "Next", score: 100 }],
      fields: [{ label: "job function", type: "text", filled: true }],
    };
    const c = classifyApplyStep(
      snap,
      { filled: [{ type: "desiredtitle", label: "job function" }] },
      [{ action: "auth_signup", ok: true }],
      { applicant: { email: "test@example.com" } },
    );
    assert.equal(c.step, "continue");
  });

  it("detects and classifies Welcome Confirm & See Jobs modal", () => {
    const snap = {
      url: "https://jobright.ai/jobs/recommend?from=&id=abc",
      hostname: "jobright.ai",
      pageText:
        "Welcome! We found 3408 roles that fit you best. Take a moment to review. Confirm & See Jobs",
      continueCount: 1,
      continueCandidates: [{ text: "Confirm & See Jobs", score: 120 }],
      confirmCandidates: [{ text: "Confirm & See Jobs", score: 90 }],
    };
    assert.equal(looksLikeJobBoardWelcomeConfirm(snap), true);
    const c = classifyApplyStep(snap, { filled: [] }, [], { applicant: { email: "a@b.com" } });
    assert.equal(c.step, "continue");
    assert.match(c.reason, /welcome|Confirm/i);
    assert.equal(stepToPlan(c, snap, [])?.type, "click_continue");
  });

  it("classifies Did you apply? tracker as Not yet continue", () => {
    const snap = {
      url: "https://jobright.ai/jobs/recommend",
      hostname: "jobright.ai",
      pageKind: "modal",
      hasApplyModal: true,
      modalCount: 1,
      applyModalTitle: "Did you apply?",
      pageText: "Did you apply? Yes Not yet",
      interactives: [{ text: "Yes" }, { text: "Not yet" }],
      dismissCandidates: [{ text: "Not yet", score: 80 }],
    };
    assert.equal(looksLikeDidYouApplyPrompt(snap), true);
    const c = classifyApplyStep(snap, { filled: [] }, [], { applicant: { email: "a@b.com" } });
    assert.equal(c.step, "continue");
    assert.match(c.reason, /did-you-apply|Not yet/i);
    assert.equal(stepToPlan(c, snap, [])?.type, "click_continue");
  });
});
