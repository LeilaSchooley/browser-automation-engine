/** Action-history loop / stall / preference helpers. */

import {
  isResumeChoiceStep,
  pageFingerprintFromSnap,
  snapSuggestsFileUpload,
} from "./common.js";
import {
  hasUnfilledApplicationFields,
  looksLikeInlineApplicationForm,
} from "./listingSurface.js";

/**
 * Same action repeating without progress — recovery breaker.
 * @param {object[]} history
 * @param {string} action
 * @param {number} [min=2]
 */
export function actionLoopStalled(history, action, min = 2) {
  const recent = (history || []).filter((h) => h.action === action).slice(-min);
  if (recent.length < min) return false;
  return recent.every((h) => !h.progress);
}

/** Dismiss Escape/upsell loop — prefer Apply / continue instead. */
export function dismissLoopStalled(history, min = 2) {
  return actionLoopStalled(history, "dismiss_overlay", min);
}

/**
 * click_continue / Next repeating without application fill progress.
 * Board wizards advance `?step=` so `progress` can be true — still treat filled===0 as looping.
 */
export function continueLoopStalled(history, fillResult = null, min = 3) {
  const continues = (history || []).filter((h) => h.action === "click_continue").slice(-min);
  if (continues.length < min) return false;
  const filled = fillResult?.filled?.length || 0;
  if (filled === 0) return true;
  return continues.every((h) => !h.progress);
}

/** Absolute count breaker — escalate after N attempts of the same action (ignores progress flag). */
export function actionAttemptLimit(history, action, max = 4) {
  return (history || []).filter((h) => h.action === action).length >= max;
}

/** True after a successful leave from board signup onboard (nav_recovery source). */
export function boardLeaveSucceeded(history) {
  return (history || []).some((h) => {
    if (h.action !== "nav_recovery") return false;
    const src = `${h.source || ""} ${h.reason || ""} ${h.recoveryAction || ""}`;
    return /leave_board_onboard|board.?signup/i.test(src);
  });
}

/** Block board Sign Up after we already left the onboard trap this run. */
export function shouldBlockBoardSignupAfterLeave(history, snap = null) {
  if (!boardLeaveSucceeded(history)) return false;
  const url = String(snap?.url || "");
  // Still allow real ATS registration
  if (/(lever\.co|greenhouse\.io|ashbyhq\.com|myworkdayjobs|workable\.com)/i.test(url)) return false;
  return true;
}

export function uploadAlreadySucceeded(history) {
  return (history || []).some((h) => h.action === "upload_resume" && h.ok);
}

/** Preferences gate signup CTA was clicked this session. */
export function preferencesSignupSubmitted(history = []) {
  return (history || []).some((h) => h.ok && h.preferencesSignup === true);
}

/** Signup CTA clicked within the last N history entries (page may still be transitioning). */
export function recentPreferencesSignup(history = [], within = 4) {
  return (history || []).slice(-within).some((h) => h.ok && h.preferencesSignup === true);
}

/** Listing apply CTA already succeeded on this page fingerprint (click_apply or learned entry act). */
export function applyEntrySucceeded(history = [], fingerprint = "") {
  return (history || []).some((h) => {
    if (!h.ok) return false;
    // No-progress clicks must not suppress further entry / Stagehand retries.
    if (h.progress === false) return false;
    if (fingerprint && h.fromFingerprint && h.fromFingerprint !== fingerprint) return false;
    if (h.action === "click_apply") return true;
    if (h.action === "act" && h.applyStep === "entry") return true;
    return false;
  });
}

export function countRecentAction(history, action, n = 3) {
  return (history || []).slice(-n).filter((h) => h.action === action).length;
}

/** Recent upload_resume attempts all failed — escape upload-only loop. */
export function uploadStalled(history, minFailures = 2) {
  if (uploadAlreadySucceeded(history)) return false;
  const attempts = (history || []).filter((h) => h.action === "upload_resume").slice(-4);
  if (attempts.length < minFailures) return false;
  return attempts.slice(-minFailures).every((h) => !h.ok);
}

export function shouldPreferUpload(snap, history, fillResult = null) {
  if (uploadAlreadySucceeded(history)) return false;
  if (uploadStalled(history)) return false;
  if (looksLikeInlineApplicationForm(snap) && hasUnfilledApplicationFields(snap, fillResult)) return false;
  if (isResumeChoiceStep(snap) && (snap?.fileInputCount || 0) === 0) return false;
  if ((snap?.fileInputCount || 0) > 0) return true;
  if (!snapSuggestsFileUpload(snap)) return false;

  const failedModalClicks = (history || []).filter((h) => h.action === "click_modal" && h.ok === false).length;
  const repeatedModal = countRecentAction(history, "click_modal", 2) >= 2;
  return failedModalClicks > 0 || repeatedModal || snapSuggestsFileUpload(snap);
}

export function isStuck(history, snap) {
  if (!history?.length || history.length < 3) return false;

  const fp = pageFingerprintFromSnap(snap);
  const recent = history.slice(-3);
  if (recent.every((h) => h.fingerprint === fp && !h.progress)) return true;

  const sameAction = recent[0]?.action;
  if (sameAction && recent.every((h) => h.action === sameAction) && !recent.some((h) => h.ok && h.progress)) {
    return true;
  }

  return false;
}
