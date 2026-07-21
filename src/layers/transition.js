/**
 * Transition contract — clicked ≠ advanced.
 * Progress is only credited when URL / step / form fingerprint actually changes.
 */

import { pageFingerprint } from "./formDiscovery.js";

/** Max unverified Apply CTA attempts on the same fingerprint before handoff. */
export const MAX_UNVERIFIED_APPLY_CTA = 2;

/** Max unverified Continue attempts on the same fingerprint before handoff. */
export const MAX_UNVERIFIED_CONTINUE = 3;

/**
 * Normalize URL to a step identity (path without trailing slash + onboarding step).
 * @param {string} url
 */
export function normalizeStepIdentity(url = "") {
  try {
    const u = new URL(String(url || ""), "https://example.com");
    const path = (u.pathname || "/").replace(/\/+$/, "") || "/";
    const step = path.match(/\/onboarding\/(step_\d+|[^/]+)/i);
    if (step) return `onboarding:${step[1].toLowerCase()}`;
    const app = path.match(/\/application\/([^/]+)/i);
    if (app) return `application:${app[1].toLowerCase()}`;
    return path.toLowerCase();
  } catch {
    return String(url || "").split("?")[0].replace(/\/+$/, "") || "/";
  }
}

/**
 * Compare before/after snaps for a real page advance.
 * @param {object|null} beforeSnap
 * @param {object|null} afterSnap
 * @returns {{ advanced: boolean, reason: string }}
 */
export function verifyAdvance(beforeSnap, afterSnap) {
  if (!beforeSnap || !afterSnap) {
    return { advanced: false, reason: "missing_snap" };
  }

  const beforeStep = normalizeStepIdentity(beforeSnap.url || "");
  const afterStep = normalizeStepIdentity(afterSnap.url || "");
  if (beforeStep && afterStep && beforeStep !== afterStep) {
    return { advanced: true, reason: "step_identity_changed" };
  }

  const beforeUrl = String(beforeSnap.url || "");
  const afterUrl = String(afterSnap.url || "");
  if (beforeUrl && afterUrl && beforeUrl !== afterUrl) {
    // Same step identity but query/hash change alone is weak — only count host/path change.
    try {
      const a = new URL(beforeUrl);
      const b = new URL(afterUrl);
      if (a.hostname !== b.hostname || normalizeStepIdentity(beforeUrl) !== normalizeStepIdentity(afterUrl)) {
        return { advanced: true, reason: "url_changed" };
      }
    } catch {
      return { advanced: true, reason: "url_changed" };
    }
  }

  const beforeKind = String(beforeSnap.pageKind || "");
  const afterKind = String(afterSnap.pageKind || "");
  if (beforeKind && afterKind && beforeKind !== afterKind) {
    // listing/content → form/auth is a real transition
    if (
      ["listing", "content", "unknown"].includes(beforeKind) &&
      ["form", "auth", "modal"].includes(afterKind)
    ) {
      return { advanced: true, reason: "page_kind_changed" };
    }
  }

  const beforeFields = Number(beforeSnap.fieldCount || 0);
  const afterFields = Number(afterSnap.fieldCount || 0);
  if (afterFields >= beforeFields + 2) {
    return { advanced: true, reason: "form_fields_appeared" };
  }

  const beforeFp = pageFingerprint(beforeSnap);
  const afterFp = pageFingerprint(afterSnap);
  if (beforeFp && afterFp && beforeFp !== afterFp) {
    // Fingerprint-only change with same URL/step is often noise (clock, ads).
    // Require also a field/entry/modal signal.
    const entryDelta = Math.abs(Number(afterSnap.entryCount || 0) - Number(beforeSnap.entryCount || 0));
    const modalAppeared = Boolean(afterSnap.hasApplyModal) && !beforeSnap.hasApplyModal;
    if (entryDelta > 0 || modalAppeared || afterFields > beforeFields) {
      return { advanced: true, reason: "fingerprint_and_surface_changed" };
    }
  }

  return { advanced: false, reason: "no_advance_detected" };
}

/**
 * Build a TransitionResult from a click attempt + before/after snaps.
 * @param {{
 *   clicked: boolean,
 *   before?: object|null,
 *   after?: object|null,
 *   reason?: string,
 *   handoff?: boolean,
 * }} opts
 */
export function toTransitionResult({
  clicked = false,
  before = null,
  after = null,
  reason = "",
  handoff = false,
} = {}) {
  if (!clicked) {
    return {
      clicked: false,
      advanced: false,
      stuck: false,
      handoff: Boolean(handoff),
      reason: reason || (handoff ? "handoff" : "not_clicked"),
      before: before || undefined,
      after: after || undefined,
    };
  }

  const verdict = verifyAdvance(before, after || before);
  const advanced = Boolean(verdict.advanced);
  return {
    clicked: true,
    advanced,
    stuck: !advanced,
    handoff: Boolean(handoff) || false,
    reason: reason || verdict.reason,
    before: before || undefined,
    after: after || undefined,
  };
}

/**
 * Count history entries that clicked but did not advance on this fingerprint.
 * @param {object[]} history
 * @param {string} fingerprint
 * @param {string} actionKey - e.g. "click_apply" | "click_continue"
 */
export function countUnverifiedAttempts(history, fingerprint, actionKey = "click_apply") {
  const fp = String(fingerprint || "");
  const key = String(actionKey || "");
  return (history || []).filter((h) => {
    if (fp && h.fingerprint && h.fingerprint !== fp) return false;
    const action = String(h.action || "");
    const matchesAction =
      action === key ||
      (key === "click_apply" && (h.applyCta || h.source === "apply-cta")) ||
      (key === "click_continue" && /continue|click_continue/i.test(action));
    if (!matchesAction) return false;
    // Unverified = clicked (or claimed ok) but no progress
    if (h.advanced === false || (h.clicked && !h.progress) || (h.ok && h.stuck) || h.stuckAdvance) {
      return true;
    }
    if (h.progress === false && (h.clicked || h.ok)) return true;
    return false;
  }).length;
}
