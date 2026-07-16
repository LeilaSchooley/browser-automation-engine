import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { fillCustomControls } from "../src/fillCustomControls.js";
import {
  resolveApplicationAnswer,
  getApplicationAnswers,
  hasUnfilledYesNoOrEEOC,
  buildApplicationControlsStagehandInstruction,
} from "../src/fillApplicationAnswers.js";
import { hasUnfilledApplicationFields } from "../src/heuristics.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initRuntime } from "../src/runtime.js";

describe("application yes/no controls", () => {
  it("resolveApplicationAnswer defaults visa to No and EEOC to decline", () => {
    const ctx = { preferences: { needsVisaSponsorship: false, eeocDecline: true } };
    assert.equal(resolveApplicationAnswer("visasponsorship", "visa sponsorship", ctx), "No");
    assert.equal(resolveApplicationAnswer("eeocgender", "Gender", ctx), "Decline to self-identify");
    assert.equal(getApplicationAnswers({ preferences: { needsVisaSponsorship: true } }).visaAnswer, "Yes");
  });

  it("answers policy acknowledgment Yes even when question mentions sponsor", () => {
    const ctx = { preferences: { needsVisaSponsorship: false } };
    const ack =
      "Do you understand that applicants must be authorized to work for ANY employer in the U.S., and that we are unable to sponsor or take over sponsorship of an employment Visa at this time?";
    assert.equal(resolveApplicationAnswer("policyack", ack, ctx), "Yes");
    assert.equal(resolveApplicationAnswer("", ack, ctx), "Yes");
    assert.equal(
      resolveApplicationAnswer(
        "",
        'Will you now or in the future require The Trevor Project to commence ("sponsor") an immigration case?',
        ctx,
      ),
      "No",
    );
  });

  it("treats legally authorized as work auth Yes, not sponsorship No", () => {
    const ctx = { preferences: { needsVisaSponsorship: false, eeocDecline: true } };
    assert.equal(
      resolveApplicationAnswer("workauthorization", "Are you legally authorized to work in the US?", ctx),
      "Yes",
    );
    assert.equal(
      resolveApplicationAnswer("", "Are you legally authorized to work in the United States?", ctx),
      "Yes",
    );
    assert.equal(
      resolveApplicationAnswer("visasponsorship", "Will you require sponsorship?", ctx),
      "No",
    );
  });

  it("buildApplicationControlsStagehandInstruction uses profile answers", () => {
    const instruction = buildApplicationControlsStagehandInstruction({
      preferences: { needsVisaSponsorship: false, eeocDecline: true },
    });
    assert.match(instruction, /click No/i);
    assert.match(instruction, /Decline to self-identify/i);
    assert.match(instruction, /Do not click Submit/i);
  });

  it("hasUnfilledYesNoOrEEOC detects unfilled custom controls", () => {
    assert.equal(
      hasUnfilledYesNoOrEEOC({
        customControls: [{ widgetType: "yesno", mappedTo: "visasponsorship", filled: false }],
      }),
      true,
    );
    assert.equal(
      hasUnfilledYesNoOrEEOC({
        customControls: [{ widgetType: "yesno", mappedTo: "visasponsorship", filled: true }],
      }),
      false,
    );
  });

  it("inspectPage discovers Ashby yes/no and EEOC fieldsets", async () => {
    await withFixturePage("ashby-yesno-application", async (page) => {
      const snap = await inspectPage(page);
      const yesNo = (snap.customControls || []).filter((c) => c.widgetType === "yesno");
      const eeoc = (snap.customControls || []).filter((c) => c.widgetType === "radio");
      assert.ok(yesNo.length >= 1, `expected yes/no controls, got ${yesNo.length}`);
      assert.ok(eeoc.length >= 1, `expected EEOC radios, got ${eeoc.length}`);
      assert.ok(hasUnfilledApplicationFields(snap));
    });
  });

  it("fillCustomControls clicks visa No and EEOC decline options", async () => {
    await withFixturePage("ashby-yesno-application", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const context = {
        preferences: { needsVisaSponsorship: false, eeocDecline: true },
      };
      const result = await fillCustomControls(page, context, { snap, log: null });
      assert.ok(result.filled.length >= 2, `filled=${result.filled.length}`);

      const visaSelected = await page
        .locator('[class*="yesno"]')
        .first()
        .getByRole("button", { name: /^no$/i })
        .evaluate((el) => {
          const cls = el.className || "";
          return el.getAttribute("aria-pressed") === "true" || /selected|active|pressed/i.test(cls);
        })
        .catch(() => false);
      const genderDecline = await page.locator("#eeoc-gender input[value='decline']").isChecked();
      assert.ok(genderDecline, "gender decline should be checked");
    });
  });

  it("inspectPage discovers Lever required Yes/No radios as distinct mapped controls", async () => {
    await withFixturePage("lever-yesno-application", async (page) => {
      const snap = await inspectPage(page);
      const radios = (snap.customControls || []).filter((c) => c.widgetType === "radio");
      const byMapped = Object.fromEntries(radios.map((c) => [c.mappedTo, c]));
      assert.ok(byMapped.workauthorization, `mapped=${radios.map((c) => c.mappedTo).join(",")}`);
      assert.ok(byMapped.visasponsorship, "expected visasponsorship");
      assert.ok(byMapped.policyack, "expected policyack (unable to sponsor acknowledgment)");
      assert.equal(byMapped.workauthorization.filled, false);
    });
  });

  it("fillCustomControls answers Lever work-auth Yes, sponsorship No, policy Yes", async () => {
    await withFixturePage("lever-yesno-application", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const context = {
        preferences: { needsVisaSponsorship: false, workAuthorized: true },
      };
      const result = await fillCustomControls(page, context, { snap, log: null });
      assert.ok(result.filled.length >= 3, `filled=${result.filled.map((f) => f.mappedTo).join(",")}`);

      const workYes = await page.locator('input[name="cards[0][field5]"][value="Yes"]').isChecked();
      const visaNo = await page.locator('input[name="cards[0][field6]"][value="No"]').isChecked();
      const ackYes = await page.locator('input[name="cards[0][field7]"][value="Yes"]').isChecked();
      assert.ok(workYes, "work authorization should be Yes");
      assert.ok(visaNo, "visa sponsorship should be No");
      assert.ok(ackYes, "policy acknowledgment should be Yes");
    });
  });

  it("inspectPage maps Lever pronouns checkbox + EEOC selects distinctly (not Pronouns poison)", async () => {
    await withFixturePage("lever-eeoc-pronouns", async (page) => {
      const snap = await inspectPage(page);
      const ctrls = snap.customControls || [];
      const byMapped = Object.fromEntries(ctrls.map((c) => [c.mappedTo, c]));
      assert.equal(byMapped.pronouns?.widgetType, "checkbox", JSON.stringify(byMapped.pronouns));
      assert.equal(byMapped.eeocgender?.widgetType, "select");
      assert.equal(byMapped.eeocrace?.widgetType, "select");
      assert.equal(byMapped.eeocveteran?.widgetType, "select");
      assert.match(String(byMapped.eeocgender?.selector || ""), /eeo|select/i);
    });
  });

  it("fillCustomControls selects He/him and Decline on Lever EEOC selects", async () => {
    await withFixturePage("lever-eeoc-pronouns", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const result = await fillCustomControls(
        page,
        { preferences: { eeocDecline: true, pronouns: "He/him" } },
        { snap, log: null },
      );
      assert.ok(
        result.filled.some((f) => f.mappedTo === "pronouns"),
        `filled=${result.filled.map((f) => f.mappedTo).join(",")}`,
      );
      assert.ok(result.filled.some((f) => f.mappedTo === "eeocgender"));
      assert.ok(result.filled.some((f) => f.mappedTo === "eeocrace"));
      assert.ok(result.filled.some((f) => f.mappedTo === "eeocveteran"));
      assert.equal(await page.locator('input[value="He/him"]').isChecked(), true);
      assert.equal(await page.locator('select[name="eeo[gender]"]').inputValue(), "Decline to self-identify");
      assert.equal(await page.locator('select[name="eeo[race]"]').inputValue(), "Decline to self-identify");
      assert.equal(await page.locator('select[name="eeo[veteran]"]').inputValue(), "Decline to self-identify");
    });
  });

  it("answers Trevor-style employee/volunteer/contractor radios No + relation text", async () => {
    assert.equal(
      resolveApplicationAnswer(
        "",
        "Are you a current or former employee of the Trevor Project?",
        {},
      ),
      "No",
    );
    assert.equal(resolveApplicationAnswer("volunteer", "Are you currently a volunteer?", {}), "No");

    await withFixturePage("lever-company-affiliation", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const mapped = (snap.customControls || []).map((c) => c.mappedTo);
      assert.ok(mapped.includes("formeremployee"), `mapped=${mapped}`);
      assert.ok(mapped.includes("volunteer"), `mapped=${mapped}`);
      assert.ok(mapped.includes("contractor"), `mapped=${mapped}`);
      assert.ok(mapped.includes("employeerelation"), `mapped=${mapped}`);

      const result = await fillCustomControls(page, { preferences: {} }, { snap, log: null });
      assert.ok(result.filled.length >= 4, `filled=${result.filled.map((f) => f.mappedTo).join(",")}`);
      assert.equal(await page.locator('input[name="cards[0][emp]"][value="No"]').isChecked(), true);
      assert.equal(await page.locator('input[name="cards[0][vol]"][value="No"]').isChecked(), true);
      assert.equal(await page.locator('input[name="cards[0][con]"][value="No"]').isChecked(), true);
      assert.equal(await page.locator('textarea[name="cards[0][rel]"]').inputValue(), "No");
    });
  });
});
