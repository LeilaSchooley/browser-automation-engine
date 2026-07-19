/**
 * Synthesize per-host learnings from agent runs — field hints, auth/modal selectors, outcomes.
 */
import { normalizeHost } from "./host.js";
import {
  isJobAlertInterstitial,
  looksLikeClosedJobListing,
  looksLikeJobAlertSignupForm,
  looksLikeMarketingYesNoModal,
  boardLeaveSucceeded,
} from "./heuristics.js";
import {
  recordSiteLearning,
  mergeAuthSelectors,
  mergeFieldHints,
  mergeModalSelectors,
  mergeControlSkills,
  mergeAffordanceSkills,
  mergeSituationSkills,
  normalizeFieldHints,
  stableAuthSelector,
} from "./siteLearnings.js";
import { enqueueSkillProposal } from "./skillProposals.js";
import { recordEngineEvent } from "./observability.js";
import { getSettings } from "./runtime.js";

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
    const isAppControl =
      entry.source === "custom_controls" ||
      entry.widgetType === "combobox" ||
      entry.widgetType === "yesno" ||
      entry.widgetType === "radio" ||
      entry.widgetType === "select" ||
      ["visasponsorship", "workauthorization", "policyack", "eeocgender", "eeocrace", "eeocveteran", "eeocdisability"].includes(
        String(entry.mappedTo || type).toLowerCase(),
      );
    if (isAppControl) {
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
    // Remember clicks that advanced the flow, or dismiss/board_nav that cleared a blocker.
    if (Array.isArray(L.affordanceSkills) && step.ok) {
      const softIntent = L.affordanceSkills.some((s) =>
        ["upsell_dismiss", "board_nav"].includes(String(s.intent || "")),
      );
      if (step.progress || softIntent) {
        affordanceSkills.push(...L.affordanceSkills);
      }
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

  // Persist only the clicked apply entry (validated progress), never unranked DOM [0] / page URL.
  const successfulEntry = [...(history || [])]
    .reverse()
    .find((h) => h.action === "click_apply" && h.ok && h.progress && (h.entryKey || h.entryText || h.entryHref));
  if (successfulEntry) {
    if (successfulEntry.entryText) patch.entryText = String(successfulEntry.entryText).slice(0, 120);
    if (successfulEntry.entryHref && !/ycombinator\.com\/apply\/?$/i.test(successfulEntry.entryHref)) {
      patch.entryHref = String(successfulEntry.entryHref).slice(0, 240);
    }
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

  const reflection = reflectFromHistory(history, snap);
  if (reflection) {
    Object.assign(patch, reflection);
  }

  const situations = harvestSituationSkills({ history, snap, host, outcome });
  if (situations.skills?.length) {
    patch.situationSkills = mergeSituationSkills([], situations.skills);
    recordEngineEvent("skill_harvest", {
      host,
      count: situations.skills.length,
      signatures: situations.skills.map((s) => s.signature),
    });
  }
  for (const proposal of situations.proposals || []) {
    enqueueSkillProposal({ host, ...proposal });
  }

  return { host, patch };
}

/**
 * Harvest situation skills from board traps / clear recovery patterns.
 */
export function harvestSituationSkills({ history = [], snap = null, host = "", outcome = "partial" } = {}) {
  const skills = [];
  const proposals = [];

  if (boardLeaveSucceeded(history)) {
    skills.push({
      signature: "board_signup_onboarding",
      action: "nav_recovery",
      avoidActions: ["click_continue", "click_signup"],
      urlPattern: "/onboard",
      bodyHints: ["how long have you been searching", "find your dream job"],
      priority: 92,
      confidence: "high",
      successCount: 1,
      hostPattern: host,
    });
    const signupAfter = history.some(
      (h, i) =>
        h.action === "click_signup" &&
        history.slice(0, i).some((x) => /leave_board/i.test(String(x.source || ""))),
    );
    if (signupAfter || outcome === "failed" || outcome === "review") {
      skills.push({
        signature: "board_leave_skip_signup",
        action: "click_apply",
        avoidActions: ["click_signup"],
        priority: 90,
        confidence: "high",
        successCount: 1,
        hostPattern: host,
      });
    }
  }

  const continues = history.filter((h) => h.action === "click_continue");
  if (continues.length >= 3 && history.filter((h) => h.action === "smart_fill" && h.progress).length === 0) {
    proposals.push({
      evidence: `click_continue×${continues.length} with no fill progress`,
      skill: {
        signature: "continue_loop_no_fill",
        action: "smart_fill",
        avoidActions: ["click_continue"],
        priority: 70,
        confidence: "medium",
        successCount: 1,
      },
    });
  }

  return { skills, proposals };
}

/**
 * Lightweight reflection — what stalled, which actions failed, what to try next.
 * Persisted into site learnings so the next run on this host boosts recovery.
 */
export function reflectFromHistory(history = [], snap = null) {
  if (!history?.length) return null;
  const failed = history.filter((h) => h.ok === false || (h.ok && h.progress === false)).slice(-10);
  if (!failed.length && history.every((h) => h.progress)) return null;

  const lastStall = [...history].reverse().find((h) => !h.progress) || history[history.length - 1];
  const failedActions = [...new Set(failed.map((h) => h.action).filter(Boolean))].slice(0, 8);

  let suggestedNext = "dismiss_overlay";
  const act = lastStall?.action || "";
  if (act === "smart_fill" && (snap?.hasBlockingOverlay || snap?.hasApplyModal)) suggestedNext = "dismiss_overlay";
  else if (act === "auth_login") suggestedNext = "auth_signup";
  else if (act === "click_continue" || act === "click_apply") suggestedNext = "smart_fill";
  else if (act === "dismiss_overlay") suggestedNext = "click_continue";
  else if (act === "stagehand_act") suggestedNext = "wait_user";
  else if (act === "click_signup" && boardLeaveSucceeded(history)) suggestedNext = "wait_user";
  else if (snap?.entryCount > 0) suggestedNext = "click_apply";
  else if ((snap?.fileInputCount || 0) > 0) suggestedNext = "upload_resume";

  const proposedSkills = [];
  if (act === "click_signup" && boardLeaveSucceeded(history)) {
    proposedSkills.push({
      signature: "board_leave_skip_signup",
      action: "wait_user",
      avoidActions: ["click_signup"],
      priority: 88,
      confidence: "high",
      successCount: 1,
    });
  } else if (failedActions.includes("click_continue") && failedActions.length >= 2) {
    proposedSkills.push({
      signature: "stalled_continue",
      action: suggestedNext,
      avoidActions: ["click_continue"],
      priority: 65,
      confidence: "medium",
      successCount: 1,
    });
  }

  if (getSettings().reflection_enabled !== false) {
    for (const skill of proposedSkills) {
      if (skill.confidence !== "high") {
        enqueueSkillProposal({
          host: normalizeHost(snap?.hostname || ""),
          evidence: `stall on ${act}; failed=${failedActions.join(",")}`,
          skill,
        });
      }
    }
  }

  return {
    lastStallReason: String(lastStall?.reason || lastStall?.action || "stalled").slice(0, 200),
    failedActions,
    suggestedNext,
    proposedSituationSkills: proposedSkills.length ? proposedSkills : undefined,
    reflectedAt: new Date().toISOString(),
  };
}

/**
 * Persist learnings when the run warrants it.
 * @returns {object | null}
 */
export function recordLearningsFromRun(args = {}) {
  if (!shouldRecordLearnings(args)) {
    if (args.outcome === "failed" || args.outcome === "review") {
      const reflection = reflectFromHistory(args.history || [], args.snap || null);
      const host = normalizeHost(args.hostname || "");
      const situations = harvestSituationSkills({
        history: args.history || [],
        snap: args.snap || null,
        host,
        outcome: args.outcome,
      });
      const patch = { ...(reflection || {}) };
      if (situations.skills?.length) {
        patch.situationSkills = mergeSituationSkills([], situations.skills);
      }
      for (const proposal of situations.proposals || []) {
        enqueueSkillProposal({ host, ...proposal });
      }
      if (host && Object.keys(patch).length) return recordSiteLearning(host, patch);
    }
    return null;
  }
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
