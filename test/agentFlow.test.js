import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyApplyStep, stepToPlan } from "../src/layers/applyStep.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { shouldPreferUpload } from "../src/heuristics.js";
import { withFixturePage } from "./helpers/fixtures.js";

/**
 * End-to-end classification chain: HTML fixture → DOM snapshot → step → plan.
 * Simulates one agent observe/classify tick without executing browser actions.
 */
async function classifyFixture(name, { fillResult = { filled: [], unfilled_count: 0 }, history = [] } = {}) {
  return withFixturePage(name, async (page) => {
    const snap = await inspectPage(page);
    const classification = classifyApplyStep(snap, fillResult, history);
    const plan = stepToPlan(classification, snap, history);
    return { snap, classification, plan };
  });
}

describe("agent flow (fixture → classify → plan)", () => {
  it("listing → entry → click_apply", async () => {
    const { classification, plan } = await classifyFixture("listing-apply");
    assert.equal(classification.step, "entry");
    assert.equal(plan.type, "click_apply");
    assert.ok(plan.targetCandidate?.text?.match(/apply/i));
  });

  it("cookie banner → consent → accept_cookies", async () => {
    const { classification, plan } = await classifyFixture("cookie-banner");
    assert.equal(classification.step, "consent");
    assert.equal(plan.type, "accept_cookies");
  });

  it("intake form → form → smart_fill", async () => {
    const { classification, plan, snap } = await classifyFixture("simple-form", {
      history: [{ action: "click_apply", ok: true, progress: true }],
    });
    assert.equal(classification.step, "form");
    assert.equal(plan.type, "smart_fill");
    assert.ok(snap.fieldCount >= 5);
  });

  it("wizard modal → wizard_choice → click_modal", async () => {
    const { classification, plan } = await classifyFixture("wizard-modal", {
      history: [{ action: "click_apply", ok: true, progress: true }],
    });
    assert.equal(classification.step, "wizard_choice");
    assert.equal(plan.type, "click_modal");
    assert.match(plan.targetCandidate?.text || "", /resume/i);
  });

  it("file upload surface exposes upload affordances", async () => {
    const { classification, plan, snap } = await classifyFixture("file-upload", {
      history: [
        { action: "click_apply", ok: true, progress: true },
        { action: "click_modal", ok: true, progress: true },
      ],
    });
    assert.ok(snap.fileInputCount >= 1);
    assert.equal(shouldPreferUpload(snap, []), true);
    // Single file input counts as a field — engine may choose form or upload depending on modal steps.
    assert.ok(["form", "upload"].includes(classification.step));
    assert.ok(["smart_fill", "upload_resume"].includes(plan?.type));
  });

  it("filled form → review → done", async () => {
    const { classification, plan } = await classifyFixture("simple-form", {
      fillResult: { filled: [{}, {}, {}], unfilled_count: 2 },
      history: [{ action: "smart_fill", ok: true, progress: true }],
    });
    assert.equal(classification.step, "review");
    assert.equal(plan.type, "done");
  });

  it("continue step → continue → click_continue", async () => {
    const { classification, plan, snap } = await classifyFixture("continue-step", {
      history: [{ action: "click_apply", ok: true, progress: true }],
    });
    assert.ok(snap.continueCount >= 1);
    assert.equal(classification.step, "continue");
    assert.equal(plan.type, "click_continue");
  });
});
