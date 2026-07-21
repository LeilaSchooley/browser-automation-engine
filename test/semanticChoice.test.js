import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectPage } from "../src/layers/formDiscovery.js";
import {
  discoverCustomControlsFromSnap,
  fillCustomControls,
} from "../src/fillCustomControls.js";
import { mapApplicationLabelToMapped } from "../src/primitives/controlPatterns.js";
import { resolveApplicationAnswer } from "../src/fillApplicationAnswers.js";
import {
  collectUnmappedChoiceControls,
  buildChoiceSpecs,
  requiredHintsFromSnap,
  applyResolvedChoice,
} from "../src/layers/fillWidgets/choiceResolver.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initRuntime } from "../src/runtime.js";

describe("contractor collision — affiliation-shaped only", () => {
  it("does not map a bare 'Contractor' option to the affiliation yes/no", () => {
    assert.equal(mapApplicationLabelToMapped("Contractor"), null);
    assert.equal(mapApplicationLabelToMapped("Full-time employee"), null);
    assert.equal(mapApplicationLabelToMapped("Cofounder"), null);
    // The employment-type question itself maps (to employmenttype, not contractor).
    assert.equal(
      mapApplicationLabelToMapped("What type of role are you looking for?")?.mappedTo,
      "employmenttype",
    );
  });

  it("still maps genuine affiliation contractor questions", () => {
    const m = mapApplicationLabelToMapped(
      "Are you currently a contractor through a third party for Acme?",
    );
    assert.equal(m?.mappedTo, "contractor");
  });

  it("employmenttype resolves to a full-time employee option", () => {
    assert.equal(
      resolveApplicationAnswer("employmenttype", "What type of role are you looking for?", {}),
      "Full-time employee",
    );
  });
});

describe("WaaS Role — job_type checkbox + unmapped choice group", () => {
  it("maps job_type to employmenttype, never to contractor", async () => {
    await withFixturePage("waas-role-jobtype", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const controls = discoverCustomControlsFromSnap(snap);
      const mapped = new Set(controls.map((c) => c.mappedTo).filter(Boolean));
      assert.equal(mapped.has("contractor"), false, `got ${[...mapped]}`);
      assert.ok(mapped.has("employmenttype"), `got ${[...mapped]}`);
    });
  });

  it("fills job function, student, and full-time employee checkbox", async () => {
    await withFixturePage("waas-role-jobtype", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const result = await fillCustomControls(
        page,
        {
          preferences: {
            desiredTitle: "Founding Product Engineer",
            fullTimeStudent: false,
            jobFunction: "Engineering",
          },
        },
        { snap, log: null },
      );
      const filled = new Set(result.filled.map((f) => f.mappedTo));
      assert.ok(filled.has("jobfunction"), `filled=${[...filled]}`);
      assert.ok(filled.has("fulltimestudent"), `filled=${[...filled]}`);
      assert.ok(filled.has("employmenttype"), `filled=${[...filled]}`);
      assert.equal(await page.locator('input[name="job_function"][value="eng"]').isChecked(), true);
      assert.equal(await page.locator('input[name="student"][value="no"]').isChecked(), true);
      assert.equal(await page.locator('input[name="job_type[]"][value="fulltime"]').isChecked(), true);
      assert.equal(await page.locator('input[name="job_type[]"][value="contractor"]').isChecked(), false);
    });
  });

  it("surfaces the unmapped work-schedule group with real options", async () => {
    await withFixturePage("waas-role-jobtype", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const choices = collectUnmappedChoiceControls(snap);
      const schedule = choices.find((c) => /work schedule/i.test(c.questionLabel || ""));
      assert.ok(schedule, `unmapped choices=${choices.map((c) => c.questionLabel).join(" | ")}`);
      assert.equal(schedule.mappedTo, null);
      assert.ok(schedule.options.length >= 2);

      const specs = buildChoiceSpecs([schedule]);
      assert.ok(specs[0].options.includes("Flexible hours"));

      // Grounded apply: pick a real option and confirm the DOM reflects it.
      const ok = await applyResolvedChoice(page, schedule, "Flexible hours", null, snap);
      assert.equal(ok, true);
      assert.equal(await page.locator('input[name="work_schedule"][value="flexible"]').isChecked(), true);
    });
  });

  it("fills a react-select job-function combobox via the fallback", async () => {
    await withFixturePage("waas-role-reactselect", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const result = await fillCustomControls(
        page,
        { preferences: { desiredTitle: "Founding Product Engineer", jobFunction: "Engineering" } },
        { snap, log: null },
      );
      const filled = new Set(result.filled.map((f) => f.mappedTo));
      assert.ok(filled.has("jobfunction"), `filled=${[...filled]}`);
      assert.equal(await page.locator("#job_function").inputValue(), "eng");
    });
  });

  it("reads authoritative required hints from serverErrors", async () => {
    await withFixturePage("waas-role-jobtype", async (page) => {
      const { getAuthoritativeValidation } = await import("../src/siteAdapters/waasValidator.js");
      const snap = await inspectPage(page);
      snap.waasValidation = await getAuthoritativeValidation(page);
      const hints = requiredHintsFromSnap(snap);
      assert.ok(hints.includes("role"));
      assert.ok(hints.includes("job_type"));
      assert.ok(hints.includes("in_school"));
    });
  });
});
