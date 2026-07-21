import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assessCompletenessFromSnap,
  getAuthoritativeRequiredKeys,
  listMissingFromSnap,
} from "../src/layers/CompletenessOracle.js";
import {
  sortChronologically,
  isAlreadyCommitted,
  missingFingerprint,
} from "../src/layers/universalFillPipeline.js";

describe("CompletenessOracle", () => {
  it("reports complete when steppedForm SSOT would (WaaS Role-shaped)", () => {
    const snap = {
      url: "https://www.workatastartup.com/application/role",
      hostname: "workatastartup.com",
      continueCount: 1,
      continueCandidates: [{ disabled: false }],
      customControls: [
        { mappedTo: "jobfunction", filled: true, widgetType: "radio" },
        { mappedTo: "employmenttype", filled: true, widgetType: "checkbox" },
        { mappedTo: "fulltimestudent", filled: true, widgetType: "radio" },
      ],
      waasValidation: {
        available: true,
        missing: [],
        visibleRequiredCount: 0,
        isSectionComplete: true,
      },
      fields: [],
    };
    const result = assessCompletenessFromSnap(snap);
    assert.equal(result.complete, true);
    assert.ok(result.reason);
    assert.deepEqual(result.missing, []);
  });

  it("lists authoritative missing keys and stays incomplete", () => {
    const snap = {
      url: "https://www.workatastartup.com/application/role",
      hostname: "workatastartup.com",
      continueCount: 1,
      continueCandidates: [{ disabled: false }],
      customControls: [
        { mappedTo: "jobfunction", filled: false, required: true },
        { mappedTo: "employmenttype", filled: false, required: true },
      ],
      waasValidation: {
        available: true,
        missing: ["job_function", "job_type"],
        visibleRequiredCount: 2,
        isSectionComplete: false,
      },
      fields: [],
    };
    const result = assessCompletenessFromSnap(snap);
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes("job_function") || result.missing.includes("jobfunction"));
    const keys = getAuthoritativeRequiredKeys(snap);
    assert.deepEqual(keys, ["job_function", "job_type"]);
  });

  it("prefers learned requiredOrder over snap customs", () => {
    const snap = {
      customControls: [
        { mappedTo: "techskills", filled: false },
        { mappedTo: "jobfunction", filled: false },
      ],
    };
    const learned = { requiredOrder: ["jobfunction", "employmenttype", "techskills"] };
    assert.deepEqual(getAuthoritativeRequiredKeys(snap, learned), [
      "jobfunction",
      "employmenttype",
      "techskills",
    ]);
  });

  it("never marks board signup onboarding as complete", () => {
    const snap = {
      url: "https://remoterocketship.com/us/onboard/",
      title: "Join Remote Rocketship",
      pageText: "How long have you been searching? Looking for my first remote job.",
      continueCount: 1,
      continueCandidates: [{ disabled: false }],
      fieldCount: 2,
      fields: [],
      customControls: [],
    };
    const result = assessCompletenessFromSnap(snap);
    assert.equal(result.complete, false);
    assert.match(result.reason, /not_applicable|incomplete|board/i);
  });
});

describe("universalFillPipeline", () => {
  it("sortChronologically puts name/email before role/skills", () => {
    const ordered = sortChronologically([
      { mappedTo: "techskills", label: "Skills" },
      { mappedTo: "fullname", label: "Full name" },
      { mappedTo: "jobfunction", label: "Role" },
      { mappedTo: "email", label: "Email" },
    ]);
    assert.deepEqual(
      ordered.map((c) => c.mappedTo),
      ["fullname", "email", "jobfunction", "techskills"],
    );
  });

  it("sortChronologically respects preferredOrder first", () => {
    const ordered = sortChronologically(
      [
        { mappedTo: "email" },
        { mappedTo: "fullname" },
        { mappedTo: "techskills" },
      ],
      ["techskills", "fullname", "email"],
    );
    assert.deepEqual(
      ordered.map((c) => c.mappedTo),
      ["techskills", "fullname", "email"],
    );
  });

  it("isAlreadyCommitted skips filled radios/chips", () => {
    assert.equal(isAlreadyCommitted({ mappedTo: "jobfunction", filled: true }), true);
    assert.equal(isAlreadyCommitted({ mappedTo: "jobfunction", filled: false }), false);
    assert.equal(isAlreadyCommitted({ mappedTo: "city", value: "Berlin", widgetType: "text" }), true);
  });

  it("missingFingerprint detects thrash (unchanged missing)", () => {
    const a = missingFingerprint(["job_type", "job_function"]);
    const b = missingFingerprint(["job_function", "job_type"]);
    const c = missingFingerprint(["job_type"]);
    assert.equal(a, b);
    assert.notEqual(a, c);
  });

  it("listMissingFromSnap includes unfilled screening mappedTo", () => {
    const missing = listMissingFromSnap({
      customControls: [
        { mappedTo: "techskills", filled: false },
        { mappedTo: "location", filled: true },
      ],
      waasValidation: { missing: [] },
    });
    assert.ok(missing.includes("techskills"));
    assert.ok(!missing.includes("location"));
  });
});
