import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  stepSignature,
  currentStepIncomplete,
  shouldAutoAdvance,
  planAfterContinue,
  looksLikeSteppedForm,
} from "../src/layers/steppedForm.js";
import { buildActionCatalog } from "../src/layers/actionCatalog.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";

describe("stepped form helpers", () => {
  const step1 = {
    url: "https://jobs.example.com/apply?step=1",
    fieldCount: 2,
    fields: [
      { type: "text", label: "Full name", filled: false },
      { type: "email", label: "Email", filled: false },
    ],
    customControls: [],
    continueCount: 1,
    continueCandidates: [{ text: "Next", score: 80 }],
  };

  const step1Filled = {
    ...step1,
    fields: [
      { type: "text", label: "Full name", filled: true },
      { type: "email", label: "Email", filled: true },
    ],
  };

  const step2 = {
    url: "https://jobs.example.com/apply?step=2",
    fieldCount: 2,
    fields: [
      { type: "text", label: "Phone", filled: false },
      { type: "text", label: "LinkedIn", filled: false },
    ],
    customControls: [],
    continueCount: 1,
    continueCandidates: [{ text: "Continue", score: 80 }],
  };

  it("detects stepped forms and incomplete steps", () => {
    assert.equal(looksLikeSteppedForm(step1), true);
    assert.equal(currentStepIncomplete(step1), true);
    assert.equal(currentStepIncomplete(step1Filled, { filled: [{ type: "email" }] }), false);
  });

  it("auto-advances only when the current step is complete", () => {
    assert.equal(shouldAutoAdvance(step1, { filled: [] }), false);
    assert.equal(shouldAutoAdvance(step1Filled, { filled: [{ type: "email" }, { type: "text" }] }), true);
  });

  it("after Continue with new empty fields → smart_fill plan", () => {
    const plan = planAfterContinue(step1Filled, step2, { filled: [{ type: "email" }] });
    assert.equal(plan?.type, "smart_fill");
    assert.match(plan.reason, /stepped form/i);
  });

  it("signature changes across wizard panels", () => {
    assert.notEqual(stepSignature(step1), stepSignature(step2));
  });

  it("catalog prefers fill over continue while step incomplete", () => {
    const catalog = buildActionCatalog(step1, { filled: [] }, [], {}, { step: "form" });
    const fill = catalog.find((a) => a.type === "smart_fill");
    const cont = catalog.find((a) => a.type === "click_continue");
    assert.ok(fill);
    if (cont) assert.ok(fill.score > cont.score);
  });

  it("catalog boosts continue when step is complete", () => {
    const catalog = buildActionCatalog(
      step1Filled,
      { filled: [{ type: "email" }, { type: "text" }] },
      [],
      {},
      { step: "continue" },
    );
    const cont = catalog.find((a) => a.type === "click_continue");
    assert.ok(cont);
    assert.ok(cont.score >= 80);
    assert.match(cont.reason, /step complete/i);
  });
});

describe("custom widget discovery", () => {
  it("exposes contenteditable + React Select control on customControls", async () => {
    await withFixturePage("react-select-contenteditable", async (page) => {
      const snap = await inspectPage(page);
      assert.ok(
        (snap.customControls || []).some((c) => c.widgetType === "contenteditable"),
        "expected contenteditable custom control",
      );
      assert.ok(
        (snap.fields || []).some((f) => f.widgetType === "contenteditable" || f.type === "contenteditable"),
        "expected contenteditable field",
      );
      // React Select control should be discovered as a combobox-like interactive
      const hasSelect =
        (snap.customControls || []).some((c) => /select|combobox|country/i.test(`${c.label} ${c.selector} ${c.testId}`)) ||
        (snap.fields || []).some((f) => /select|combobox|country/i.test(`${f.label} ${f.selector}`));
      assert.ok(hasSelect, "expected React Select control in discovery");
    });
  });
});
