import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectPage } from "../src/layers/formDiscovery.js";
import {
  discoverCustomControlsFromSnap,
  discoverScreeningControlsFromSnap,
  fillCustomControls,
} from "../src/fillCustomControls.js";
import { fillWaasRoleMissing } from "../src/siteAdapters/waasRoleFields.js";
import { getAuthoritativeValidation } from "../src/siteAdapters/waasValidator.js";
import { runSmartFill } from "../src/smartFill.js";
import { attemptApplicationControlsStagehand } from "../src/layers/stagehandPolicy.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initRuntime } from "../src/runtime.js";

const ROLE_CTX = {
  preferences: {
    desiredTitle: "Founding Product Engineer",
    fullTimeStudent: false,
    jobFunction: "Engineering",
  },
};

describe("WaaS Role — live DOM shape", () => {
  it("maps employmenttype as checkbox, not phantom radio heuristic", async () => {
    await withFixturePage("waas-role-live", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false, ai_fill_enabled: false } });
      const snap = await inspectPage(page);
      snap.url = "https://www.workatastartup.com/application/role";
      snap.waasValidation = await getAuthoritativeValidation(page);

      const fromSnap = (snap.customControls || []).filter((c) => c.mappedTo === "employmenttype");
      assert.ok(fromSnap.length >= 1, "scanDom should emit employmenttype");
      assert.equal(fromSnap[0].widgetType, "checkbox");

      const heuristic = discoverScreeningControlsFromSnap(snap).filter((c) => c.mappedTo === "employmenttype");
      assert.equal(heuristic.length, 0, "must not invent radio employmenttype heuristic");
    });
  });

  it("fillWaasRoleMissing fills role, in_school, and job_type by field name", async () => {
    await withFixturePage("waas-role-live", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false, ai_fill_enabled: false } });
      const snap = await inspectPage(page);
      snap.url = "https://www.workatastartup.com/application/role";
      snap.waasValidation = await getAuthoritativeValidation(page);

      const result = await fillWaasRoleMissing(page, snap, ROLE_CTX, null);
      assert.ok(result.ok, `filled=${JSON.stringify(result.filled)}`);
      assert.equal(await page.locator('input[name="role"][value="eng"]').isChecked(), true);
      assert.equal(await page.locator('input[name="in_school"][value="no"]').isChecked(), true);
      assert.equal(await page.locator('input[name="job_type"][value="fulltime"]').isChecked(), true);
    });
  });

  it("fillCustomControls fills employmenttype via checkbox on live copy", async () => {
    await withFixturePage("waas-role-live", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false, ai_fill_enabled: false } });
      await page.locator('input[name="role"][value="eng"]').click();
      const snap = await inspectPage(page);
      snap.url = "https://www.workatastartup.com/application/role";

      const result = await fillCustomControls(page, ROLE_CTX, { snap, log: null });
      const filled = new Set(result.filled.map((f) => f.mappedTo));
      const unfilledEmp = result.unfilled.filter((u) => u.mappedTo === "employmenttype");
      assert.ok(filled.has("employmenttype") || unfilledEmp.every((u) => u.widgetType === "checkbox"), `filled=${[...filled]}`);
      if (filled.has("employmenttype")) {
        assert.equal(await page.locator('input[name="job_type"][value="fulltime"]').isChecked(), true);
      }
    });
  });

  it("runSmartFill uses waas fast path on role step", async () => {
    await withFixturePage("waas-role-live", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false, ai_fill_enabled: false } });
      const snap = await inspectPage(page);
      snap.url = "https://www.workatastartup.com/application/role";
      snap.waasValidation = await getAuthoritativeValidation(page);

      const result = await runSmartFill(page, ROLE_CTX, null, { snap });
      const sources = new Set((result.filled || []).map((f) => f.source));
      assert.ok(
        sources.has("waas_role") || (result.filled || []).length >= 2,
        `filled sources=${[...sources]} count=${result.filled?.length}`,
      );
      assert.equal(await page.locator('input[name="role"][value="eng"]').isChecked(), true);
    });
  });

  it("detects engroles control after engineering selected", async () => {
    await withFixturePage("waas-role-live", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      await page.locator('input[name="role"][value="eng"]').click();
      const snap = await inspectPage(page);
      const eng = (snap.customControls || []).find((c) => c.mappedTo === "engroles");
      assert.ok(eng, `controls=${(snap.customControls || []).map((c) => c.mappedTo).join(",")}`);
      assert.equal(eng.widgetType, "combobox");
      assert.ok(eng.multiple);
    });
  });

  it("skips work-auth Stagehand fallback on Role step", async () => {
    await withFixturePage("waas-role-live", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      snap.url = "https://www.workatastartup.com/application/role";
      snap.customControls = [{ mappedTo: "fulltimestudent", widgetType: "yesno", filled: false }];
      const result = await attemptApplicationControlsStagehand(page, ROLE_CTX, {
        snap,
        log: null,
        history: [],
      });
      assert.equal(result.reason, "waas_role_step");
    });
  });

  it("forces in_school=No when Yes is stuck and empties school path", async () => {
    await withFixturePage("waas-role-student-path", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false, ai_fill_enabled: false } });
      assert.equal(await page.locator('input[name="in_school"][value="yes"]').isChecked(), true);
      const snap = await inspectPage(page);
      snap.url = "https://www.workatastartup.com/application/role";
      snap.waasValidation = { available: true, missing: [], activeSection: "role" };

      const result = await fillWaasRoleMissing(page, snap, ROLE_CTX, null);
      assert.ok(result.ok);
      assert.equal(await page.locator('input[name="in_school"][value="no"]').isChecked(), true);
    });
  });

  it("fills school name when student path stays open for a student", async () => {
    await withFixturePage("waas-role-student-path", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false, ai_fill_enabled: false } });
      const snap = await inspectPage(page);
      snap.url = "https://www.workatastartup.com/application/role";
      snap.waasValidation = { available: true, missing: [], activeSection: "role" };

      const result = await fillWaasRoleMissing(
        page,
        snap,
        {
          preferences: {
            desiredTitle: "Intern",
            fullTimeStudent: true,
            education: "BSc Computer Science | Sheffield College | 2024",
            roleInterest: "fulltime",
          },
        },
        null,
      );
      assert.ok(result.ok);
      assert.equal(await page.locator('input[name="in_school"][value="yes"]').isChecked(), true);
      assert.equal(await page.locator('input[name="school_name"]').inputValue(), "Sheffield College");
      assert.equal(await page.locator('input[name="role_interest"][value="fulltime"]').isChecked(), true);
    });
  });
});
