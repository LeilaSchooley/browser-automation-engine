import {
  findBestDismissCandidate,
  isJobAlertInterstitial,
  looksLikeMarketingYesNoModal,
  looksLikeJobAlertSignupForm,
} from "../../heuristics.js";
import { isNonCookiePopup } from "../../consentDetection.js";

// Auth account helpers live in authFlowPolicy (shared with catalog); re-export for classify/*.
export {
  loginFailedTwice,
  shouldPreferSignupForAccount,
  getAuthFromContext,
  ensureAccount,
} from "../authFlowPolicy.js";

export function modalChoiceConfidence(snap) {
  const top = snap.modalCandidates?.[0];
  const second = snap.modalCandidates?.[1];
  if (!top) return "low";
  if (second && Math.abs((top.score || 0) - (second.score || 0)) < 25) return "low";
  if (snap.entryCount > 0 && snap.pageKind === "listing") return "low";
  return "high";
}

export function hasCompetingAffordances(snap) {
  let count = 0;
  if (snap.hasBlockingOverlay) count += 1;
  if (snap.cookieBanner && !snap.hasApplyModal) count += 1;
  if (snap.hasApplyModal && snap.modalStepCount > 0) count += 1;
  if (snap.entryCount > 0 && !snap.hasApplyModal) count += 1;
  if ((snap.fieldCount || 0) >= 2) count += 1;
  if (snap.continueCount > 0) count += 1;
  return count >= 2;
}

export function classifyJobAlertDismiss(snap, affordances, fp, reasonPrefix = "non-cookie popup") {
  const top = findBestDismissCandidate(snap) || snap.dismissCandidates?.[0];
  return {
    step: "overlay",
    confidence: "high",
    reason: top
      ? `${reasonPrefix} — dismiss "${top.text || top.aria || top._text || "close"}"`
      : `${reasonPrefix} blocking apply — dismiss first`,
    target: top || null,
    affordances,
    fingerprint: fp,
  };
}

export function shouldDismissJobAlertFirst(snap, context = null) {
  if (
    looksLikeMarketingYesNoModal(snap) ||
    isNonCookiePopup(snap) ||
    isJobAlertInterstitial(snap)
  ) {
    return true;
  }

  const hasModalSurface = (snap?.modalCount || 0) > 0 || snap?.hasBlockingOverlay;
  if (hasModalSurface && looksLikeJobAlertSignupForm(snap)) {
    return true;
  }

  const learnings = context?.siteLearnings || {};
  if (learnings.dismissFirst || learnings.avoidFillWhenAlert) {
    if ((snap?.modalCount || 0) > 0 || snap?.hasBlockingOverlay) {
      return true;
    }
    const blob = `${snap?.pageText || ""} ${snap?.title || ""} ${snap?.applyModalTitle || ""}`.toLowerCase();
    if (/job alert|new vacancies|subscribe|time for a new job/i.test(blob)) {
      return true;
    }
  }
  return false;
}
