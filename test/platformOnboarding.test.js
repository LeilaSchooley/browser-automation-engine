import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  looksLikePlatformOnboarding,
  platformOnboardingIncomplete,
  looksLikeJobBoardWelcomeConfirm,
  looksLikeDidYouApplyPrompt,
} from "../src/platformOnboarding.js";
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
    assert.equal(platformOnboardingIncomplete(snap, { filled: [] }), true);
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
