import { pageFingerprint } from "./formDiscovery.js";
import { getRuntime, getSettings } from "../runtime.js";
import { buildAgentContext } from "./agentContext.js";
import {
  EndStateResponseSchema,
  ValidatorResponseSchema,
  parseJsonFromLlm,
} from "../ai/contracts.js";

function snapSummary(snap, layoutBlock = "") {
  if (!snap) return "(missing snapshot)";
  return [
    `URL: ${snap.url || "?"}`,
    `Title: ${snap.title || "?"}`,
    `pageKind=${snap.pageKind || "?"} fields=${snap.fieldCount || 0} fileInputs=${snap.fileInputCount || 0}`,
    `applyModal=${snap.hasApplyModal ? "yes" : "no"} pickerOpen=${snap.pickerOpen ? "yes" : "no"}`,
    layoutBlock,
  ].join("\n");
}

function objectiveLabel(context) {
  const job = context?.job || {};
  const title = job.title || context?.title || "";
  const company = job.company || context?.company || "";
  if (title && company) return `${title} at ${company}`;
  return title || company || "application";
}

/** @param {Record<string, unknown>} snapBefore @param {Record<string, unknown>} snapAfter */
function salaryUnfilledCount(snap) {
  return (snap?.customControls || []).filter(
    (c) => !c.filled && (c.mappedTo === "salary" || /salary|compensation/i.test(String(c.label || ""))),
  ).length;
}

function hostOf(snap) {
  try {
    return new URL(snap?.url || `https://${snap?.hostname || ""}`).hostname.replace(/^www\./, "");
  } catch {
    return String(snap?.hostname || "").replace(/^www\./, "");
  }
}

function looksLikeAuthOrOtpSurface(snap) {
  if (!snap) return false;
  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  if ((snap.passwordFieldCount || 0) > 0) return true;
  return /\b(log\s?in|sign\s?in|verify code|enter the code|one[- ]time|otp|create an account)\b/.test(blob);
}

export function computeMechanicalSignals(snapBefore, snapAfter, { filledBefore = 0, filledAfter = 0, uiPhaseBefore = "idle", uiPhaseAfter = "idle" } = {}) {
  const salaryBefore = salaryUnfilledCount(snapBefore);
  const salaryAfter = salaryUnfilledCount(snapAfter);
  const commitCompleted =
    uiPhaseBefore === "option_selected_uncommitted" &&
    (uiPhaseAfter === "ready_to_continue" || uiPhaseAfter === "idle") &&
    !snapAfter?.pickerOpen;
  const hostBefore = hostOf(snapBefore);
  const hostAfter = hostOf(snapAfter);
  return {
    fingerprintChanged: pageFingerprint(snapBefore) !== pageFingerprint(snapAfter),
    urlChanged: String(snapBefore?.url || "") !== String(snapAfter?.url || ""),
    hostChanged: Boolean(hostBefore && hostAfter && hostBefore !== hostAfter),
    fieldCountDelta: (snapAfter?.fieldCount || 0) - (snapBefore?.fieldCount || 0),
    fileInputDelta: (snapAfter?.fileInputCount || 0) - (snapBefore?.fileInputCount || 0),
    modalAppeared: !snapBefore?.hasApplyModal && Boolean(snapAfter?.hasApplyModal),
    filledDelta: filledAfter - filledBefore,
    salaryCommittedDelta: salaryBefore - salaryAfter,
    pickerClosed: Boolean(snapBefore?.pickerOpen) && !snapAfter?.pickerOpen,
    commitCompleted,
    stillOnAuthOrOtp: looksLikeAuthOrOtpSurface(snapAfter),
    uiPhaseBefore,
    uiPhaseAfter,
  };
}

/** Strong DOM signals — safe to trust without an LLM call. */
export function isStrongMechanicalProgress(signals, mechanicalProgress, actorOk, plan = null) {
  if (!actorOk || !mechanicalProgress) return false;
  const customFill = plan?.type === "smart_fill" || plan?.type === "act";
  if (customFill && signals.filledDelta > 0 && !signals.commitCompleted && !signals.salaryCommittedDelta && !signals.pickerClosed) {
    return false;
  }
  // Board wizard Next that only advances ?step= with no fills is not progress.
  if (
    plan?.type === "click_continue" &&
    signals.urlChanged &&
    signals.filledDelta === 0 &&
    !(signals.fieldCountDelta > 0) &&
    !(signals.fileInputDelta > 0) &&
    !signals.modalAppeared
  ) {
    return false;
  }
  // Fingerprint-only churn on a login/OTP wall is not apply progress (e.g. YC magic-link).
  if (
    signals.stillOnAuthOrOtp &&
    !signals.hostChanged &&
    !(signals.fieldCountDelta > 0) &&
    !(signals.fileInputDelta > 0) &&
    !signals.modalAppeared &&
    ["click_continue", "smart_fill", "auth_login", "stagehand_act"].includes(plan?.type)
  ) {
    return false;
  }
  // Cosmetic fingerprint change alone is not strong progress.
  if (
    signals.fingerprintChanged &&
    !signals.urlChanged &&
    !signals.hostChanged &&
    !(signals.fieldCountDelta > 0) &&
    !(signals.fileInputDelta > 0) &&
    !signals.modalAppeared &&
    !(signals.filledDelta > 0) &&
    !signals.salaryCommittedDelta &&
    !signals.pickerClosed &&
    !signals.commitCompleted
  ) {
    return false;
  }
  return (
    signals.urlChanged ||
    signals.hostChanged ||
    signals.fieldCountDelta > 0 ||
    signals.fileInputDelta > 0 ||
    signals.modalAppeared ||
    (signals.filledDelta > 0 && !customFill) ||
    signals.salaryCommittedDelta > 0 ||
    signals.pickerClosed ||
    signals.commitCompleted
  );
}

export function shouldRunValidator({ actorOk, mechanicalProgress, signals }) {
  const settings = getSettings();
  const { callLlm } = getRuntime();
  if (settings.action_validator === false || typeof callLlm !== "function") return false;
  if (!actorOk && !mechanicalProgress) return false;
  if (isStrongMechanicalProgress(signals, mechanicalProgress, actorOk)) return false;
  return true;
}

export function parseValidatorResponse(text) {
  // Accept alias recoveries ("dismiss") then normalize to catalog action ids.
  let raw = null;
  try {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    raw = JSON.parse(match ? match[0] : text);
  } catch {
    raw = null;
  }
  if (!raw || typeof raw.progressed !== "boolean") {
    const data = parseJsonFromLlm(text, ValidatorResponseSchema);
    if (!data) return null;
    return {
      progressed: data.progressed,
      reason: data.reason || "validator",
      recovery: normalizeRecoveryAction(data.recovery),
      source: "validator",
    };
  }
  return {
    progressed: raw.progressed,
    reason: String(raw.reason || "validator").slice(0, 240),
    recovery: normalizeRecoveryAction(raw.recovery),
    source: "validator",
  };
}

/** Map free-text / alias recoveries onto catalog action types. */
export function normalizeRecoveryAction(recovery) {
  if (!recovery) return null;
  const raw = String(recovery).trim().toLowerCase().replace(/\s+/g, "_");
  const aliases = {
    dismiss: "dismiss_overlay",
    dismiss_overlay: "dismiss_overlay",
    overlay: "dismiss_overlay",
    upload: "upload_resume",
    upload_resume: "upload_resume",
    modal: "click_modal",
    click_modal: "click_modal",
    apply: "click_apply",
    click_apply: "click_apply",
    continue: "click_continue",
    click_continue: "click_continue",
    cookies: "accept_cookies",
    accept_cookies: "accept_cookies",
    fill: "smart_fill",
    smart_fill: "smart_fill",
    wait: "wait_load",
    wait_load: "wait_load",
    ai: "ai_replan",
    ai_replan: "ai_replan",
    signup: "auth_signup",
    auth_signup: "auth_signup",
    login: "auth_login",
    auth_login: "auth_login",
    otp: "enter_otp",
    enter_otp: "enter_otp",
    wait_otp: "enter_otp",
    click_signup: "click_signup",
    create_account: "click_signup",
  };
  return aliases[raw] || (raw.includes("dismiss") ? "dismiss_overlay" : null);
}

/** Actor claimed success but DOM fingerprint/URL/modals unchanged — likely wrong click. */
export function isLikelyNoopClick(signals, mechanicalProgress, actorOk) {
  if (!actorOk || mechanicalProgress) return false;
  return (
    !signals.fingerprintChanged &&
    !signals.urlChanged &&
    !signals.modalAppeared &&
    !signals.pickerClosed &&
    !signals.commitCompleted &&
    (signals.fieldCountDelta || 0) === 0 &&
    (signals.fileInputDelta || 0) === 0 &&
    (signals.filledDelta || 0) === 0
  );
}

export function parseEndStateResponse(text) {
  const data = parseJsonFromLlm(text, EndStateResponseSchema);
  if (!data) return { action: "manual", reason: "", target: "" };
  return {
    action: data.action,
    target: data.target || "",
    reason: data.reason || "end-state assessor",
  };
}

async function runValidatorLlm({
  plan,
  snapBefore,
  snapAfter,
  fillResult,
  mechanicalProgress,
  actorOk,
  history,
  context,
  signals,
  layoutBefore = "",
  layoutAfter = "",
}) {
  const { callLlm } = getRuntime();
  const recent = (history || [])
    .slice(-6)
    .map((h) => `${h.applyStep || h.action}${h.ok ? "" : " FAILED"}${h.progress ? "" : " (no progress)"}`)
    .join(" → ");

  const prompt = `You verify whether a browser automation action made meaningful progress toward filling an application form.

Target: ${objectiveLabel(context)}
Action: ${plan?.type || "?"} — ${plan?.reason || "?"}
Actor reported success: ${actorOk ? "yes" : "no"}
Mechanical DOM diff: fingerprintChanged=${signals.fingerprintChanged}, urlChanged=${signals.urlChanged}, fieldDelta=${signals.fieldCountDelta}, fileInputDelta=${signals.fileInputDelta}, modalAppeared=${signals.modalAppeared}, filledDelta=${signals.filledDelta}
Mechanical verdict (fingerprint/score): ${mechanicalProgress ? "changed" : "unchanged"}
Filled fields after action: ${fillResult?.filled?.length || 0}
Recent history: ${recent || "none"}

--- BEFORE ---
${snapSummary(snapBefore, layoutBefore)}

--- AFTER ---
${snapSummary(snapAfter, layoutAfter)}

Did this action progress toward reaching and filling the real application form (not ads, cookie settings, unrelated navigation, or swapping one blocker for another)?
If progressed is false, suggest ONE recovery action the agent should try next.
Return ONLY JSON:
{"progressed": true|false, "reason": "one short sentence", "recovery": "dismiss_overlay"|"upload_resume"|"click_modal"|"click_apply"|"click_continue"|"accept_cookies"|"smart_fill"|"wait_load"|"ai_replan"|null}`;

  const text = await callLlm(prompt);
  return parseValidatorResponse(text);
}

/**
 * End-state assessor — last intelligent check before manual handoff.
 */
export async function assessAgentEndState({ snap, fillResult, history, context }) {
  const settings = getSettings();
  const { callLlm } = getRuntime();
  if (settings.action_validator === false || typeof callLlm !== "function") {
    return { action: "manual", reason: "assessor disabled" };
  }

  const filled = fillResult?.filled?.length || 0;
  const recent = (history || [])
    .slice(-8)
    .map((h) => `${h.action}${h.ok ? "" : " FAIL"}${h.progress ? "" : " (stuck)"}`)
    .join(" → ");

  const prompt = `You are reviewing a browser agent that is about to give up and ask the human to continue manually.

Target: ${objectiveLabel(context)}
Filled fields: ${filled}
Recent steps: ${recent || "none"}

Current page:
${snapSummary(snap)}

Is there ONE more automated action that could reasonably advance toward the real application form?
Consider any blocker: modals, upsells, wizards, upload steps, cookie banners, apply buttons, multi-step flows.

Return ONLY JSON:
{"action": "dismiss_overlay"|"upload_resume"|"click_modal"|"click_apply"|"click_continue"|"accept_cookies"|"smart_fill"|"wait_load"|"wait_user"|"done"|"manual", "target": "optional element text or empty", "reason": "one short sentence"}`;

  try {
    const text = await callLlm(prompt);
    const parsed = parseEndStateResponse(text);
    if (parsed) return parsed;
  } catch {
    /* fall through */
  }
  return { action: "manual", reason: "assessor unavailable" };
}

/**
 * Post-action semantic validator.
 */
export async function validateActionOutcome({
  plan,
  snapBefore,
  snapAfter,
  fillResult,
  mechanicalProgress,
  actorOk,
  history,
  context,
  filledBefore = 0,
  page = null,
}) {
  const filledAfter = fillResult?.filled?.length || 0;
  const agentBefore = await buildAgentContext(snapBefore, fillResult, page).catch(() => null);
  const agentAfter = await buildAgentContext(snapAfter, fillResult, page).catch(() => null);
  const signals = computeMechanicalSignals(snapBefore, snapAfter, {
    filledBefore,
    filledAfter,
    uiPhaseBefore: agentBefore?.pageState?.uiPhase || "idle",
    uiPhaseAfter: agentAfter?.pageState?.uiPhase || "idle",
  });
  const layoutBefore = agentBefore?.layoutBlock || "";
  const layoutAfter = agentAfter?.layoutBlock || "";

  if (!actorOk && !mechanicalProgress) {
    return {
      progressed: false,
      reason: plan?.reason ? `actor failed: ${plan.reason}` : "actor failed",
      recovery: "ai_replan",
      source: "fast-fail",
    };
  }

  if (getSettings().validator_detect_noop !== false && isLikelyNoopClick(signals, mechanicalProgress, actorOk)) {
    return {
      progressed: false,
      reason: "noop click — page fingerprint unchanged after actor success",
      recovery: plan?.type === "smart_fill" ? "dismiss_overlay" : "ai_replan",
      source: "noop-detect",
    };
  }

  // Stuck on passwordless/OTP login after Continue / fill — do not treat as form progress.
  if (
    signals.stillOnAuthOrOtp &&
    !signals.hostChanged &&
    ["click_continue", "smart_fill", "auth_login", "stagehand_act"].includes(plan?.type)
  ) {
    const afterBlob = `${snapAfter?.title || ""} ${snapAfter?.pageText || ""}`.toLowerCase();
    const wantsOtp = /enter the code|verify code|from your email|one[- ]time|otp/.test(afterBlob);
    const hasSignup = (snapAfter?.signUpCount || 0) > 0;
    return {
      progressed: false,
      reason: wantsOtp
        ? "still on OTP / email-code wall — not apply form progress"
        : "still on login wall — not apply form progress",
      recovery: wantsOtp ? "enter_otp" : hasSignup ? "click_signup" : "ai_replan",
      source: "auth-intent-gate",
    };
  }

  if (isStrongMechanicalProgress(signals, mechanicalProgress, actorOk, plan)) {
    return {
      progressed: true,
      reason: "strong mechanical progress (url, fields, modal, or fill)",
      source: "mechanical",
    };
  }

  if (!shouldRunValidator({ actorOk, mechanicalProgress, signals })) {
    return {
      progressed: Boolean(mechanicalProgress && actorOk),
      reason: mechanicalProgress ? "mechanical DOM change" : "no DOM change",
      source: "mechanical",
    };
  }

  try {
    const verdict = await runValidatorLlm({
      plan,
      snapBefore,
      snapAfter,
      fillResult,
      mechanicalProgress,
      actorOk,
      history,
      context,
      signals,
      layoutBefore,
      layoutAfter,
    });
    if (verdict) return verdict;
  } catch {
    /* fall through */
  }

  return {
    progressed: Boolean(mechanicalProgress && actorOk),
    reason: "validator unavailable — using mechanical fallback",
    source: "mechanical-fallback",
  };
}
