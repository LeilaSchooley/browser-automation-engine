import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeMechanicalSignals,
  isStrongMechanicalProgress,
  parseValidatorResponse,
  parseEndStateResponse,
  validateActionOutcome,
} from "../src/layers/actionValidator.js";
import { planNextAction } from "../src/layers/agentPlan.js";
import { initTestRuntime } from "./helpers/runtime.js";

const listingSnap = {
  url: "https://jobs.example.com/posting/1",
  title: "Engineer role",
  pageKind: "listing",
  fieldCount: 0,
  fileInputCount: 0,
  entryCount: 1,
  hasApplyModal: false,
  cookieBanner: false,
  interactives: [{ index: 1, kind: "link", tag: "a", text: "Apply" }],
  fields: [],
};

const modalSnap = {
  url: "https://jobs.example.com/posting/1",
  title: "Engineer role",
  pageKind: "modal",
  fieldCount: 0,
  fileInputCount: 0,
  entryCount: 0,
  hasApplyModal: true,
  cookieBanner: false,
  interactives: [{ index: 1, kind: "button", tag: "button", text: "I have a resume", inModal: true }],
  fields: [],
};

describe("actionValidator", () => {
  it("detects strong mechanical progress when a modal appears", () => {
    const signals = computeMechanicalSignals(listingSnap, modalSnap);
    assert.equal(signals.modalAppeared, true);
    assert.equal(isStrongMechanicalProgress(signals, true, true), true);
  });

  it("parses validator and end-state JSON", () => {
    const parsed = parseValidatorResponse(
      '{"progressed": false, "reason": "opened cookie settings", "recovery": "dismiss_overlay"}',
    );
    assert.equal(parsed.progressed, false);
    assert.equal(parsed.recovery, "dismiss_overlay");

    const end = parseEndStateResponse('{"action":"upload_resume","reason":"file input visible"}');
    assert.equal(end.action, "upload_resume");
  });

  it("fast-fails and trusts strong mechanical without LLM", async () => {
    initTestRuntime();
    const fast = await validateActionOutcome({
      plan: { type: "click_apply", reason: "test" },
      snapBefore: listingSnap,
      snapAfter: listingSnap,
      fillResult: { filled: [] },
      mechanicalProgress: false,
      actorOk: false,
      history: [],
      context: {},
      filledBefore: 0,
    });
    assert.equal(fast.source, "fast-fail");

    const strong = await validateActionOutcome({
      plan: { type: "click_modal", reason: "resume choice" },
      snapBefore: listingSnap,
      snapAfter: modalSnap,
      fillResult: { filled: [] },
      mechanicalProgress: true,
      actorOk: true,
      history: [],
      context: {},
      filledBefore: 0,
    });
    assert.equal(strong.source, "mechanical");
    assert.equal(strong.progressed, true);
  });
});

describe("agentPlan", () => {
  it("returns null without callLlm / agent_ai", async () => {
    initTestRuntime({ settings: { agent_ai: false } });
    const plan = await planNextAction({}, listingSnap, [], { filled: [] }, null);
    assert.equal(plan, null);
  });

  it("parses high-level and generic AI plans", async () => {
    initTestRuntime({
      settings: { agent_ai: true, auto_submit: false },
      callLlm: async () =>
        JSON.stringify({
          action: "click",
          elementIndex: 1,
          reason: "apply link",
        }),
    });
    const plan = await planNextAction(
      { title: "Engineer", company: "Acme" },
      listingSnap,
      [],
      { filled: [] },
      { step: "entry", confidence: "low", reason: "ambiguous" },
    );
    assert.equal(plan.type, "act");
    assert.equal(plan.action, "click");
    assert.equal(plan.elementIndex, 1);
  });

  it("rewrites click_submit to done when auto_submit is false", async () => {
    initTestRuntime({
      settings: { agent_ai: true, auto_submit: false },
      callLlm: async () =>
        JSON.stringify({
          action: "click_submit",
          reason: "form filled",
        }),
    });
    const formSnap = {
      ...listingSnap,
      pageKind: "form",
      fieldCount: 3,
      interactives: [],
      fields: [{ type: "text", label: "Name", filled: true }],
    };
    const plan = await planNextAction({ title: "Role" }, formSnap, [], { filled: [{ id: 1 }] }, null);
    assert.equal(plan.type, "done");
    assert.equal(plan.source, "ai-corrected");
  });
});
