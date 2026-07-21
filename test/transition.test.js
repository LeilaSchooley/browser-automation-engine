import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeStepIdentity,
  verifyAdvance,
  toTransitionResult,
  countUnverifiedAttempts,
} from "../src/layers/transition.js";

describe("transition contract", () => {
  it("normalizeStepIdentity extracts onboarding/application steps", () => {
    assert.equal(
      normalizeStepIdentity("https://weworkremotely.com/job-seekers/onboarding/step_1"),
      "onboarding:step_1",
    );
    assert.equal(
      normalizeStepIdentity("https://www.workatastartup.com/application/role"),
      "application:role",
    );
    assert.equal(normalizeStepIdentity("https://example.com/jobs/1/"), "/jobs/1");
  });

  it("verifyAdvance detects step identity change", () => {
    const v = verifyAdvance(
      { url: "https://weworkremotely.com/job-seekers/onboarding/step_1", fieldCount: 3 },
      { url: "https://weworkremotely.com/job-seekers/onboarding/step_2", fieldCount: 2 },
    );
    assert.equal(v.advanced, true);
    assert.match(v.reason, /step_identity/);
  });

  it("verifyAdvance rejects same-step click", () => {
    const v = verifyAdvance(
      { url: "https://weworkremotely.com/job-seekers/onboarding/step_1", fieldCount: 3, pageKind: "form" },
      { url: "https://weworkremotely.com/job-seekers/onboarding/step_1", fieldCount: 3, pageKind: "form" },
    );
    assert.equal(v.advanced, false);
  });

  it("verifyAdvance detects form fields appearing after Apply", () => {
    const v = verifyAdvance(
      { url: "https://jobs.example.com/x", fieldCount: 0, pageKind: "content" },
      { url: "https://jobs.example.com/x/apply", fieldCount: 5, pageKind: "form" },
    );
    assert.equal(v.advanced, true);
  });

  it("toTransitionResult marks stuck when clicked but not advanced", () => {
    const before = { url: "https://example.com/job/1", fieldCount: 0, pageKind: "content" };
    const after = { url: "https://example.com/job/1", fieldCount: 0, pageKind: "content" };
    const t = toTransitionResult({ clicked: true, before, after });
    assert.equal(t.clicked, true);
    assert.equal(t.advanced, false);
    assert.equal(t.stuck, true);
  });

  it("countUnverifiedAttempts tallies stuck apply clicks", () => {
    const fp = "abc";
    const n = countUnverifiedAttempts(
      [
        { action: "click_apply", fingerprint: fp, clicked: true, progress: false, advanced: false },
        { action: "click_apply", fingerprint: fp, clicked: true, progress: false, advanced: false },
        { action: "click_apply", fingerprint: "other", clicked: true, progress: false },
      ],
      fp,
      "click_apply",
    );
    assert.equal(n, 2);
  });
});
