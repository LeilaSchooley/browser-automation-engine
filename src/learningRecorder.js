/**
 * Synthesize per-host learnings from agent runs — field hints, auth/modal selectors, outcomes.
 */
import { normalizeHost } from "./host.js";
import {
  isJobAlertInterstitial,
  looksLikeClosedJobListing,
  looksLikeJobAlertSignupForm,
  looksLikeMarketingYesNoModal,
} from "./heuristics.js";
import {
  recordSiteLearning,
  mergeAuthSelectors,
  mergeFieldHints,
  mergeModalSelectors,
  mergeControlSkills,
  mergeAffordanceSkills,
  normalizeFieldHints,
  stableAuthSelector,
} from "./siteLearnings.js";

/** smart_fill internal type → buildFillConfig key */
const FILL_TYPE_TO_CONFIG_KEY = {
  email: "email",
  firstname: "firstName",
  lastname: "lastName",
  fullname: "fullName",
  tel: "phone",
  coverletter: "coverLetter",
  linkedinurl: "linkedinUrl",
  website: "websiteUrl",
  resume: "resumePath",
  description: "description",
};

const SIGNUP_KIND_TO_AUTH = {
  email: "email",
  username: "username",
  password: "password",
  confirm_password: "password",
};

/**
 * Convert filled[] entries into smart_fill site-mapping shape: { "#sel": { mappedTo } }.
 * @param {Array<{ type?: string, selector?: string }>} filled
 */
export function fieldHintsFromFilled(filled = []) {
  const hints = {};
  const controlSkills = [];
  for (const entry of filled) {
    const selector = entry?.selector;
    const type = String(entry?.type || entry?.mappedTo || "").toLowerCase();
    if (!type) continue;
    if (selector) {
      const mappedTo = FILL_TYPE_TO_CONFIG_KEY[type] || type;
      hints[selector] = { mappedTo };
    }
    if (entry.source === "custom_controls" || entry.widgetType === "combobox") {
      controlSkills.push({
        label: entry.label || type,
        mappedTo: entry.mappedTo || type,
        widgetType: entry.widgetType || "combobox",
        triggerSelector: selector || "",
        optionStrategy: type === "salary" ? "closest_salary_band" : "text_match",
        successCount: 1,
      });
    }
  }
  return { hints, controlSkills };
}

export { normalizeFieldHints, mergeFieldHints, mergeAuthSelectors, mergeModalSelectors };

/**
 * Collect auth/modal hints attached to individual history steps.
 * @param {Array<{ learnings?: object }>} history
 */
export function learningsFromHistory(history = []) {
  const authSelectors = {};
  const modalSelectors = [];
  const affordanceSkills = [];

  for (const step of history) {
    const L = step?.learnings;
    if (!L) continue;
    if (L.authSelectors) {
      Object.assign(authSelectors, mergeAuthSelectors(authSelectors, L.authSelectors));
    }
    if (L.modalSelector) modalSelectors.push(L.modalSelector);
    if (Array.isArray(L.modalSelectors)) modalSelectors.push(...L.modalSelectors);
    // Outcome-weighted: only remember clicks that advanced the flow.
    if (Array.isArray(L.affordanceSkills) && step.ok && step.progress) {
      affordanceSkills.push(...L.affordanceSkills);
    }
  }

  return {
    authSelectors: Object.keys(authSelectors).length ? authSelectors : undefined,
    modalSelectors: modalSelectors.length ? mergeModalSelectors([], modalSelectors) : undefined,
    affordanceSkills: affordanceSkills.length ? affordanceSkills : undefined,
  };
}

export function authSelectorsFromSignupFields(fields = []) {
  const authSelectors = {};
  for (const field of fields) {
    const kind = SIGNUP_KIND_TO_AUTH[field?.kind];
    if (!kind || !field?.selector) continue;
    const stable = stableAuthSelector(field.selector, field);
    if (!stable) continue;
    authSelectors[kind] = [...new Set([...(authSelectors[kind] || []), stable])].slice(0, 8);
  }
  return authSelectors;
}

function isJobAlertSurface(snap) {
  if (!snap) return false;
  return (
    looksLikeJobAlertSignupForm(snap) ||
    looksLikeMarketingYesNoModal(snap) ||
    isJobAlertInterstitial(snap)
  );
}

/**
 * Negative learning: smart_fill typed into a job-alert upsell instead of dismissing.
 */
export function detectAlertFillMistake({ history = [], fillResult = {}, snap = {}, outcome = "" } = {}) {
  const alertSurface = isJobAlertSurface(snap);
  if (!alertSurface) return null;

  const filledEmail = (fillResult.filled || []).some(
    (f) => f.type === "email" || /email/i.test(`${f.label || ""} ${f.type || ""}`),
  );
  const smartFillOnAlert = history.some((h) => h.action === "smart_fill" && h.ok);
  const dismissed = history.some(
    (h) =>
      ["dismiss_overlay", "interstitial_dismiss", "dismiss", "clear_obstacle"].includes(h.action) &&
      h.ok &&
      h.progress,
  );

  if ((filledEmail || smartFillOnAlert) && !dismissed) {
    return { dismissFirst: true, avoidFillWhenAlert: true };
  }
  if (!dismissed && (outcome === "failed" || outcome === "review")) {
    return { dismissFirst: true, avoidFillWhenAlert: true };
  }
  return null;
}

/** Negative learning: closed aggregator listing — skip similar URLs on this host. */
export function detectClosedAggregatorLearning({ snap = {}, history = [], outcome = "" } = {}) {
  const closed = looksLikeClosedJobListing(snap);
  if (closed.closed) {
    return { skipAggregatorApply: true, closedAggregator: true };
  }

  const blockedReason = (history || [])
    .map((h) => String(h.reason || h.message || ""))
    .find((r) => /unavailable|closed.*job|similar jobs only|aggregator mirror|requires local presence/i.test(r));
  if (blockedReason || outcome === "failed") {
    const host = normalizeHost(snap?.hostname || snap?.url || "");
    if (host && /jooble|devitjobs|whatjobs|neuvoo|talent\.com|simplyhired/i.test(host)) {
      return { skipAggregatorApply: true, closedAggregator: true };
    }
  }
  return null;
}

/**
 * Whether this run produced enough signal to persist learnings.
 */
export function shouldRecordLearnings({ history = [], fillResult = {}, snap = {}, bestScore = 0 } = {}) {
  const filledCount = fillResult.filled?.length || 0;
  const progressSteps = history.filter((h) => h.ok && h.progress).length;
  const authOk = history.some(
    (h) => (h.action === "auth_login" || h.action === "auth_signup") && h.ok,
  );
  const modalOk = history.some((h) => h.action === "click_modal" && h.ok);
  const fillOk = history.some((h) => h.action === "smart_fill" && h.ok);
  const navOk = history.some((h) => h.action === "nav_recovery" && h.ok);
  const actOk = history.some((h) => h.action === "act" && h.ok && h.progress);
  const fieldCount = snap?.fieldCount || 0;

  return (
    filledCount >= 1 ||
    authOk ||
    modalOk ||
    fillOk ||
    navOk ||
    (actOk && (filledCount >= 1 || progressSteps >= 3)) ||
    progressSteps >= 3 ||
    bestScore >= 2 ||
    fieldCount >= 2
  );
}

/**
 * Build a learning patch from an agent/pipeline run.
 */
export function synthesizeLearningsFromRun({
  hostname = "",
  history = [],
  fillResult = {},
  snap = {},
  bestScore = 0,
  outcome = "partial",
} = {}) {
  const host = normalizeHost(hostname);
  if (!host) return null;

  const filledCount = fillResult.filled?.length || 0;
  const authLoginOk = history.some((h) => h.action === "auth_login" && h.ok);
  const authSignupOk = history.some((h) => h.action === "auth_signup" && h.ok);
  const progressSteps = history.filter((h) => h.ok && h.progress).length;

  const success =
    outcome === "success" ||
    (filledCount >= 2 && (snap?.fieldCount || 0) >= 2) ||
    (authSignupOk && progressSteps >= 1) ||
    (authLoginOk && filledCount >= 1);

  const patch = {
    success: success || undefined,
    authRequired: authLoginOk || undefined,
    accountCreated: authSignupOk || undefined,
    lastOutcome: outcome,
    lastFilledCount: filledCount,
    lastProgressSteps: progressSteps,
  };

  if (snap?.entryCandidates?.[0]?.text) {
    patch.entryText = snap.entryCandidates[0].text;
  }
  if (snap?.url) {
    patch.entryHref = snap.url;
  }

  const { hints: fieldHints, controlSkills } = fieldHintsFromFilled(fillResult.filled || []);
  if (Object.keys(fieldHints).length) {
    patch.fieldHints = fieldHints;
  }
  if (controlSkills.length) {
    patch.controlSkills = mergeControlSkills([], controlSkills);
  }

  const fromHistory = learningsFromHistory(history);
  if (fromHistory.authSelectors) patch.authSelectors = fromHistory.authSelectors;
  if (fromHistory.modalSelectors?.length) patch.modalSelectors = fromHistory.modalSelectors;
  if (fromHistory.affordanceSkills?.length) {
    patch.affordanceSkills = mergeAffordanceSkills([], fromHistory.affordanceSkills);
  }

  const alertMistake = detectAlertFillMistake({ history, fillResult, snap, outcome });
  if (alertMistake) {
    Object.assign(patch, alertMistake);
  }

  const aggregatorLearning = detectClosedAggregatorLearning({ snap, history, outcome });
  if (aggregatorLearning) {
    Object.assign(patch, aggregatorLearning);
  }

  return { host, patch };
}

/**
 * Persist learnings when the run warrants it.
 * @returns {object | null}
 */
export function recordLearningsFromRun(args = {}) {
  if (!shouldRecordLearnings(args)) return null;
  const synthesized = synthesizeLearningsFromRun(args);
  if (!synthesized?.host || !synthesized.patch) return null;
  return recordSiteLearning(synthesized.host, synthesized.patch);
}

/**
 * Record worker-level outcome (success / failed / review) for retry feedback.
 */
export function recordPipelineOutcome(hostname, { pipeline, status, failReason = "" } = {}) {
  const host = normalizeHost(hostname);
  if (!host) return null;

  const history = pipeline?.agentHistory || pipeline?.history || [];
  const fillResult = pipeline?.fillResult || {};
  const snap = pipeline?.snap || {};
  const outcome =
    status === "failed" ? "failed" : status === "review_needed" ? "review" : "partial";

  const patch = {
    lastWorkerStatus: status,
    lastFailReason: failReason ? String(failReason).slice(0, 240) : undefined,
    lastOutcome: outcome,
  };

  if (status === "failed") {
    patch.success = false;
  }

  const synthesized = synthesizeLearningsFromRun({
    hostname: host,
    history,
    fillResult,
    snap,
    bestScore: fillResult.filled?.length || 0,
    outcome,
  });

  if (synthesized?.patch) {
    Object.assign(patch, synthesized.patch);
  }

  return recordSiteLearning(host, patch);
}
