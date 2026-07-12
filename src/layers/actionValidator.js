import { pageFingerprint } from "./formDiscovery.js";
import { getRuntime, getSettings } from "../runtime.js";

function renderInteractives(snap, limit = 22) {
  const items = (snap?.interactives || []).slice(0, limit);
  if (!items.length) return "(no interactives)";
  return items
    .map((i) => {
      const flags = [i.inModal ? "modal" : "", i.inNav ? "nav" : ""].filter(Boolean).join(",");
      const href = i.href ? ` href=${i.href.slice(0, 80)}` : "";
      return `#${i.index} [${i.kind}/${i.tag}] "${i.text || i.aria || "?"}"${href}${flags ? ` (${flags})` : ""}`;
    })
    .join("\n");
}

function renderFields(snap, limit = 10) {
  const fields = (snap?.fields || []).slice(0, limit);
  if (!fields.length) return "(none)";
  return fields
    .map(
      (f) =>
        `- ${f.type} "${f.label || f.name || "?"}"${f.required ? " (required)" : ""}${f.filled ? " [filled]" : ""}`,
    )
    .join("\n");
}

function snapSummary(snap) {
  if (!snap) return "(missing snapshot)";
  return [
    `URL: ${snap.url || "?"}`,
    `Title: ${snap.title || "?"}`,
    `pageKind=${snap.pageKind || "?"} fields=${snap.fieldCount || 0} fileInputs=${snap.fileInputCount || 0}`,
    `applyModal=${snap.hasApplyModal ? "yes" : "no"} cookieBanner=${snap.cookieBanner ? "yes" : "no"}`,
    `blockingOverlay=${snap.hasBlockingOverlay ? "yes" : "no"}`,
    `Fields:\n${renderFields(snap)}`,
    `Elements:\n${renderInteractives(snap)}`,
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
export function computeMechanicalSignals(snapBefore, snapAfter, { filledBefore = 0, filledAfter = 0 } = {}) {
  return {
    fingerprintChanged: pageFingerprint(snapBefore) !== pageFingerprint(snapAfter),
    urlChanged: String(snapBefore?.url || "") !== String(snapAfter?.url || ""),
    fieldCountDelta: (snapAfter?.fieldCount || 0) - (snapBefore?.fieldCount || 0),
    fileInputDelta: (snapAfter?.fileInputCount || 0) - (snapBefore?.fileInputCount || 0),
    modalAppeared: !snapBefore?.hasApplyModal && Boolean(snapAfter?.hasApplyModal),
    filledDelta: filledAfter - filledBefore,
  };
}

/** Strong DOM signals — safe to trust without an LLM call. */
export function isStrongMechanicalProgress(signals, mechanicalProgress, actorOk) {
  if (!actorOk || !mechanicalProgress) return false;
  return (
    signals.urlChanged ||
    signals.fieldCountDelta > 0 ||
    signals.fileInputDelta > 0 ||
    signals.modalAppeared ||
    signals.filledDelta > 0
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

const RECOVERY_ACTIONS = new Set([
  "dismiss_overlay",
  "upload_resume",
  "click_modal",
  "click_apply",
  "click_continue",
  "accept_cookies",
  "smart_fill",
  "wait_load",
  "manual",
  "done",
  "wait_user",
  "ai_replan",
]);

export function parseValidatorResponse(text) {
  if (!text) return null;
  let raw = String(text).trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const data = JSON.parse(raw);
  if (typeof data.progressed !== "boolean") return null;
  const recovery =
    data.recovery && RECOVERY_ACTIONS.has(String(data.recovery)) ? String(data.recovery) : null;
  return {
    progressed: data.progressed,
    reason: String(data.reason || "validator").slice(0, 240),
    recovery,
    source: "validator",
  };
}

export function parseEndStateResponse(text) {
  if (!text) return null;
  let raw = String(text).trim();
  if (raw.startsWith("```")) {
    raw = raw.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }
  const data = JSON.parse(raw);
  const action = String(data.action || "manual").toLowerCase();
  if (!RECOVERY_ACTIONS.has(action) && action !== "manual") {
    return { action: "manual", reason: String(data.reason || "").slice(0, 240) };
  }
  return {
    action,
    target: String(data.target || "").slice(0, 200),
    reason: String(data.reason || "end-state assessor").slice(0, 240),
  };
}

async function runValidatorLlm({ plan, snapBefore, snapAfter, fillResult, mechanicalProgress, actorOk, history, context, signals }) {
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
${snapSummary(snapBefore)}

--- AFTER ---
${snapSummary(snapAfter)}

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
}) {
  const filledAfter = fillResult?.filled?.length || 0;
  const signals = computeMechanicalSignals(snapBefore, snapAfter, { filledBefore, filledAfter });

  if (!actorOk && !mechanicalProgress) {
    return {
      progressed: false,
      reason: plan?.reason ? `actor failed: ${plan.reason}` : "actor failed",
      recovery: "ai_replan",
      source: "fast-fail",
    };
  }

  if (isStrongMechanicalProgress(signals, mechanicalProgress, actorOk)) {
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
