import {
  looksLikeJobBoardIndex,
  boardLeaveSucceeded,
  shouldBlockBoardSignupAfterLeave,
  continueLoopStalled,
} from "../../heuristics.js";
import { looksLikeSignupEntry } from "../signupActions.js";
import {
  looksLikePlatformOnboarding,
  platformOnboardingIncomplete,
  looksLikeJobBoardWelcomeConfirm,
  welcomeConfirmCta,
  looksLikeDidYouApplyPrompt,
  didYouApplyDeclineCta,
  looksLikeBoardSignupOnboarding,
} from "../../platformOnboarding.js";

export function classifyJobBoardWelcome(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!looksLikeJobBoardWelcomeConfirm(snap)) return null;
  const top = welcomeConfirmCta(snap) || snap.continueCandidates?.[0] || snap.confirmCandidates?.[0];
  return {
    step: "continue",
    confidence: "high",
    reason: `job board welcome — ${top?.text || "Confirm & See Jobs"}`,
    target: top || null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyDidYouApply(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!looksLikeDidYouApplyPrompt(snap)) return null;
  const top = didYouApplyDeclineCta(snap) || snap.dismissCandidates?.[0];
  return {
    step: "continue",
    confidence: "high",
    reason: `did-you-apply tracker — choose "${top?.text || top?.aria || "Not yet"}"`,
    target: top || null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyJobBoardIndex(ctx) {
  const { snap, context, affordances, fingerprint: fp } = ctx;
  if (!looksLikeJobBoardIndex(snap)) return null;
  const title = String(context?.job?.title || context?.listingTitle || "").trim();
  const company = String(context?.job?.company || context?.company || "").trim();
  const label = title ? `"${title}"` : "matching role";
  const at = company ? ` at ${company}` : "";
  return {
    step: "entry",
    confidence: "high",
    reason: `job board index — pick listing for ${label}${at}`,
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyBoardSignupOnboarding(ctx) {
  const { snap, fillResult, history, affordances, fingerprint: fp } = ctx;
  // Board membership wizard (/onboard/) — not the employer job application.
  if (!looksLikeBoardSignupOnboarding(snap)) return null;
  const recoveryTries = (history || []).filter((h) => h.action === "nav_recovery").length;
  const continueLoops = continueLoopStalled(history, fillResult, 2);
  if (recoveryTries >= 1 || continueLoops || boardLeaveSucceeded(history)) {
    return {
      step: "blocked",
      confidence: "high",
      reason: "board signup/onboarding wizard — not the job application (manual handoff)",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }
  return {
    step: "nav_recovery",
    confidence: "high",
    reason: "board signup onboarding — leave wizard, return to job listing",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyBlockBoardSignupAfterLeave(ctx) {
  const { snap, history, affordances, fingerprint: fp } = ctx;
  // After leaving board onboard, never re-enter via Sign Up on the board listing.
  if (!(shouldBlockBoardSignupAfterLeave(history, snap) && (looksLikeSignupEntry(snap) || (snap.signUpCount || 0) > 0))) {
    return null;
  }
  if ((snap.entryCount || 0) > 0) {
    const top = snap.entryCandidates?.[0];
    return {
      step: "entry",
      confidence: "high",
      reason: `board leave done — skip Sign Up, prefer Apply: ${top?.text || "Apply"}`,
      target: top || null,
      affordances,
      fingerprint: fp,
    };
  }
  return {
    step: "blocked",
    confidence: "high",
    reason: "board leave done — Sign Up would re-enter onboard (handoff)",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyPlatformOnboarding(ctx) {
  const { snap, fillResult, filled, affordances, fingerprint: fp } = ctx;
  if (!looksLikePlatformOnboarding(snap)) return null;
  if (platformOnboardingIncomplete(snap, fillResult)) {
    const top = snap.continueCandidates?.[0];
    if (filled >= 1 && top) {
      return {
        step: "continue",
        confidence: "high",
        reason: `platform onboarding — ${top.text || "Next"}`,
        target: top,
        affordances,
        fingerprint: fp,
      };
    }
    return {
      step: "form",
      confidence: "high",
      reason: "platform onboarding — fill job function and preferences",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }
  const top = snap.continueCandidates?.[0];
  return {
    step: "continue",
    confidence: "high",
    reason: `platform onboarding — ${top?.text || "Next"}`,
    target: top || null,
    affordances,
    fingerprint: fp,
  };
}
