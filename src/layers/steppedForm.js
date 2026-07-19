/**
 * Multi-step / wizard form helpers — fill current step, advance, re-scan, fill again.
 * Does NOT blindly click every Next on the page (that breaks ATS traps).
 */
import { hasUnfilledApplicationFields } from "../heuristics.js";
import { looksLikeBoardSignupOnboarding } from "../platformOnboarding.js";

/**
 * Stable-ish signature of the *current* wizard panel (fields + controls + continue CTA).
 * @param {object} snap
 */
export function stepSignature(snap) {
  if (!snap) return "";
  const fields = (snap.fields || [])
    .slice(0, 16)
    .map((f) => `${f.type || ""}:${String(f.label || "").slice(0, 32)}:${f.filled ? 1 : 0}`)
    .join("|");
  const ctrls = (snap.customControls || [])
    .slice(0, 12)
    .map((c) => `${c.widgetType || c.type || ""}:${String(c.label || "").slice(0, 32)}:${c.filled ? 1 : 0}`)
    .join("|");
  const cont = String(snap.continueCandidates?.[0]?.text || "").slice(0, 40);
  const path = (() => {
    try {
      return new URL(String(snap.url || "")).pathname;
    } catch {
      return String(snap.url || "").slice(0, 80);
    }
  })();
  return `${path}#${fields}#${ctrls}#${cont}`;
}

/** True when the visible step still has unfilled text/custom controls. */
export function currentStepIncomplete(snap, fillResult = null) {
  if (!snap) return false;
  if (looksLikeBoardSignupOnboarding(snap)) return false;
  if (hasUnfilledApplicationFields(snap, fillResult)) return true;
  const unfilledFields = (snap.fields || []).filter(
    (f) => !f.filled && !/hidden|submit|button|file/i.test(String(f.type || "")),
  ).length;
  const unfilledCtrl = (snap.customControls || []).filter((c) => !c.filled).length;
  return unfilledFields + unfilledCtrl > 0;
}

/**
 * After a successful fill of the current step, Continue/Next is safe to prefer.
 * @param {object} snap
 * @param {object} [fillResult]
 */
export function shouldAutoAdvance(snap, fillResult = null) {
  if (!snap) return false;
  if (looksLikeBoardSignupOnboarding(snap)) return false;
  if ((snap.continueCount || 0) < 1 && (snap.modalStepCount || 0) < 1) return false;
  if (currentStepIncomplete(snap, fillResult)) return false;
  const filled = fillResult?.filled?.length || 0;
  // Need some fill evidence OR all visible fields already marked filled.
  const allMarkedFilled =
    (snap.fields || []).length > 0 &&
    (snap.fields || []).every((f) => f.filled || /hidden|submit|button|file/i.test(String(f.type || "")));
  return filled >= 1 || allMarkedFilled;
}

/**
 * After Continue/Next, if a new step appeared with empty fields → force smart_fill.
 * @param {object} before
 * @param {object} after
 * @param {object} [fillResult]
 */
export function planAfterContinue(before, after, fillResult = null) {
  if (!after || looksLikeBoardSignupOnboarding(after)) return null;
  const beforeSig = stepSignature(before);
  const afterSig = stepSignature(after);
  const sigChanged = beforeSig !== afterSig;
  const fieldsGrew =
    (after.fieldCount || 0) > (before?.fieldCount || 0) ||
    (after.customControls || []).filter((c) => !c.filled).length >
      (before?.customControls || []).filter((c) => !c.filled).length;
  const newUnfilled = currentStepIncomplete(after, fillResult);
  if ((sigChanged || fieldsGrew) && newUnfilled) {
    return {
      type: "smart_fill",
      reason: "stepped form — new step appeared after Continue; fill before advancing again",
      source: "stepped-form",
      score: 97,
    };
  }
  return null;
}

/**
 * Looks like a multi-step flow (continue CTA + form surface).
 * @param {object} snap
 */
export function looksLikeSteppedForm(snap) {
  if (!snap) return false;
  if (looksLikeBoardSignupOnboarding(snap)) return false;
  const hasContinue = (snap.continueCount || 0) > 0 || (snap.modalStepCount || 0) > 0;
  const hasFields = (snap.fieldCount || 0) >= 1 || (snap.customControls || []).length >= 1;
  return hasContinue && hasFields;
}
