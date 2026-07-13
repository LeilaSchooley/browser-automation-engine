import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPageState } from "../src/layers/pageState.js";
import { renderLayoutContext } from "../src/layers/agentContext.js";
import { commitPendingSelection, fillCustomControls, readLiveControlValue } from "../src/fillCustomControls.js";
import { resolveDialogScope } from "../src/layers/dialogScope.js";
import { computeMechanicalSignals, isStrongMechanicalProgress } from "../src/layers/actionValidator.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { initRuntime } from "../src/runtime.js";

describe("pageState", () => {
  it("detects picker_open on nested salary fixture", async () => {
    await withFixturePage("nested-salary-picker", async (page) => {
      await page.locator("#salary-trigger").click();
      const snap = await inspectPage(page);
      const state = await buildPageState(snap, page);
      assert.ok(state.pickerOpen || state.uiPhase === "picker_open");
      assert.ok(renderLayoutContext(state).includes("LAYOUT:"));
    });
  });

  it("detects option_selected_uncommitted before Save", async () => {
    await withFixturePage("nested-salary-picker", async (page) => {
      await page.locator("#salary-trigger").click();
      await page.locator("[role=option]").filter({ hasText: "USD 60,000" }).click();
      const snap = await inspectPage(page);
      const state = await buildPageState(snap, page);
      assert.equal(state.uiPhase, "option_selected_uncommitted");
      assert.ok(state.pendingCommits.length > 0);
    });
  });
});

describe("dialogScope", () => {
  it("confirm_picker targets top dialog", async () => {
    await withFixturePage("nested-salary-picker", async (page) => {
      await page.locator("#salary-trigger").click();
      const snap = await inspectPage(page);
      const scope = resolveDialogScope(page, snap, "confirm_picker");
      assert.ok(scope);
    });
  });
});

describe("confirm patterns", () => {
  it("commits via Submit button", async () => {
    await withFixturePage("confirm-submit-not-save", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      await page.locator("#salary-trigger").click();
      await page.locator("[role=option]").click();
      const snap = await inspectPage(page);
      const ok = await commitPendingSelection(page, null, { snap });
      assert.ok(ok);
      const live = await readLiveControlValue(page, "salary");
      assert.match(live, /USD 60,000/);
    });
  });
});

describe("validator custom fill", () => {
  it("rejects filledDelta alone for smart_fill without commit", () => {
    const signals = computeMechanicalSignals(
      { pickerOpen: true, customControls: [{ mappedTo: "salary", filled: true }] },
      { pickerOpen: true, customControls: [{ mappedTo: "salary", filled: true }] },
      { filledBefore: 0, filledAfter: 1, uiPhaseBefore: "option_selected_uncommitted", uiPhaseAfter: "option_selected_uncommitted" },
    );
    assert.equal(isStrongMechanicalProgress(signals, true, true, { type: "smart_fill" }), false);
  });

  it("accepts commitCompleted signal", () => {
    const signals = computeMechanicalSignals(
      { pickerOpen: true },
      { pickerOpen: false },
      { uiPhaseBefore: "option_selected_uncommitted", uiPhaseAfter: "ready_to_continue" },
    );
    assert.ok(signals.commitCompleted);
    assert.equal(isStrongMechanicalProgress(signals, true, true, { type: "smart_fill" }), true);
  });
});

describe("stacked dialogs", () => {
  it("commit targets top z-index dialog Save", async () => {
    await withFixturePage("stacked-dialogs-wrong-order", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const ok = await commitPendingSelection(page, null, { snap });
      assert.ok(ok);
      const text = await page.locator("#salary-trigger").innerText();
      assert.match(text, /USD 50,000/);
    });
  });
});

describe("interaction recipe merge", () => {
  it("merges steps in control skills", async () => {
    const { mergeControlSkills } = await import("../src/siteLearnings.js");
    const merged = mergeControlSkills(
      [{ mappedTo: "salary", label: "salary", steps: [{ action: "click", text: "Save" }] }],
      [{ mappedTo: "salary", label: "salary", steps: [{ action: "verify" }], successCount: 1 }],
    );
    assert.equal(merged[0].steps.length, 1);
    assert.equal(merged[0].successCount, 2);
  });
});

describe("portaled listbox", () => {
  it("fillCustomControls can pick portaled option", async () => {
    await withFixturePage("portaled-listbox", async (page) => {
      initRuntime({ settings: { browser_human_behavior: false } });
      const snap = await inspectPage(page);
      const context = { preferences: { location: "Germany" } };
      const result = await fillCustomControls(page, context, {
        snap: {
          ...snap,
          customControls: [{ label: "Location", mappedTo: "location", widgetType: "combobox", selector: "#loc-trigger", filled: false }],
        },
        log: null,
      });
      const live = await readLiveControlValue(page, "location");
      assert.ok(result.ok || live.includes("Germany"));
    });
  });
});
