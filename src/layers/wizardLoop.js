/**
 * Action-driven wizard state machine:
 * observe → assess → fill_missing | commit_step | advance | escalate | handoff
 */
import { canUseStagehand } from "./stagehandAdapter.js";
import {
  currentStepIncomplete,
  looksLikeSteppedForm,
  wizardAdvanced,
} from "./steppedForm.js";
import { assessCompletenessFromSnap } from "./CompletenessOracle.js";

/** @typedef {'not_wizard'|'fill_missing_required'|'commit_current_step'|'advance'|'escalate_to_stagehand'|'handoff_to_user'} WizardSituation */

/** WaaS (or similar) still reports required fields via authoritative validation. */
export function waasStillMissing(snap) {
  const v = snap?.waasValidation;
  if (!v?.available) return false;
  if (Array.isArray(v.missing) && v.missing.length > 0) return true;
  if (Number(v.visibleRequiredCount) > 0) return true;
  return false;
}

/** commit_step only helps when a city/location typeahead may need blur/select. */
export function stepLooksLikeTypeaheadCommit(snap) {
  const url = String(snap?.url || "");
  // Skills / Role multi-selects are not Places typeaheads — never commit_step for city.
  if (/\/application\/(skills|role|experience)\b/i.test(url)) return false;
  if (/\/application\/location\b/i.test(url)) return true;
  const controls = [...(snap?.customControls || []), ...(snap?.fields || [])];
  return controls.some((c) => {
    const widget = String(c.widgetType || c.type || "").toLowerCase();
    const mapped = String(c.mappedTo || "").toLowerCase();
    const label = `${c.label || ""} ${c.questionLabel || ""}`;
    if (mapped === "location" || mapped === "relocatelocations") return true;
    if (widget === "typeahead" && /location|city|where are you|live in|hometown/i.test(label)) return true;
    if (widget === "combobox" && /location|city|where are you/i.test(label)) return true;
    return false;
  });
}

/**
 * @param {object} snap
 * @param {object|null} fillResult
 * @param {object[]} history
 * @param {{ advanceStuck?: boolean, stuckCount?: number, context?: object }} [opts]
 */
export function observeWizard(snap, fillResult = null, history = [], opts = {}) {
  const incomplete = looksLikeSteppedForm(snap) ? currentStepIncomplete(snap, fillResult) : false;
  const continueEnabled =
    (snap?.continueCount || 0) > 0 && !snap?.continueCandidates?.[0]?.disabled;
  const recentFills = history.filter((h) => h.action === "smart_fill").slice(-5);
  const fillStall =
    recentFills.length >= 3 && recentFills.every((h) => h.progress === false || h.ok === false);
  const oracle = looksLikeSteppedForm(snap)
    ? assessCompletenessFromSnap(snap, fillResult)
    : { complete: false, reason: "not_wizard", missing: [] };
  const readyToAdvance =
    looksLikeSteppedForm(snap) && oracle.complete;
  const serverMissing = waasStillMissing(snap);
  return {
    isWizard: looksLikeSteppedForm(snap),
    incomplete: incomplete || serverMissing || (looksLikeSteppedForm(snap) && !oracle.complete),
    continueEnabled,
    readyToAdvance: readyToAdvance && !serverMissing,
    fillStall,
    advanceStuck: Boolean(opts.advanceStuck),
    stuckCount: Math.max(0, opts.stuckCount || 0),
    canStagehand: canUseStagehand(opts.context || {}).ok,
    url: String(snap?.url || ""),
    serverMissing,
    canCommitTypeahead: stepLooksLikeTypeaheadCommit(snap),
    missingKeys: oracle.missing?.length
      ? oracle.missing
      : snap?.waasValidation?.missing || [],
    oracleReason: oracle.reason,
  };
}

/**
 * @param {ReturnType<typeof observeWizard>} obs
 * @returns {{ situation: WizardSituation, reason: string }}
 */
export function assessWizard(obs) {
  if (!obs?.isWizard) {
    return { situation: "not_wizard", reason: "not a stepped wizard" };
  }

  // Authoritative missing fields (WaaS serverErrors / Required) → always fill.
  // Never commit_step: that only helps city typeaheads, not radios/checkboxes.
  if (obs.serverMissing) {
    const keys = (obs.missingKeys || []).slice(0, 6).join(", ");
    if (obs.stuckCount >= 3) {
      return {
        situation: "handoff_to_user",
        reason: `wizard — serverErrors still open (${keys || "required"}); handoff`,
      };
    }
    if (obs.fillStall && obs.canStagehand && obs.stuckCount >= 1) {
      return {
        situation: "escalate_to_stagehand",
        reason: `wizard — serverErrors still open (${keys || "required"}); escalate fill`,
      };
    }
    return {
      situation: "fill_missing_required",
      reason: keys
        ? `wizard — serverErrors still present (${keys}); keep filling`
        : "wizard — Required markers still open; keep filling",
    };
  }

  // Only when Continue just failed to leave the step — not on every later decide.
  if (obs.advanceStuck) {
    if (obs.stuckCount >= 3) {
      return {
        situation: "handoff_to_user",
        reason: "wizard — Continue did not advance after commit + Stagehand retries",
      };
    }
    if (obs.stuckCount >= 2 && obs.canStagehand) {
      return {
        situation: "escalate_to_stagehand",
        reason: obs.canCommitTypeahead
          ? "wizard — Continue stuck; escalate to Stagehand to commit city and advance"
          : "wizard — Continue stuck; escalate to Stagehand to finish required fields and advance",
      };
    }
    // commit_step only when a typeahead may need blur/select; otherwise keep filling.
    if (obs.canCommitTypeahead) {
      return {
        situation: "commit_current_step",
        reason: "wizard — Continue did not advance; commit typeahead then retry",
      };
    }
    return {
      situation: "fill_missing_required",
      reason: "wizard — Continue did not advance; fill missing required (no typeahead to commit)",
    };
  }

  if (obs.incomplete) {
    if (obs.fillStall && obs.continueEnabled && obs.canCommitTypeahead) {
      return {
        situation: "commit_current_step",
        reason: "wizard — fill stalled with Continue enabled; commit widgets before more fill",
      };
    }
    if (obs.fillStall && obs.canStagehand) {
      return {
        situation: "escalate_to_stagehand",
        reason: `wizard — fill stalled; remaining: ${(obs.missingKeys || []).slice(0, 6).join(", ") || "required"}`,
      };
    }
    return {
      situation: "fill_missing_required",
      reason: "wizard — fill missing required fields on current step",
    };
  }

  if (obs.readyToAdvance) {
    return {
      situation: "advance",
      reason: `wizard — oracle complete (${obs.oracleReason || "ok"}); advance`,
    };
  }

  if (obs.continueEnabled && !obs.incomplete) {
    // Continue visible but oracle not complete — keep filling, never advance on button alone.
    return {
      situation: "fill_missing_required",
      reason: "wizard — Continue enabled but oracle incomplete; fill remaining",
    };
  }

  return { situation: "not_wizard", reason: "wizard — no continue CTA" };
}

/**
 * Build a focused Stagehand instruction for stuck wizard advance.
 * @param {object} snap
 * @param {object} [context]
 */
export function buildWizardAdvanceInstruction(snap, context = {}) {
  const applicant = context.applicant || context.profile || {};
  const prefs = context.preferences || {};
  const city =
    String(applicant.city || prefs.location || context.city || "").trim() || "the city already shown";
  const path = (() => {
    try {
      return new URL(String(snap?.url || "")).pathname;
    } catch {
      return "";
    }
  })();
  const missing = snap?.waasValidation?.missing || [];
  if (missing.length || /\/application\/role\b/i.test(path)) {
    const keys = missing.length ? missing.join(", ") : "required radios/checkboxes";
    return (
      `Multi-step application wizard is stuck${path ? ` on ${path}` : ""}. ` +
      `Required fields still open (${keys}). Fill them (pick the matching radio/checkbox/option — ` +
      `never type a calendar year into years-of-experience). Then click Continue. ` +
      `Do not open new tabs or leave the application.`
    );
  }
  if (!stepLooksLikeTypeaheadCommit(snap) && path) {
    return (
      `Multi-step application wizard is stuck on ${path}. ` +
      `Complete every remaining required field on this step, then click Continue or Next. ` +
      `Do not open new tabs or leave the application.`
    );
  }
  return (
    `Multi-step application wizard is stuck${path ? ` on ${path}` : ""}. ` +
    `Ensure the city/location typeahead has a committed suggestion selected (not just typed text) — prefer "${city}". ` +
    `Then click the enabled Continue or Next button. Do not open new tabs or leave the application.`
  );
}

/**
 * @param {{ situation: WizardSituation, reason: string }} assessment
 * @param {{ snap?: object, context?: object }} [opts]
 * @returns {object|null} agent plan
 */
export function planWizardAction(assessment, opts = {}) {
  const { situation, reason } = assessment || {};
  switch (situation) {
    case "fill_missing_required":
      return { type: "smart_fill", reason, source: "wizard" };
    case "commit_current_step":
      return { type: "commit_step", reason, source: "wizard" };
    case "advance":
      return { type: "click_continue", reason, source: "wizard" };
    case "escalate_to_stagehand":
      return {
        type: "stagehand_act",
        instruction: buildWizardAdvanceInstruction(opts.snap, opts.context),
        reason,
        source: "wizard",
      };
    case "handoff_to_user":
      return { type: "wait_user", reason, source: "wizard" };
    default:
      return null;
  }
}

/**
 * Full observe → assess → plan for stepped wizards.
 * @returns {{ plan: object, situation: WizardSituation, reason: string }|null}
 */
export function decideWizardPlan(snap, fillResult, history, context, opts = {}) {
  const obs = observeWizard(snap, fillResult, history, { ...opts, context });
  const assessment = assessWizard(obs);
  if (assessment.situation === "not_wizard") return null;
  const plan = planWizardAction(assessment, { snap, context });
  if (!plan) return null;
  return { plan, situation: assessment.situation, reason: assessment.reason };
}

/**
 * After Continue: either queue fill of the new step, or queue stuck recovery.
 * @returns {object|null} pending plan
 */
export function planAfterWizardContinue(before, after, fillResult, opts = {}) {
  if (!after) return null;
  if (wizardAdvanced(before, after)) {
    // Reuse stepped-form "new step needs fill" via caller’s planAfterContinue.
    return { advanced: true, stuck: false };
  }
  const stuckCount = Math.max(1, (opts.stuckCount || 0) + 1);
  const decided = decideWizardPlan(after, fillResult, opts.history || [], opts.context, {
    advanceStuck: true,
    stuckCount,
  });
  const fallbackType = stepLooksLikeTypeaheadCommit(after) ? "commit_step" : "smart_fill";
  return {
    advanced: false,
    stuck: true,
    stuckCount,
    plan: decided?.plan || {
      type: fallbackType,
      reason:
        fallbackType === "commit_step"
          ? "wizard — Continue did not advance"
          : "wizard — Continue did not advance; fill missing required",
      source: "wizard",
    },
    situation: decided?.situation || (fallbackType === "commit_step" ? "commit_current_step" : "fill_missing_required"),
  };
}
