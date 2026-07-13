/**
 * Pick the best action from the catalog — deterministic when clear, null when LLM should decide.
 */
import { uploadStalled, hasUnfilledApplicationFields } from "../heuristics.js";
import { buildStagehandPlan } from "./stagehandPolicy.js";

const CLEAR_WIN_MARGIN = 12;

/**
 * @param {import('./actionCatalog.js').CatalogAction[]} catalog
 * @param {{ classification?: object, history?: object[], snap?: object, fillResult?: object, context?: object }} opts
 * @returns {object|null}
 */
export function pickBestAction(catalog, opts = {}) {
  const { classification, history = [], snap, fillResult, context } = opts;
  if (!catalog?.length) return null;

  const boosted = catalog.map((action) => {
    let score = action.score;
    const step = classification?.step || "";

    if (step === action.step) score += 12;
    if (step === "form" && action.type === "smart_fill") score += 15;
    if (step === "upload" && action.type === "upload_resume" && !uploadStalled(history)) score += 10;
    if (step === "entry" && action.type === "click_apply") score += 12;
    if (uploadStalled(history) && action.type === "upload_resume") score -= 35;
    if (uploadStalled(history) && action.type === "smart_fill") score += 20;
    if (uploadStalled(history) && action.type === "stagehand_act") score += 15;

    const submitCta = /submit\s+application/i.test(
      `${action.targetCandidate?.text || ""} ${action.reason || ""}`,
    );
    if (action.type === "click_apply" && submitCta && hasUnfilledApplicationFields(snap, fillResult)) {
      score -= 55;
    }
    if (action.type === "smart_fill" && (snap?.customControls || []).some((c) => !c.filled && c.widgetType === "yesno")) {
      score += 18;
    }

    const recentFails = (history || [])
      .slice(-3)
      .filter((h) => h.action === action.type && !h.ok).length;
    score -= recentFails * 18;

    return { ...action, score };
  });

  boosted.sort((a, b) => b.score - a.score);
  const top = boosted[0];
  const second = boosted[1];

  if (!top) return null;
  if (!second || top.score - second.score >= CLEAR_WIN_MARGIN) {
    return planFromCatalogAction(top, { snap, classification, history, context, fillResult });
  }

  return null;
}

/**
 * @param {import('./actionCatalog.js').CatalogAction} action
 * @param {object} [opts]
 */
export function planFromCatalogAction(action, opts = {}) {
  if (!action) return null;

  if (action.type === "stagehand_act" && !action.instruction) {
    return buildStagehandPlan(
      opts.snap,
      opts.classification || { step: action.step || "ambiguous" },
      opts.history || [],
      opts.context || {},
    );
  }

  return {
    type: action.type,
    reason: action.reason,
    instruction: action.instruction,
    target: action.targetCandidate?.testId || action.targetCandidate?.selector || action.targetCandidate?.text || "",
    targetCandidate: action.targetCandidate || null,
    confidence: action.score >= 80 ? "high" : action.score >= 60 ? "medium" : "low",
    step: action.step,
    source: "action-catalog",
  };
}

/**
 * Top N catalog entries for LLM disambiguation prompts.
 * @param {import('./actionCatalog.js').CatalogAction[]} catalog
 * @param {number} [n]
 */
export function topCatalogActions(catalog, n = 5) {
  return (catalog || []).slice(0, n).map((a, i) => ({
    index: i,
    type: a.type,
    score: a.score,
    reason: a.reason,
  }));
}
