/**
 * Action-driven picker — catalog + retrieval boosts; classifier is a soft hint.
 */
import { uploadStalled, hasUnfilledApplicationFields } from "../heuristics.js";
import { looksLikePlatformOnboarding } from "../platformOnboarding.js";
import { findRelevantSkills } from "../siteLearnings.js";
import { buildStagehandPlan } from "./stagehandPolicy.js";

/** Clear winner margin — lower = trust catalog more often (action-driven). */
const CLEAR_WIN_MARGIN = 8;
const HIGH_CONF_MARGIN = 6;

/**
 * @param {import('./actionCatalog.js').CatalogAction[]} catalog
 * @param {{ classification?: object, history?: object[], snap?: object, fillResult?: object, context?: object }} opts
 * @returns {object|null}
 */
export function pickBestAction(catalog, opts = {}) {
  const { classification, history = [], snap, fillResult, context } = opts;
  if (!catalog?.length) return null;

  const learnedIntents = new Set(
    (context?.siteLearnings?.affordanceSkills || [])
      .filter((s) => (s.successCount || 0) >= 1)
      .map((s) => String(s.intent || "")),
  );
  const learnedMapped = new Set(
    (context?.siteLearnings?.controlSkills || []).map((s) => String(s.mappedTo || "").toLowerCase()),
  );
  const relevantSkills = findRelevantSkills(snap, context?.siteLearnings, {
    limit: 5,
    hostname: snap?.hostname || context?.targetHost,
  });
  const avoid = new Set(relevantSkills.flatMap((s) => s.avoidActions || []));
  const preferActions = new Map(relevantSkills.map((s) => [s.action, s]));

  const boosted = catalog.map((action) => {
    let score = action.score;
    const step = classification?.step || "";
    const conf = String(classification?.confidence || "").toLowerCase();

    // Classifier is a soft boost, not a gate.
    if (step === action.step) score += conf === "high" ? 14 : conf === "medium" ? 10 : 8;
    if (step === "signup" && action.type === "auth_signup") score += 28;
    if (step === "signin_entry" && action.type === "click_signin") score += 28;
    if (step === "auth" && action.type === "auth_login") score += 24;
    if (step === "continue" && action.type === "click_continue") score += 15;

    // Reflection from prior stalled runs on this host
    const suggested = String(context?.siteLearnings?.suggestedNext || "").trim();
    if (suggested && action.type === suggested) score += 18;
    if (step === "form" && action.type === "smart_fill") score += 15;
    if (step === "form" && looksLikePlatformOnboarding(snap) && action.type === "click_continue") score += 20;
    if (step === "upload" && action.type === "upload_resume" && !uploadStalled(history)) score += 10;
    if (step === "entry" && action.type === "click_apply") score += 12;
    if (step === "blocked" && action.type === "wait_user") score += 40;

    if (uploadStalled(history) && action.type === "upload_resume") score -= 35;
    if (uploadStalled(history) && action.type === "smart_fill") score += 20;
    if (uploadStalled(history) && action.type === "stagehand_act") score += 15;

    // Retrieval: prefer actions that match harvested skills / intents.
    if (action.type === "dismiss_overlay" && learnedIntents.has("upsell_dismiss")) score += 10;
    if (action.type === "click_apply" && learnedIntents.has("entry_apply")) score += 8;
    if (action.id === "stagehand_job_board" && learnedIntents.has("board_nav")) score += 12;
    if (action.type === "smart_fill" && (learnedMapped.has("salary") || learnedMapped.has("visasponsorship"))) {
      score += 6;
    }

    const sit = preferActions.get(action.type);
    if (sit) {
      score += sit.confidence === "high" ? 40 : 22;
    }
    if (avoid.has(action.type)) score -= 55;

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

  const margin = confMargin(classification);
  if (!second || top.score - second.score >= margin) {
    return planFromCatalogAction(top, { snap, classification, history, context, fillResult });
  }

  return null;
}

function confMargin(classification) {
  if (String(classification?.confidence || "").toLowerCase() === "high") return HIGH_CONF_MARGIN;
  return CLEAR_WIN_MARGIN;
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

  const plan = {
    type: action.type,
    reason: action.reason,
    source: action.source || "action-catalog",
    step: action.step,
    catalogId: action.id,
    catalogScore: action.score,
  };
  if (action.targetCandidate) plan.targetCandidate = action.targetCandidate;
  if (action.instruction) plan.instruction = action.instruction;
  if (action.mappedTo) plan.mappedTo = action.mappedTo;
  if (action.situationSkillId) plan.situationSkillId = action.situationSkillId;
  return plan;
}

/**
 * Top-N catalog rows for LLM context.
 * @param {import('./actionCatalog.js').CatalogAction[]} catalog
 * @param {number} [n]
 */
export function topCatalogActions(catalog, n = 6) {
  return (catalog || [])
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, n)
    .map((a) => ({
      id: a.id,
      type: a.type,
      score: a.score,
      reason: a.reason,
      step: a.step,
    }));
}
