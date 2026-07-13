import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { initRuntime } from "../src/runtime.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import {
  renderInteractivesForPrompt,
  rankInteractivesForPrompt,
} from "../src/layers/agentContext.js";
import {
  decideWithActionBrain,
  resolveActionBrainMode,
  shouldAttachVision,
  preferIndexedAct,
} from "../src/layers/actionBrain.js";
import {
  affordanceSignature,
  boostInteractivesWithLearnings,
  findLearnedAffordanceReplay,
  isDismissAffordanceSignature,
  mergeAffordanceSkills,
} from "../src/siteLearnings.js";
import { performGenericAct } from "../src/layers/domActions.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { quietLog } from "./helpers/log.js";

describe("affordance action brain", () => {
  it("resolveActionBrainMode defaults to primary when agent_ai", () => {
    assert.equal(resolveActionBrainMode({ agent_ai: true, action_brain_mode: "" }), "primary");
    assert.equal(resolveActionBrainMode({ agent_ai: false, action_brain_mode: "" }), "off");
    assert.equal(resolveActionBrainMode({ agent_ai: true, action_brain_mode: "escalate" }), "escalate");
  });

  it("shouldAttachVision on overlay / early escalation", () => {
    assert.equal(
      shouldAttachVision(
        { hasApplyModal: true, modalCount: 1 },
        [],
        { step: "overlay", confidence: "high" },
        { early_vision_escalation: true, vision_include_screenshot: true },
      ),
      true,
    );
    assert.equal(
      shouldAttachVision(
        { pageKind: "form" },
        [{ progress: false }, { progress: false }],
        { step: "form", confidence: "high" },
        { early_vision_escalation: false, vision_include_screenshot: true },
      ),
      true,
    );
  });

  it("preferIndexedAct converts high-level plan with elementIndex to act", () => {
    const plan = preferIndexedAct(
      { type: "dismiss_overlay", elementIndex: 4, reason: "skip upsell" },
      { interactives: [{ index: 4, text: "Continue with basic resume" }] },
    );
    assert.equal(plan.type, "act");
    assert.equal(plan.action, "click");
    assert.equal(plan.elementIndex, 4);
  });

  it("includes novel ds-button CTAs in interactives without CTA keyword filter", async () => {
    await withFixturePage("weird-cta-upsell", async (page) => {
      const snap = await inspectPage(page);
      const weird = (snap.interactives || []).find((i) =>
        /continue with basic resume/i.test(i.text || ""),
      );
      assert.ok(weird, "expected Continue with basic resume in interactives");
      assert.equal(weird.inModal, true);
      assert.ok(weird.bbox && Number.isFinite(weird.bbox.x));

      const prompt = renderInteractivesForPrompt(snap);
      assert.match(prompt, /Continue with basic resume/i);
      // Must not require Skip / continue keywords to appear in the map
      assert.ok(!/no element map/i.test(prompt));
    });
  });

  it("rankInteractivesForPrompt keeps non-keyword modal CTAs", () => {
    const ranked = rankInteractivesForPrompt(
      [
        { index: 0, text: "Continue with basic resume", inModal: true, kind: "control", tag: "div" },
        { index: 1, text: "Search jobs", inNav: true, kind: "control", tag: "a" },
      ],
      8,
    );
    assert.equal(ranked[0].text, "Continue with basic resume");
  });

  it("clicks weird CTA by elementIndex without dismiss regex patterns", async () => {
    await withFixturePage("weird-cta-upsell", async (page) => {
      const snap = await inspectPage(page);
      const weird = (snap.interactives || []).find((i) =>
        /continue with basic resume/i.test(i.text || ""),
      );
      assert.ok(weird);
      const result = await performGenericAct(
        page,
        { type: "act", action: "click", elementIndex: weird.index },
        { snap, log: quietLog() },
      );
      assert.equal(result.ok, true);
      assert.equal(await page.locator("#apply-form").isVisible(), true);
    });
  });

  it("resume-score gate card is in interactives and clickable by index", async () => {
    await withFixturePage("resume-score-gate", async (page) => {
      const snap = await inspectPage(page);
      const skip = (snap.interactives || []).find((i) => /skip free expert review/i.test(i.text || ""));
      assert.ok(skip, "Skip free expert review must appear in affordance map");
      const result = await performGenericAct(
        page,
        { type: "act", action: "click", elementIndex: skip.index },
        { snap, log: quietLog() },
      );
      assert.equal(result.ok, true);
      assert.equal(await page.locator("#apply-form").isVisible(), true);
    });
  });

  it("action brain primary uses LLM elementIndex over dismiss_overlay strings", async () => {
    await withFixturePage("weird-cta-upsell", async (page) => {
      const snap = await inspectPage(page);
      const weird = (snap.interactives || []).find((i) =>
        /continue with basic resume/i.test(i.text || ""),
      );
      assert.ok(weird);

      initRuntime({
        settings: { agent_ai: true, action_brain_mode: "primary", early_vision_escalation: false },
        planNextAction: async () => ({
          type: "act",
          action: "click",
          elementIndex: weird.index,
          reason: "decline upsell via novel CTA",
          source: "ai",
        }),
        callLlm: async () => null,
      });

      const { plan, classification } = await decideWithActionBrain(snap, {}, [], {}, page);
      assert.equal(plan?.type, "act");
      assert.equal(plan?.elementIndex, weird.index);
      assert.ok(classification);
    });
  });

  it("affordance memory boosts and replays unique learned skills", () => {
    const item = {
      index: 2,
      text: "Continue with basic resume",
      role: "",
      kind: "control",
      inModal: true,
      testId: "",
      hintScore: 0,
    };
    const skill = {
      stage: "wizard_choice",
      action: "click",
      intent: "wizard_continue",
      signature: affordanceSignature(item),
      successCount: 2,
    };
    const boosted = boostInteractivesWithLearnings([item], { affordanceSkills: [skill] });
    assert.equal(boosted[0].learned, true);
    assert.ok(boosted[0].hintScore > 0);

    const replay = findLearnedAffordanceReplay(
      { interactives: [item] },
      { affordanceSkills: [skill] },
      { step: "wizard_choice" },
    );
    assert.ok(replay);
    assert.equal(replay.elementIndex, 2);
    assert.equal(replay.source, "affordance-memory");

    const merged = mergeAffordanceSkills([skill], [{ ...skill, successCount: 1 }]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].successCount, 3);
  });

  it("does not replay on form/auth/signup surfaces", () => {
    const skill = {
      stage: "any",
      action: "click",
      intent: "wizard_continue",
      signature: {
        role: "control",
        textNorm: "i have a resume",
        inModal: true,
        testId: "umja-option-upload-resume",
        kind: "control",
      },
      successCount: 4,
    };
    const snap = {
      fieldCount: 4,
      passwordFieldCount: 1,
      interactives: [
        { index: 0, text: "I have a resume", testId: "umja-option-upload-resume", inModal: true },
      ],
    };
    const replay = findLearnedAffordanceReplay(
      snap,
      { affordanceSkills: [skill] },
      { step: "form" },
    );
    assert.equal(replay, null);
  });

  it("does not replay modal-close over signup or application forms", () => {
    const closeSkill = {
      stage: "any",
      action: "click",
      signature: {
        role: "button",
        textNorm: "close modal",
        inModal: true,
        testId: "modal-close",
        kind: "control",
      },
      successCount: 6,
    };
    const snap = {
      fieldCount: 4,
      passwordFieldCount: 1,
      emailFieldCount: 1,
      authForm: true,
      interactives: [
        { index: 0, text: "", testId: "modal-close", inModal: true, role: "button" },
        { index: 1, text: "Continue", testId: "continue-btn", inModal: true, role: "button" },
      ],
    };
    const replay = findLearnedAffordanceReplay(
      snap,
      { affordanceSkills: [closeSkill] },
      { step: "form" },
    );
    assert.equal(replay, null);
  });

  it("returns decision path metadata from classifier fallback", async () => {
    initRuntime({
      settings: { agent_ai: false, deterministic_first: true },
      planNextAction: null,
      callLlm: async () => null,
    });
    const snap = {
      pageKind: "listing",
      fieldCount: 0,
      entryCount: 2,
      entryCandidates: [{ text: "Apply", score: 80 }, { text: "Save job", score: 70 }],
      url: "https://example.com/jobs/1",
      title: "Engineer",
      bodyTextLength: 500,
      continueCount: 1,
      continueCandidates: [{ text: "Next", score: 60 }],
    };
    const { plan, decision } = await decideWithActionBrain(snap, {}, [], {}, null);
    assert.ok(decision?.path);
    assert.match(decision.path, /classifier-fallback|llm-primary|deterministic|action-catalog/);
    assert.ok(plan === null || typeof plan === "object");
  });
});
