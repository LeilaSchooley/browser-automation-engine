import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectProfileSetupFromSnap, looksLikeProfileSetup } from "../src/patterns/profileSetup.js";
import { classifyPageRoleFromSnap } from "../src/layers/classifyPageRole.js";
import { getCoreProfile, PROFILE_REQUIRED_ORDER } from "../src/layers/profileFill.js";
import { evaluateReadyForReview } from "../src/layers/agent/progressAndDone.js";
import {
  assessProfileSetupCompleteness,
  assessCompletenessFromSnap,
} from "../src/layers/CompletenessOracle.js";

describe("profile setup detector", () => {
  it("detects WWR onboarding step_1", () => {
    const snap = {
      url: "https://weworkremotely.com/job-seekers/onboarding/step_1",
      pageText: "Step 1 of 3. About you. Target job title. Your full name *",
      fieldCount: 3,
      fields: [
        { type: "text", label: "Target job title" },
        { type: "text", label: "Your full name *" },
        { type: "submit", label: "Upload Your Resume/CV" },
      ],
      continueCount: 1,
      fileInputCount: 1,
    };
    const d = detectProfileSetupFromSnap(snap);
    assert.equal(d.isProfileSetup, true);
    assert.equal(looksLikeProfileSetup(snap), true);
    assert.equal(classifyPageRoleFromSnap(snap).role, "profile_setup");
  });

  it("does not treat Greenhouse apply as profile setup", () => {
    const snap = {
      url: "https://boards.greenhouse.io/acme/jobs/123",
      pageText: "Submit application. Cover letter. EEOC equal employment.",
      fieldCount: 8,
      fileInputCount: 1,
    };
    assert.equal(detectProfileSetupFromSnap(snap).isProfileSetup, false);
    assert.equal(classifyPageRoleFromSnap(snap).role, "job_application");
  });
});

describe("core profile + review gate", () => {
  it("builds core profile from applicant + prefs", () => {
    const core = getCoreProfile({
      applicant: { fullName: "Isaac Boadi", email: "a@b.com", city: "London" },
      preferences: { desiredTitle: "Sourcing Specialist", salary: "$80k-$100k" },
      job: { title: "Strategic Sourcing Specialist" },
    });
    assert.equal(core.fullName, "Isaac Boadi");
    assert.equal(core.desiredTitle, "Sourcing Specialist");
    assert.equal(core.salaryRange, "$80k-$100k");
    assert.ok(core.experienceLevel);
    assert.ok(core.jobStatus);
    assert.ok(PROFILE_REQUIRED_ORDER.includes("experiencelevel"));
  });

  it("does not hand off for review mid onboarding", () => {
    const { readyForReview } = evaluateReadyForReview({
      snapAfter: {
        url: "https://weworkremotely.com/job-seekers/onboarding/step_1",
        pageText: "Step 1 of 3 About you",
        fieldCount: 3,
        fields: [{ label: "Your full name *" }],
        continueCount: 1,
      },
      fillResult: { filled: [{ type: "fullname" }, { type: "desiredtitle" }, { type: "resume" }] },
      history: [{ action: "auth_login", ok: true }],
      progressed: true,
      ok: true,
    });
    assert.equal(readyForReview, false);
  });
});

describe("profile CompletenessOracle", () => {
  it("blocks continue when validation errors are visible", () => {
    const snap = {
      url: "https://weworkremotely.com/job-seekers/onboarding/step_1",
      pageText: "Step 1 of 3. Please correct the following errors: Name can't be blank",
      fields: [
        { type: "text", label: "Your full name *", required: true, filled: false, value: "" },
        { type: "text", label: "Target job title", filled: true, value: "Designer" },
      ],
      continueCount: 1,
      fileInputCount: 1,
    };
    const profile = assessProfileSetupCompleteness(snap, { filled: [{ type: "desiredtitle" }] });
    assert.equal(profile?.complete, false);
    assert.ok(profile?.missing.includes("validation_errors") || profile?.missing.includes("fullname"));
    const overall = assessCompletenessFromSnap(snap, { filled: [{ type: "desiredtitle" }] });
    assert.equal(overall.complete, false);
  });

  it("requires empty labeled experience/status fields when present", () => {
    const snap = {
      url: "https://weworkremotely.com/job-seekers/onboarding/step_1",
      pageText: "Step 1 of 3 About you Experience level Job status",
      fields: [
        { type: "text", label: "Your full name *", required: true, filled: true, value: "Isaac" },
        { type: "text", label: "Target job title", filled: true, value: "Designer" },
        { type: "select", label: "Experience level", filled: false, value: "" },
        { type: "select", label: "Job status", filled: false, value: "" },
      ],
      continueCount: 1,
      fileInputCount: 1,
    };
    const profile = assessProfileSetupCompleteness(snap, {
      filled: [{ type: "fullname" }, { type: "desiredtitle" }, { type: "resume" }],
    });
    assert.equal(profile?.complete, false);
    assert.ok(profile?.missing.includes("experiencelevel"));
    assert.ok(profile?.missing.includes("jobstatus"));
  });

  it("falls through when labeled fields are covered", () => {
    const snap = {
      url: "https://weworkremotely.com/job-seekers/onboarding/step_1",
      pageText: "Step 1 of 3 About you resume.pdf",
      fields: [
        { type: "text", label: "Your full name *", required: true, filled: true, value: "Isaac" },
        { type: "text", label: "Target job title", filled: true, value: "Designer" },
      ],
      continueCount: 1,
      continueCandidates: [{ disabled: false }],
      fileInputCount: 1,
      customControls: [],
    };
    const profile = assessProfileSetupCompleteness(snap, {
      filled: [{ type: "fullname" }, { type: "desiredtitle" }, { type: "resume" }],
    });
    assert.equal(profile, null); // fall through to steppedForm SSOT
  });
});
