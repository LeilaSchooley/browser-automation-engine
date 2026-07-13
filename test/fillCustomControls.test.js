import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverCustomControlsFromSnap, fillCustomControls, readLiveControlValue } from "../src/fillCustomControls.js";
import { extractSalaryDisplay } from "../src/primitives/controlPatterns.js";
import { mergeControlSkills } from "../src/siteLearnings.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initRuntime } from "../src/runtime.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { shouldBlockAdvance } from "../src/gateComplete.js";
import { executePlan } from "../src/layers/executePlan.js";

describe("fillCustomControls", () => {
  it("extractSalaryDisplay strips floating labels", () => {
    assert.equal(extractSalaryDisplay("Salary expectations USD 60,000 - 80,000"), "USD 60,000 - 80,000");
    assert.equal(extractSalaryDisplay("?"), "");
  });

  it("discoverCustomControlsFromSnap uses snapshot customControls", () => {
    const snap = {
      customControls: [{ label: "Salary expectations", mappedTo: "salary", filled: false }],
    };
    const found = discoverCustomControlsFromSnap(snap);
    assert.equal(found.length, 1);
    assert.equal(found[0].label, "Salary expectations");
  });

  it("discoverCustomControlsFromSnap infers from page text", () => {
    const snap = {
      pageText: "Tell us about yourself. Salary expectations. Location.",
      fields: [],
    };
    const found = discoverCustomControlsFromSnap(snap);
    assert.ok(found.some((c) => c.mappedTo === "salary" || c.type === "salary"));
  });
});

describe("nested salary picker fixture", () => {
  it("requires Save to commit salary band", async () => {
    await withFixturePage("nested-salary-picker", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const before = await readLiveControlValue(page, "salary");
      assert.equal(before, "");

      await page.locator("#salary-trigger").click();
      await page.locator("[role=option]").filter({ hasText: "USD 60,000 - 80,000" }).click();

      const afterOptionOnly = await readLiveControlValue(page, "salary");
      assert.equal(afterOptionOnly, "");

      await page.getByRole("button", { name: /^save$/i }).click();
      const afterSave = await readLiveControlValue(page, "salary");
      assert.match(afterSave, /USD 60,000/);
    });
  });

  it("fillCustomControls commits salary via Save", async () => {
    await withFixturePage("nested-salary-picker", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const context = {
        preferences: { salary: "75000", location: "Germany", desiredTitle: "Platform Engineer" },
        job: { title: "Platform Engineer" },
      };
      const snap = {
        applyModalTitle: "Tell us about yourself",
        pageText: "Tell us about yourself Salary expectations",
        customControls: [{ label: "Salary expectations", mappedTo: "salary", widgetType: "combobox", filled: false, selector: "#salary-trigger" }],
        customControlCount: 1,
        fields: [],
      };

      const result = await fillCustomControls(page, context, { snap, log: null });
      assert.ok(result.ok);
      assert.ok(result.filled.some((f) => f.mappedTo === "salary"));

      const live = await readLiveControlValue(page, "salary");
      assert.match(live, /USD 60,000/);
    });
  });

  it("blocks advance when fillResult claims salary but DOM still shows ?", async () => {
    await withFixturePage("nested-salary-picker", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      await page.locator("#salary-trigger").click();
      await page.locator("[role=option]").filter({ hasText: "USD 60,000" }).click();
      const snap = await inspectPage(page);
      const fillResult = { filled: [{ mappedTo: "salary", type: "salary" }] };
      const block = await shouldBlockAdvance(snap, fillResult, page);
      assert.ok(block.block);
      assert.match(block.reason, /preferences gate/i);
    });
  });

  it("executePlan smart_fill commits salary before signup CTA", async () => {
    await withFixturePage("nested-salary-picker", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const context = {
        preferences: { salary: "75000", location: "Germany", desiredTitle: "Platform Engineer" },
        job: { title: "Platform Engineer" },
      };
      const log = { layer: () => {} };
      const result = await executePlan(page, { type: "smart_fill" }, { snap, context, log, url: page.url() });
      assert.ok(result.ok);
      const live = await readLiveControlValue(page, "salary");
      assert.match(live, /USD 60,000/);
    });
  });
});

describe("mergeControlSkills", () => {
  it("dedupes by mappedTo and label", () => {
    const merged = mergeControlSkills(
      [{ label: "salary expectations", mappedTo: "salary", successCount: 2 }],
      [{ label: "salary expectations", mappedTo: "salary", triggerSelector: "#combo", successCount: 1 }],
    );
    assert.equal(merged.length, 1);
    assert.equal(merged[0].successCount, 3);
    assert.equal(merged[0].triggerSelector, "#combo");
  });

  it("merges requiresConfirm and confirmPattern", () => {
    const merged = mergeControlSkills(
      [{ label: "salary", mappedTo: "salary", requiresConfirm: true }],
      [{ label: "salary", mappedTo: "salary", confirmPattern: "Save" }],
    );
    assert.equal(merged[0].requiresConfirm, true);
    assert.equal(merged[0].confirmPattern, "Save");
  });
});
