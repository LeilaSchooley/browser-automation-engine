/**
 * Shared stall / loop predicates used by semantic recovery, action brain, and agent.
 */
import {
  hasUnfilledApplicationFields,
  isStuck,
  shouldPreferUpload,
  uploadStalled,
} from "../../heuristics.js";

/** True when a recent successful action was rejected by the progress validator. */
export function validatorRecentlyRejected(history, n = 2) {
  return (history || []).slice(-n).some((h) => h.progressSource === "validator" && !h.progress && h.ok);
}

/**
 * True when the same action repeats without progress.
 *
 * Overloads (backward compatible with semanticRecovery callers):
 *   repeatedActionWithoutProgress(history, min?)
 *     — last `min` steps share one action and none progressed
 *   repeatedActionWithoutProgress(history, action, min?)
 *     — last `min` steps are specifically `action` with no progress
 *
 * @param {object[]} history
 * @param {string|number} [actionOrMin=2]
 * @param {number} [min]
 */
export function repeatedActionWithoutProgress(history, actionOrMin = 2, min) {
  if (!history?.length) return false;

  let action = null;
  let n = 2;
  if (typeof actionOrMin === "string") {
    action = actionOrMin;
    n = min ?? 2;
  } else {
    n = actionOrMin ?? 2;
  }

  if (history.length < n) return false;
  const recent = history.slice(-n);
  const expected = action ?? recent[0]?.action;
  if (!expected) return false;
  return recent.every((h) => h.action === expected && !h.progress);
}

/**
 * Decide stuck → smart_fill / upload_resume recovery plan (decision only).
 *
 * @param {{
 *   snap: object,
 *   history: object[],
 *   fillResult?: object|null,
 *   force?: boolean,
 *   requireUnfilledForSmartFill?: boolean,
 * }} opts
 * @returns {{ type: string, reason: string, source: string, step?: string }|null}
 */
export function runStuckFillRecovery({
  snap,
  history,
  fillResult = null,
  force = false,
  requireUnfilledForSmartFill = false,
} = {}) {
  if (!force && !isStuck(history, snap)) return null;

  if (uploadStalled(history)) {
    if (requireUnfilledForSmartFill && !hasUnfilledApplicationFields(snap, fillResult)) {
      return null;
    }
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
