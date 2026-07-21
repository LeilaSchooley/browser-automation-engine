/**
 * Progress scoring, hallucinated-done filter, and ready-for-review criteria.
 * Behavior-identical extract from automationAgent.
 */
import {
  looksLikeApplyForm,
  progressScore,
} from "../formDiscovery.js";
import {
  uploadAlreadySucceeded,
  looksLikeApplySignupGate,
} from "../../heuristics.js";
import { looksLikePlatformOnboarding } from "../../platformOnboarding.js";
import { looksLikeProfileSetup } from "../../patterns/profileSetup.js";
import { hasUnfilledApplicationControls } from "../../fillApplicationAnswers.js";
import { looksLikeSignupForm } from "../signupActions.js";
import { assessCompletenessFromSnap } from "../CompletenessOracle.js";
import { isStepComplete } from "../steppedForm.js";

/** Score current page + track best seen this run. */
export function scoreStepProgress(snap, fillResult, bestScore = 0) {
  const score = progressScore(snap, fillResult);
  return {
    score,
    bestScore: score > bestScore ? score : bestScore,
  };
}

/**
 * "done" must be earned: classifier review, or filled fields on an apply form.
 * AI saying "done" on an untouched listing is a hallucination — clear the plan.
 * @returns {object|null} plan (unchanged or cleared)
 */
export function filterHallucinatedDone(plan, classification, fillResult, snap) {
  if (plan?.type !== "done") return plan;
  const filledCount = fillResult?.filled?.length || 0;
  const earned =
    classification?.step === "review" || (filledCount >= 1 && looksLikeApplyForm(snap, 1));
  if (!earned) return null;
  return plan;
}

/** Whether a done plan is earned (same criteria as filterHallucinatedDone). */
export function isDoneEarned(classification, fillResult, snap) {
  const filledCount = fillResult?.filled?.length || 0;
  return (
    classification?.step === "review" || (filledCount >= 1 && looksLikeApplyForm(snap, 1))
  );
}

/**
 * Mechanical progress after an action (fingerprint / score / perception diff).
 */
export function computeMechanicalProgress({
  snapAfter,
  fpBefore,
  fillResult,
  score,
  perceptionDiff = null,
  pageFingerprint,
}) {
  return (
    pageFingerprint(snapAfter) !== fpBefore ||
    progressScore(snapAfter, fillResult) > score ||
    Boolean(
      perceptionDiff?.changed &&
        (perceptionDiff.addedRefs || 0) + (perceptionDiff.removedRefs || 0) >= 2,
    )
  );
}

/** Mid-wizard WaaS profile steps still need Continue — never hand off for review yet. */
function stillInWaasProfileWizard(snap) {
  const url = String(snap?.url || "");
  if (!/\/application\/(skills|role|experience|location|career|personal|founders|equity)\b/i.test(url)) {
    return false;
  }
  const continueEnabled =
    (snap?.continueCount || 0) > 0 && !snap?.continueCandidates?.[0]?.disabled;
  if (!continueEnabled) return false;
  // If the current wizard step is incomplete, definitely keep going.
  if (!isStepComplete(snap)) return true;
  // Complete step with Continue visible → agent should click Continue, not hand off.
  return true;
}

/** Text filled but file inputs untouched → keep going for upload. */
export function uploadsStillPending(snapAfter, history, fillResult) {
  return (
    (snapAfter.fileInputCount || 0) > 0 &&
    !uploadAlreadySucceeded(history) &&
    !(fillResult.filled || []).some((f) => f.uploaded || f.file)
  );
}

/**
 * Ready-for-review / objective-done criteria used after smart_fill.
 * @returns {{
 *   filledCount: number,
 *   authSucceeded: boolean,
 *   uploadsPending: boolean,
 *   appControlsPending: boolean,
 *   onPlatformSignupGate: boolean,
 *   onPlatformOnboarding: boolean,
 *   readyForReview: boolean,
 * }}
 */
export function evaluateReadyForReview({
  snapAfter,
  fillResult,
  history,
  progressed = false,
  ok = false,
} = {}) {
  const filledCount = fillResult.filled?.length || 0;
  const authSucceeded = history.some(
    (h) => (h.action === "auth_login" || h.action === "auth_signup") && h.ok,
  );
  const uploadsPending = uploadsStillPending(snapAfter, history, fillResult);
  const appControlsPending = hasUnfilledApplicationControls(snapAfter);
  const onPlatformSignupGate =
    looksLikeApplySignupGate(snapAfter) || looksLikeSignupForm(snapAfter) || snapAfter.signupForm;
  const onPlatformOnboarding = looksLikePlatformOnboarding(snapAfter);
  const midWaasWizard = stillInWaasProfileWizard(snapAfter);
  const midProfileSetup =
    looksLikeProfileSetup(snapAfter) || /\/onboarding\//i.test(String(snapAfter?.url || ""));
  const oracle = assessCompletenessFromSnap(snapAfter, fillResult);
  // Oracle SSOT: fill-count / progressed heuristics alone never declare ready-for-review.
  const readyForReview =
    !uploadsPending &&
    !appControlsPending &&
    !onPlatformOnboarding &&
    !midWaasWizard &&
    !midProfileSetup &&
    !(onPlatformSignupGate && !authSucceeded) &&
    oracle.complete &&
    ((filledCount >= 2 && looksLikeApplyForm(snapAfter, 2)) ||
      (filledCount >= 1 && authSucceeded && looksLikeApplyForm(snapAfter, 1)));

  return {
    filledCount,
    authSucceeded,
    uploadsPending,
    appControlsPending,
    onPlatformSignupGate,
    onPlatformOnboarding,
    midProfileSetup,
    oracleComplete: oracle.complete,
    oracleReason: oracle.reason,
    readyForReview,
  };
}
