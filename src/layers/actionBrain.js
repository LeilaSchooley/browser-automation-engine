/**
 * Affordance-Grounded Action Brain — LLM (+ optional vision) decides among DOM interactives.
 * Heuristics remain soft hints / safety fallback, not the primary click authority.
 */
import { getRuntime, getSettings } from "../runtime.js";
import { isPageUnloaded } from "./pageReady.js";
import { classifyApplyStep, stepToPlan } from "./applyStep.js";
import { shouldEscalateToAi, shouldAiOverrideHeuristic } from "./semanticRecovery.js";
import { isStuck, shouldPreferUpload, recentPreferencesSignup, preferencesSignupSubmitted, applyEntrySucceeded, uploadStalled } from "../heuristics.js";
import { ariaContextBlock, shouldAttachAriaSnapshot } from "./ariaDistill.js";
import { boostInteractivesWithLearnings, findLearnedAffordanceReplay, isDismissAffordanceSignature, affordanceSignature } from "../siteLearnings.js";
import { buildDeterministicPlan, isDeterministicState, shouldInvokeLlm, smartFillStalledOnStep } from "./deterministicPolicy.js";
import { buildPageState } from "./pageState.js";
import { shouldPreferStagehand, buildStagehandPlan } from "./stagehandPolicy.js";
import { buildActionCatalog } from "./actionCatalog.js";
import { pickBestAction, topCatalogActions } from "./actionPicker.js";

/** Steps that must stay mechanical — never delegated to the LLM brain. */
export const SAFETY_STEPS = new Set(["loading", "blocked"]);

/**
 * @param {object} settings
 * @returns {"primary" | "escalate" | "off"}
 */
export function resolveActionBrainMode(settings = getSettings()) {
  const raw = String(settings.action_brain_mode || "").toLowerCase();
  if (raw === "primary" || raw === "escalate" || raw === "off") return raw;
  return settings.agent_ai ? "primary" : "off";
}

/**
 * When to attach a screenshot to the main brain call (not only visionFallback).
 */
export function shouldAttachVision(snap, history = [], classification = null, settings = getSettings()) {
  if (settings.vision_include_screenshot === false) return false;
  if (settings.vision_fallback_enabled === false && settings.early_vision_escalation === false) {
    return false;
  }

  const early = settings.early_vision_escalation !== false;
  if (early) {
    if (snap?.hasBlockingOverlay) return true;
    if ((snap?.modalCount || 0) > 0 || snap?.hasApplyModal) return true;
    if (classification?.step === "overlay" || classification?.step === "ambiguous") return true;
    if (classification?.confidence === "low") return true;
  }

  const recent = (history || []).slice(-2);
  if (recent.length >= 2 && recent.every((h) => !h.progress)) return true;
  if (isStuck(history, snap)) return true;
  return false;
}

/**
 * Enrich context with screenshot + ARIA when the brain should see the page.
 */
export async function enrichContextWithVision(page, context, snap, history, classification) {
  const settings = getSettings();
  if (!page || !shouldAttachVision(snap, history, classification, settings)) {
    return context;
  }

  let screenshotBase64 = "";
  try {
    if (settings.vision_include_screenshot !== false) {
      const buf = await page.screenshot({ type: "jpeg", quality: 55, fullPage: false });
      screenshotBase64 = buf.toString("base64");
    }
  } catch {
    /* ignore screenshot failures */
  }

  let ariaBlock = context?.ariaSnapshot || "";
  try {
    if (shouldAttachAriaSnapshot(snap)) {
      ariaBlock = (await ariaContextBlock(page, snap)) || ariaBlock;
    }
  } catch {
    /* ignore */
  }

  return {
    ...context,
    vision: {
      screenshotBase64,
      url: snap?.url,
      title: snap?.title,
      pageText: (snap?.pageText || "").slice(0, 800),
      attachedBy: "action-brain",
    },
    ariaSnapshot: ariaBlock,
  };
}

/**
 * Prefer act+elementIndex when interactives exist so execution never needs CTA string matchers.
 */
export function preferIndexedAct(plan, snap) {
  if (!plan) return plan;
  if (plan.type === "act" && Number.isInteger(plan.elementIndex)) return plan;

  // High-level dismiss with a concrete interactive target already chosen by the planner
  if (
    (plan.type === "dismiss_overlay" || plan.type === "click_modal" || plan.type === "click_apply") &&
    Number.isInteger(plan.elementIndex)
  ) {
    return {
      type: "act",
      action: "click",
      elementIndex: plan.elementIndex,
      target: plan.target || "",
      reason: plan.reason || `indexed ${plan.type}`,
      source: plan.source || "action-brain",
    };
  }

  return plan;
}

function stuckUploadFallback(history, snap, fillResult = null) {
  if (!isStuck(history, snap)) return null;
  if (uploadStalled(history)) {
    return {
      type: "smart_fill",
      reason: "upload stalled — fill application fields",
      source: "stuck-recovery",
      step: "form",
    };
  }
  if (!shouldPreferUpload(snap, history, fillResult)) return null;
  return {
    type: "upload_resume",
    reason: "stuck — force file upload attempt",
    source: "stuck-recovery",
    step: "upload",
  };
}

function withDecision(plan, classification, path, reason = "") {
  return {
    plan,
    classification,
    decision: { path, reason: reason || path },
  };
}

/**
 * Core decide path used by automationAgent.
 * @returns {Promise<{ plan: object|null, classification: object, decision?: object }>}
 */
export async function decideWithActionBrain(snap, fillResult, history, context, page = null) {
  const settings = getSettings();
  const mode = resolveActionBrainMode(settings);
  const classification = classifyApplyStep(snap, fillResult, history, context);
  const { planNextAction } = getRuntime();

  // Hard safety — mechanical only
  if (SAFETY_STEPS.has(classification.step)) {
    return withDecision(
      stepToPlan(classification, snap, history),
      classification,
      "safety",
      `mechanical ${classification.step}`,
    );
  }

  // Boost interactives with per-host affordance memory before planning
  if (snap?.interactives?.length && context?.siteLearnings?.affordanceSkills?.length) {
    snap.interactives = boostInteractivesWithLearnings(snap.interactives, context.siteLearnings);
  }

  // Fast replay of a uniquely learned affordance (no LLM) when signature matches
  if (mode === "primary" && settings.agent_ai) {
    const replay = findLearnedAffordanceReplay(snap, context?.siteLearnings, classification);
    if (replay) {
      const replayItem = Number.isInteger(replay.elementIndex)
        ? (snap?.interactives || []).find((i) => i.index === replay.elementIndex)
        : null;
      const replaySig = replayItem ? affordanceSignature(replayItem) : null;
      const fp = classification?.fingerprint || "";

      if (
        (preferencesSignupSubmitted(history) || recentPreferencesSignup(history)) &&
        replaySig &&
        isDismissAffordanceSignature(replaySig)
      ) {
        /* blocked — post-preferences signup; closing modal resets funnel */
      } else if (classification?.step === "entry" && applyEntrySucceeded(history, fp)) {
        /* blocked — apply entry already succeeded on this page fingerprint */
      } else {
        return withDecision(
          preferIndexedAct(replay, snap),
          classification,
          "affordance-replay",
          replay.reason || "learned affordance",
        );
      }
    }
  }

  // Action catalog (Option B) — primary decision layer after safety/replay
  const catalogEnabled = settings.action_catalog_first !== false;
  const catalog = buildActionCatalog(snap, fillResult, history, context, classification);
  if (catalogEnabled) {
    const catalogPlan = pickBestAction(catalog, {
      classification,
      history,
      snap,
      fillResult,
      context,
    });
    if (catalogPlan) {
      return withDecision(
        preferIndexedAct(catalogPlan, snap),
        classification,
        "action-catalog",
        catalogPlan.reason,
      );
    }
  }

  // Deterministic-first: handle unambiguous states without LLM
  const pageState = page ? await buildPageState(snap, page, fillResult).catch(() => null) : null;
  const stalled = smartFillStalledOnStep(history, classification);

  if (settings.deterministic_first !== false && !stalled) {
    if (isDeterministicState(classification, snap, pageState, history)) {
      const detPlan = buildDeterministicPlan(classification, snap, pageState);
      if (detPlan) {
        return withDecision(
          preferIndexedAct(detPlan, snap),
          classification,
          "deterministic",
          detPlan.reason || classification.reason,
        );
      }
    }
  }

  if (!stalled && shouldPreferStagehand(snap, classification, history, context, fillResult)) {
    const shPlan = buildStagehandPlan(snap, classification, history, context);
    return withDecision(shPlan, classification, "stagehand-primary", shPlan.reason);
  }

  let plan = null;
  let decisionPath = "classifier-fallback";
  let decisionReason = "";

  if (mode === "off" || !settings.agent_ai || !planNextAction) {
    plan = stepToPlan(classification, snap, history);
    return withDecision(
      plan || stuckUploadFallback(history, snap, fillResult),
      classification,
      "classifier-fallback",
      "agent_ai off or no planner",
    );
  }

  if (mode === "escalate") {
    plan = stepToPlan(classification, snap, history);
    decisionPath = "llm-escalate";
    if (!isPageUnloaded(snap) && shouldPreferStagehand(snap, classification, history, context, fillResult)) {
      const shPlan = buildStagehandPlan(snap, classification, history, context);
      return withDecision(shPlan, classification, "stagehand-primary", shPlan.reason);
    }
    const needsAi = shouldEscalateToAi(snap, history, classification);
    if (needsAi && !isPageUnloaded(snap)) {
      const enriched = await enrichContextWithVision(page, context, snap, history, classification);
      const aiPlan = await planNextAction(enriched, snap, history, fillResult, classification, page);
      if (aiPlan && !(aiPlan.type === "wait_user" && isPageUnloaded(snap))) {
        if (shouldAiOverrideHeuristic(snap, history, classification)) {
          plan = preferIndexedAct(aiPlan, snap);
          decisionReason = aiPlan.reason || "escalated to LLM";
        }
      }
    }
    return withDecision(
      plan || stuckUploadFallback(history, snap, fillResult),
      classification,
      decisionPath,
      decisionReason || plan?.reason,
    );
  }

  // mode === "primary" — catalog + deterministic tried; LLM for ambiguity or stall
  if (!isPageUnloaded(snap) && (stalled || shouldInvokeLlm(classification, snap, pageState, history))) {
    const enriched = await enrichContextWithVision(page, context, snap, history, classification);
    enriched.actionCatalog = topCatalogActions(catalog, 6);
    const aiPlan = await planNextAction(enriched, snap, history, fillResult, classification, page);
    if (aiPlan && !(aiPlan.type === "wait_user" && isPageUnloaded(snap))) {
      plan = preferIndexedAct(aiPlan, snap);
      decisionPath = "llm-primary";
      decisionReason = aiPlan.reason || "LLM planner";
    }
  }

  if (!plan) {
    plan = stepToPlan(classification, snap, history);
    decisionPath = "classifier-fallback";
    decisionReason = plan?.reason || classification.reason;
  }

  const fallback = plan || stuckUploadFallback(history, snap, fillResult);
  if (!plan && fallback) {
    decisionPath = "stuck-upload-fallback";
    decisionReason = fallback.reason;
  }

  return withDecision(fallback, classification, decisionPath, decisionReason);
}
