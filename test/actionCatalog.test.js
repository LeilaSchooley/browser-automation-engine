import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  uploadStalled,
  looksLikeInlineApplicationForm,
  hasUnfilledApplicationFields,
  shouldPreferUpload,
} from "../src/heuristics.js";
import { buildActionCatalog } from "../src/layers/actionCatalog.js";
import { pickBestAction, planFromCatalogAction } from "../src/layers/actionPicker.js";
import { classifyApplyStep } from "../src/layers/applyStep.js";

const ashbyApplicationSnap = {
  url: "https://jobs.ashbyhq.com/ditto/da3e6b45/application",
  pageKind: "form",
  fieldCount: 4,
  fileInputCount: 2,
  passwordFieldCount: 0,
  hasApplyModal: true,
  modalStepCount: 2,
  modalCount: 0,
  dialogStack: [],
  fields: [
    { label: "Name", type: "text", filled: false },
    { label: "Email", type: "email", filled: false },
    { label: "Home Address", type: "text", filled: false },
    { label: "LinkedIn", type: "text", filled: false },
  ],
};

describe("upload stall heuristics", () => {
  it("detects upload stall after repeated failures", () => {
    const history = [
      { action: "upload_resume", ok: false },
      { action: "upload_resume", ok: false },
    ];
    assert.equal(uploadStalled(history), true);
  });

  it("detects inline Ashby-style application form", () => {
    assert.equal(looksLikeInlineApplicationForm(ashbyApplicationSnap), true);
  });

  it("does not prefer upload when inline form has unfilled text fields", () => {
    assert.equal(shouldPreferUpload(ashbyApplicationSnap, [], { filled: [] }), false);
  });

  it("classifies inline form as form when upload stalled", () => {
    const history = [
      { action: "upload_resume", ok: false },
      { action: "upload_resume", ok: false },
    ];
    const c = classifyApplyStep(ashbyApplicationSnap, { filled: [] }, history);
    assert.equal(c.step, "form");
    assert.match(c.reason, /upload stalled|inline application/i);
  });
});

describe("action catalog", () => {
  it("prefers smart_fill over upload when upload stalled on inline form", () => {
    const history = [
      { action: "upload_resume", ok: false },
      { action: "upload_resume", ok: false },
    ];
    const classification = classifyApplyStep(ashbyApplicationSnap, { filled: [] }, history);
    const catalog = buildActionCatalog(ashbyApplicationSnap, { filled: [] }, history, {}, classification);
    const plan = pickBestAction(catalog, {
      classification,
      history,
      snap: ashbyApplicationSnap,
      fillResult: { filled: [] },
      context: { browserProvider: "adspower", browserCdpUrl: "ws://x" },
    });
    assert.ok(plan);
    assert.equal(plan.type, "smart_fill");
    assert.equal(plan.source, "action-catalog");
  });

  it("planFromCatalogAction maps stagehand entries", () => {
    const plan = planFromCatalogAction({
      type: "smart_fill",
      score: 90,
      reason: "fill fields",
      step: "form",
    });
    assert.equal(plan.type, "smart_fill");
    assert.equal(plan.source, "action-catalog");
  });
});
