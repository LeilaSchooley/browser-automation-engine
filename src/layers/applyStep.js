/**
 * Affordance-driven apply step classification — reads current page state, not action history.
 */
import { looksLikeApplyForm } from "./formDiscovery.js";
import { isPageUnloaded } from "./pageReady.js";
import {
  isResumeChoiceStep,
  pageFingerprintFromSnap,
  shouldPreferUpload,
  uploadAlreadySucceeded,
} from "../heuristics.js";

const BLOCKED_TEXT =
  /\b(sign in to apply|log in to apply|login required|create an account to apply|captcha|verify you are human|payment required|subscribe to apply)\b/i;

/** Maps step type → default agent action. */
export const STEP_ACTIONS = {
  loading: "wait_load",
  consent: "accept_cookies",
  entry: "click_apply",
  wizard_choice: "click_modal",
  upload: "upload_resume",
  form: "smart_fill",
  continue: "click_continue",
  review: "done",
  blocked: "wait_user",
  ambiguous: null,
};

export function applyAffordances(snap) {
  if (!snap) return {};
  return {
    pageKind: snap.pageKind,
    fieldCount: snap.fieldCount || 0,
    fileInputCount: snap.fileInputCount || 0,
    entryCount: snap.entryCount || 0,
    modalStepCount: snap.modalStepCount || 0,
    hasApplyModal: !!snap.hasApplyModal,
    cookieBanner: !!snap.cookieBanner,
    continueCount: snap.continueCount || 0,
    submitCount: snap.submitCount || 0,
    applyModalTitle: snap.applyModalTitle || "",
    topEntry: snap.entryCandidates?.[0]?.text || "",
    topModal: snap.modalCandidates?.[0]?.text || "",
    topContinue: snap.continueCandidates?.[0]?.text || "",
  };
}

function modalChoiceConfidence(snap) {
  const top = snap.modalCandidates?.[0];
  const second = snap.modalCandidates?.[1];
  if (!top) return "low";
  if (second && Math.abs((top.score || 0) - (second.score || 0)) < 25) return "low";
  if (snap.entryCount > 0 && snap.pageKind === "listing") return "low";
  return "high";
}

function hasCompetingAffordances(snap) {
  let count = 0;
  if (snap.cookieBanner && !snap.hasApplyModal) count += 1;
  if (snap.hasApplyModal && snap.modalStepCount > 0) count += 1;
  if (snap.entryCount > 0 && !snap.hasApplyModal) count += 1;
  if ((snap.fieldCount || 0) >= 2) count += 1;
  if (snap.continueCount > 0) count += 1;
  return count >= 2;
}

/**
 * Classify the current apply surface from a DOM snapshot.
 * @returns {{ step: string, confidence: "high"|"low", reason: string, target?: object|null, affordances: object }}
 */
export function classifyApplyStep(snap, fillResult, history = []) {
  const filled = fillResult?.filled?.length || 0;
  const affordances = applyAffordances(snap);
  const fp = pageFingerprintFromSnap(snap);

  const blockedBlob = `${snap?.title || ""} ${snap?.applyModalTitle || ""} ${snap?.url || ""}`.toLowerCase();
  if (BLOCKED_TEXT.test(blockedBlob) && (snap?.fieldCount || 0) < 2 && filled === 0) {
    return {
      step: "blocked",
      confidence: "high",
      reason: "login, captcha, or payment wall detected",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  if (isPageUnloaded(snap)) {
    return {
      step: "loading",
      confidence: "high",
      reason: "page still loading — no affordances yet",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  if (filled >= 2 && looksLikeApplyForm(snap, 2)) {
    return {
      step: "review",
      confidence: "high",
      reason: `${filled} field(s) filled — ready for manual review`,
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  if (snap.cookieBanner && !snap.hasApplyModal) {
    return {
      step: "consent",
      confidence: "high",
      reason: "cookie banner visible (no apply modal blocking)",
      target: snap.cookieCandidates?.[0] || null,
      affordances,
      fingerprint: fp,
    };
  }

  if (snap.hasApplyModal && (snap.modalStepCount || 0) > 0) {
    const top = snap.modalCandidates?.[0];

    if (isResumeChoiceStep(snap) && (snap.fieldCount || 0) === 0) {
      return {
        step: "wizard_choice",
        confidence: modalChoiceConfidence(snap),
        reason: `wizard choice: "${top?.text || snap.applyModalTitle || "next step"}"`,
        target: top || null,
        affordances,
        fingerprint: fp,
      };
    }

    if (
      shouldPreferUpload(snap, history) &&
      !uploadAlreadySucceeded(history) &&
      !isResumeChoiceStep(snap)
    ) {
      return {
        step: "upload",
        confidence: "high",
        reason: snap.fileInputCount
          ? `${snap.fileInputCount} file input(s) ready for resume`
          : "upload UI detected in apply modal",
        target: snap.fileInputCandidates?.[0] || top || null,
        affordances,
        fingerprint: fp,
      };
    }

    if ((snap.fieldCount || 0) === 0) {
      return {
        step: "wizard_choice",
        confidence: modalChoiceConfidence(snap),
        reason: `apply modal step: "${top?.text || snap.applyModalTitle || "continue"}"`,
        target: top || null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  if (!snap.hasApplyModal && snap.entryCount > 0 && (snap.pageKind === "listing" || snap.pageKind === "content")) {
    const applySucceeded = history.some((h) => h.action === "click_apply" && h.ok);
    if (!applySucceeded) {
      const top = snap.entryCandidates?.[0];
      return {
        step: "entry",
        confidence: hasCompetingAffordances(snap) ? "low" : "high",
        reason: `listing CTA: "${top?.text || "Apply"}" (score=${top?.score ?? "?"})`,
        target: top || null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  if ((snap.fieldCount || 0) >= 1) {
    const unfilled = fillResult?.unfilled_count ?? snap.fieldCount;
    if (unfilled > 0 || filled === 0) {
      return {
        step: "form",
        confidence: "high",
        reason: `${snap.fieldCount} field(s) visible, ${filled} filled`,
        target: null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  if (uploadAlreadySucceeded(history) && (snap.fieldCount || 0) === 0) {
    return {
      step: "loading",
      confidence: "high",
      reason: "resume uploaded — waiting for form fields to appear",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  if (snap.continueCount > 0) {
    const top = snap.continueCandidates?.[0];
    if ((top?.text || "").length <= 80) {
      return {
        step: "continue",
        confidence: hasCompetingAffordances(snap) ? "low" : "high",
        reason: `continue control: "${top?.text || "Next"}"`,
        target: top || null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  if (snap.submitCount > 0 && filled >= 2) {
    return {
      step: "review",
      confidence: "high",
      reason: "submit visible after fill — stopping for manual review",
      target: snap.submitCandidates?.[0] || null,
      affordances,
      fingerprint: fp,
    };
  }

  if (hasCompetingAffordances(snap)) {
    return {
      step: "ambiguous",
      confidence: "low",
      reason: "multiple competing affordances on page",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  return {
    step: "ambiguous",
    confidence: "low",
    reason: "no clear apply step detected",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function actionFailedTwiceOnFingerprint(history, action, fingerprint) {
  if (!history?.length) return false;
  const recent = history.slice(-4).filter((h) => h.action === action && h.fingerprint === fingerprint);
  return recent.length >= 2 && recent.every((h) => !h.ok || !h.progress);
}

/**
 * Map classified step → executable plan (affordance-first, no lastAction branching).
 */
export function stepToPlan(classification, snap, history) {
  const { step, confidence, reason, target } = classification;
  const fp = classification.fingerprint || pageFingerprintFromSnap(snap);
  const action = STEP_ACTIONS[step];

  if (!action) return null;

  if (actionFailedTwiceOnFingerprint(history, action, fp)) {
    return null;
  }

  if (step === "form" && (snap.fieldCount || 0) === 0) {
    return null;
  }

  return {
    type: action,
    reason,
    target: target?.testId || target?.selector || target?.text || "",
    targetCandidate: target || null,
    confidence,
    step,
    source: "step-classifier",
  };
}
