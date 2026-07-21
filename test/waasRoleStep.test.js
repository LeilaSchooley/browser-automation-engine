import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectPage } from "../src/layers/formDiscovery.js";
import {
  discoverCustomControlsFromSnap,
  discoverScreeningControlsFromSnap,
  fillCustomControls,
} from "../src/fillCustomControls.js";
import { isStepComplete } from "../src/layers/steppedForm.js";
import { isCommittedValue } from "../src/primitives/controlPatterns.js";
import { resolveJobFunctionAnswer, resolveRoleInterestAnswer } from "../src/patterns/applicationScreening.js";
import { getAuthoritativeValidation } from "../src/siteAdapters/waasValidator.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initRuntime } from "../src/runtime.js";

describe("WaaS Role step — no phantom location / school poison", () => {
  it("does not invent location from sidebar pageText alone", async () => {
    await withFixturePage("waas-role-step", async (page) => {
      const snap = await inspectPage(page);
      // Inject nav "Location" into pageText the way a full body scan would.
      snap.pageText = `${snap.pageText || ""} Personal Info Location Role`;
      const heuristic = discoverScreeningControlsFromSnap(snap);
      assert.equal(
        heuristic.some((c) => c.mappedTo === "location"),
        false,
        `must not invent location; got ${heuristic.map((c) => c.mappedTo).join(",")}`,
      );
    });
  });

  it("rejects school names as committed location values", () => {
    assert.equal(isCommittedValue("London School of Jewish Studies", "location"), false);
    assert.equal(isCommittedValue("London, UK", "location"), true);
  });

  it("infers Engineering from Founding Product Engineer title", () => {
    assert.equal(resolveJobFunctionAnswer("Founding Product Engineer"), "Engineering");
    assert.equal(resolveRoleInterestAnswer("fulltime"), "A full-time role after graduation");
  });

  it("discovers job function + student and fills Engineering + student No", async () => {
    await withFixturePage("waas-role-step", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const v = await getAuthoritativeValidation(page);
      snap.waasValidation = v;
      assert.equal(isStepComplete(snap), false, "Required markers → incomplete");

      const targets = discoverCustomControlsFromSnap(snap);
      const mapped = new Set(targets.map((c) => c.mappedTo));
      assert.equal(mapped.has("location"), false, "no phantom location");
      assert.ok(mapped.has("jobfunction") || mapped.has("fulltimestudent"), `got ${[...mapped]}`);

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
      assert.equal(await page.locator('input[name="job_function"][value="eng"]').isChecked(), true);
      assert.equal(await page.locator('input[name="student"][value="no"]').isChecked(), true);
      // School block stays hidden when student=No — never type LONDON into it.
      assert.equal(await page.locator("#school-block").isHidden(), true);
    });
  });
});
