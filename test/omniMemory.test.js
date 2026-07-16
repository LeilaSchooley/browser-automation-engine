import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findRelevantSkills,
  mergeSituationSkills,
  seedSituationSkillsForHost,
  findSituationMemoryPlan,
} from "../src/siteLearnings.js";
import { boardLeaveSucceeded, shouldBlockBoardSignupAfterLeave, continueLoopStalled } from "../src/heuristics.js";
import { classifyApplyStep, stepToPlan } from "../src/layers/applyStep.js";
import { pickBestAction } from "../src/layers/actionPicker.js";
import { RecoveryTracker } from "../src/recoveryTracker.js";
import { isEmployerAtsUrl, isBoardOnboardUrl } from "../src/layers/applyUrlSafety.js";
import { harvestSituationSkills } from "../src/learningRecorder.js";

describe("omni phase1 board leave + ATS", () => {
  it("detects employer ATS hosts", () => {
    assert.equal(isEmployerAtsUrl("https://jobs.lever.co/thetrevorproject/abc"), true);
    assert.equal(isEmployerAtsUrl("https://boards.greenhouse.io/x/jobs/1"), true);
    assert.equal(isBoardOnboardUrl("https://www.remoterocketship.com/us/onboard/?step=2"), true);
    assert.equal(isEmployerAtsUrl("https://www.remoterocketship.com/jobs/x"), false);
  });

  it("blocks signup after board leave", () => {
    const history = [{ action: "nav_recovery", ok: true, source: "leave_board_onboard" }];
    assert.equal(boardLeaveSucceeded(history), true);
    assert.equal(
      shouldBlockBoardSignupAfterLeave(history, {
        url: "https://www.remoterocketship.com/us/company/x/jobs/y",
      }),
      true,
    );
    const snap = {
      url: "https://www.remoterocketship.com/us/company/x/jobs/y",
      hostname: "www.remoterocketship.com",
      entryCount: 1,
      entryCandidates: [{ text: "Apply Now", score: 100 }],
      signUpCount: 1,
      pageText: "Apply Now Sign Up",
    };
    const c = classifyApplyStep(snap, { filled: [] }, history, {});
    assert.equal(c.step, "entry");
    assert.match(c.reason, /skip Sign Up|board leave/i);
  });

  it("RecoveryTracker escalates", () => {
    const t = new RecoveryTracker({ maxPerAction: 2 });
    t.record("click_signup", "fp1");
    assert.equal(t.escalate("click_signup", "fp1"), "continue");
    t.record("click_signup", "fp1");
    assert.equal(t.escalate("click_signup", "fp1", { hasUsedStagehand: false }), "stagehand");
    assert.equal(t.escalate("click_signup", "fp1", { hasUsedStagehand: true }), "wait_user");
  });
});

describe("omni phase2 situation skills", () => {
  it("seeds and retrieves remoterocketship onboard skill", () => {
    const seeds = seedSituationSkillsForHost("www.remoterocketship.com");
    assert.ok(seeds.length >= 1);
    const snap = {
      url: "https://www.remoterocketship.com/us/onboard/?step=2",
      hostname: "www.remoterocketship.com",
      pageText: "How long have you been searching for a job? Next",
      continueCount: 1,
    };
    const relevant = findRelevantSkills(snap, { situationSkills: [] }, { limit: 3 });
    assert.ok(relevant.some((s) => s.signature === "board_signup_onboarding"));
    assert.ok(relevant[0].action === "nav_recovery" || relevant.some((s) => s.action === "nav_recovery"));
  });

  it("picker avoids click_signup when situation skill says so", () => {
    const snap = {
      url: "https://www.remoterocketship.com/us/company/x/jobs/y",
      hostname: "www.remoterocketship.com",
      pageText: "Apply Now Sign Up",
    };
    const catalog = [
      { id: "click_signup", type: "click_signup", score: 80, reason: "signup" },
      { id: "click_apply", type: "click_apply", score: 70, reason: "apply" },
    ];
    const plan = pickBestAction(catalog, {
      snap,
      history: [],
      fillResult: { filled: [] },
      context: {
        siteLearnings: {
          situationSkills: mergeSituationSkills([], seedSituationSkillsForHost("remoterocketship.com")),
        },
      },
      classification: { step: "entry", confidence: "high" },
    });
    assert.equal(plan?.type, "click_apply");
  });

  it("harvests board leave skills", () => {
    const { skills } = harvestSituationSkills({
      history: [{ action: "nav_recovery", ok: true, source: "leave_board_onboard" }],
      host: "remoterocketship.com",
      outcome: "review",
    });
    assert.ok(skills.some((s) => s.signature === "board_signup_onboarding"));
    assert.ok(skills.some((s) => s.signature === "board_leave_skip_signup"));
  });

  it("situation memory plan fires for high-conf onboard", () => {
    const snap = {
      url: "https://www.remoterocketship.com/us/onboard/?step=1",
      hostname: "www.remoterocketship.com",
      pageText: "How long have you been searching Looking for my first remote",
    };
    const catalog = [{ type: "nav_recovery", score: 50, reason: "leave" }];
    const plan = findSituationMemoryPlan(snap, { situationSkills: [] }, catalog);
    assert.ok(plan);
    assert.equal(plan.source, "situation-memory");
    assert.equal(plan.type, "nav_recovery");
  });
});

describe("omni continueLoop", () => {
  it("treats filled=0 continue as stall", () => {
    const history = [
      { action: "click_continue", progress: true },
      { action: "click_continue", progress: true },
      { action: "click_continue", progress: true },
    ];
    assert.equal(continueLoopStalled(history, { filled: [] }, 3), true);
  });
});
