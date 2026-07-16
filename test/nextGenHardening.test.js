import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, before, after } from "node:test";
import { looksLikeClosedJobListing, isResumeReviewUpsell, textMatchesInterstitialDismiss } from "../src/heuristics.js";
import { classifyApplyStep } from "../src/layers/applyStep.js";
import { initRuntime } from "../src/runtime.js";
import { findApiSkill, loadApiSkills, saveApiSkill } from "../src/networkSkills.js";
import { pickBestAction } from "../src/layers/actionPicker.js";

describe("closed job + Jobright Orion", () => {
  it("detects Jobright 'This job has closed' even with recommended jobs present", () => {
    const snap = {
      url: "https://jobright.ai/jobs/info/6a286da82d6c332ee52e5fcb",
      hostname: "jobright.ai",
      pageText:
        "This job has closed. Technical Support Specialist Baker Tilly Recommended Liked Applied Orion Boost Your Resume Here",
      title: "Technical Support Specialist",
    };
    const closed = looksLikeClosedJobListing(snap);
    assert.equal(closed.closed, true);
    assert.match(closed.reason, /closed|recommended substitutes/i);
  });

  it("classifies closed Jobright listing as blocked hardStop", () => {
    const snap = {
      url: "https://jobright.ai/jobs/info/abc",
      hostname: "jobright.ai",
      pageText: "This job has closed. Recommended jobs below",
      fieldCount: 0,
      entryCount: 0,
      passwordFieldCount: 0,
      fileInputCount: 0,
    };
    const c = classifyApplyStep(snap, {}, [], {});
    assert.equal(c.step, "blocked");
    assert.equal(c.hardStop, true);
  });

  it("detects Orion boost resume upsell and EXIT dismiss", () => {
    const snap = {
      applyModalTitle: "Orion",
      pageText: "Boost Your Resume Here! Customizing your resume just got easier.",
      hasBlockingOverlay: true,
      modalCount: 1,
      dismissCandidates: [{ text: "EXIT" }],
    };
    assert.equal(isResumeReviewUpsell(snap), true);
    assert.equal(textMatchesInterstitialDismiss("EXIT"), true);
  });

  it("does not treat listing chrome with Apply Now as resume upsell", () => {
    const snap = {
      pageKind: "listing",
      pageText:
        "Data Operations Associate Apply Now Subscribe to job alerts Boost your career newsletter signup",
      entryCount: 1,
      entryCandidates: [{ text: "Apply Now", score: 107 }],
      hasBlockingOverlay: false,
      modalCount: 0,
      hasApplyModal: false,
      dismissCandidates: [],
    };
    assert.equal(isResumeReviewUpsell(snap), false);
  });

  it("breaks dismiss loop toward Apply when entry remains", async () => {
    const { dismissLoopStalled } = await import("../src/heuristics.js");
    const history = [
      { action: "dismiss_overlay", progress: false, ok: true },
      { action: "dismiss_overlay", progress: false, ok: true },
    ];
    assert.equal(dismissLoopStalled(history, 2), true);
    const snap = {
      pageText: "Apply Now Subscribe",
      entryCount: 1,
      entryCandidates: [{ text: "Apply Now", score: 100 }],
      hasBlockingOverlay: false,
      modalCount: 0,
    };
    const c = classifyApplyStep(snap, {}, history, {});
    // Without upsell signals, classification should prefer entry — or at least not overlay-only loop.
    assert.notEqual(c.step, "overlay");
  });
});

describe("action-driven picker retrieval", () => {
  it("boosts dismiss when siteLearnings has upsell_dismiss", () => {
    const catalog = [
      { id: "smart_fill", type: "smart_fill", score: 70, reason: "fill", step: "form" },
      { id: "dismiss_resume_upsell", type: "dismiss_overlay", score: 72, reason: "dismiss", step: "overlay" },
    ];
    const plan = pickBestAction(catalog, {
      classification: { step: "overlay", confidence: "high" },
      history: [],
      snap: {},
      context: {
        siteLearnings: {
          affordanceSkills: [{ intent: "upsell_dismiss", successCount: 2 }],
        },
      },
    });
    assert.equal(plan?.type, "dismiss_overlay");
  });
});

describe("network skills spike", () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "api-skills-"));
    initRuntime({ settings: { api_skills_path: path.join(tmp, "api_skills.json") } });
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("saves and finds API skills per host", () => {
    saveApiSkill("example.com", {
      method: "POST",
      url: "https://example.com/api/submit",
      path: "/api/submit",
      intent: "submit_listing",
    });
    saveApiSkill("example.com", {
      method: "POST",
      url: "https://example.com/api/submit",
      path: "/api/submit",
      intent: "submit_listing",
    });
    const skill = findApiSkill("example.com", "submit");
    assert.ok(skill);
    assert.equal(skill.successCount, 2);
    assert.ok(loadApiSkills().hosts["example.com"]?.skills?.length >= 1);
  });
});
