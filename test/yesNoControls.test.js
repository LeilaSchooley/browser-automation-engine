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
});
