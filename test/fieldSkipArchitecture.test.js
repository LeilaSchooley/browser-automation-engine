import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mapByFieldName, normalizeFieldName, STRONG_NAME_MAP } from "../src/patterns/fieldNameMap.js";
import { isStepComplete } from "../src/layers/steppedForm.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initRuntime } from "../src/runtime.js";

describe("name-based field map", () => {
  it("maps common ATS name attributes before labels matter", () => {
    assert.equal(mapByFieldName("role")?.mappedTo, "jobfunction");
    assert.equal(mapByFieldName("job_type[]")?.mappedTo, "employmenttype");
    assert.equal(mapByFieldName("in_school")?.mappedTo, "fulltimestudent");
    assert.equal(mapByFieldName("school_name")?.mappedTo, "schoolname");
    assert.equal(mapByFieldName("eng_type")?.mappedTo, "engroles");
    assert.equal(normalizeFieldName("job_type[0]"), "job_type");
    assert.ok(Object.keys(STRONG_NAME_MAP).length >= 8);
  });

  it("scanDom prefers name=role over ambiguous labels", async () => {
    await withFixturePage("waas-role-live", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const job = (snap.customControls || []).find((c) => c.mappedTo === "jobfunction");
      assert.ok(job, "expected jobfunction from name=role");
      const student = (snap.customControls || []).find((c) => c.mappedTo === "fulltimestudent");
      assert.ok(student, "expected fulltimestudent from name=in_school");
    });
  });
});

describe("true step completeness", () => {
  it("does not treat Continue-enabled alone as complete when required natives remain", () => {
    const snap = {
      url: "https://example.com/apply",
      continueCount: 1,
      continueCandidates: [{ disabled: false }],
      fields: [{ type: "text", label: "School Name", required: true, filled: false }],
      customControls: [],
    };
    assert.equal(isStepComplete(snap), false);
  });

  it("blocks when visibleRequiredCount > 0 even without serverErrors", () => {
    const snap = {
      url: "https://www.workatastartup.com/application/role",
      continueCount: 1,
      continueCandidates: [{ disabled: false }],
      fields: [],
      customControls: [],
      waasValidation: {
        available: true,
        missing: [],
        visibleRequiredCount: 3,
        isSectionComplete: false,
      },
    };
    assert.equal(isStepComplete(snap), false);
  });
});
