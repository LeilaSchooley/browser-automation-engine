/**
 * Action-driven catalog — all plausible next moves from a page snapshot.
 * Replaces rigid step-type branching as the primary decision input.
 */
import { isPageUnloaded } from "./pageReady.js";
import { looksLikeAuthForm } from "./authActions.js";
import { looksLikeSignupForm, looksLikeSignupEntry } from "./signupActions.js";
import {
  resolveAuthPreference,
  shouldEnterOtp,
} from "./authFlowPolicy.js";
import { hasPreferencesGateFields, preferencesGateIncomplete } from "../fillPreferences.js";
import { hasIdentityRegistrationFields } from "../fillProfile.js";
import { shouldNeverDismiss } from "../workflowGates.js";
import { looksLikeRealCookieConsent } from "../consentDetection.js";
import {
  applyEntrySucceeded,
  countRecentAction,
  hasUnfilledApplicationFields,
  isExpertReviewGate,
  isResumeReviewUpsell,
  looksLikeGoogleVignetteAd,
  looksLikeInlineApplicationForm,
  looksLikeJobBoardIndex,
  dismissLoopStalled,
  continueLoopStalled,
  shouldPreferUpload,
  uploadAlreadySucceeded,
  uploadStalled,
  shouldBlockBoardSignupAfterLeave,
} from "../heuristics.js";
import {
  looksLikePlatformOnboarding,
  looksLikeBoardSignupOnboarding,
  looksLikeJobBoardWelcomeConfirm,
  welcomeConfirmCta,
  looksLikeDidYouApplyPrompt,
  didYouApplyDeclineCta,
} from "../platformOnboarding.js";
import { findRelevantSkills } from "../siteLearnings.js";
import { buildStagehandInstruction } from "./stagehandPolicy.js";
import { canUseStagehand } from "./stagehandAdapter.js";
import { isOauthProviderHost, looksLikeDeadApplyDestination } from "./applyUrlSafety.js";
import { rankEntryCandidates } from "./pageIntent.js";
import { currentStepIncomplete, looksLikeSteppedForm, shouldAutoAdvance } from "./steppedForm.js";

/**
 * @typedef {{ id: string, type: string, score: number, reason: string, targetCandidate?: object, instruction?: string, step?: string }} CatalogAction
 */

/**
 * @param {object} snap
 * @param {object} fillResult
 * @param {object[]} history
 * @param {object} context
 * @param {object} [classification]
 * @returns {CatalogAction[]}
 */
export function buildActionCatalog(snap, fillResult, history = [], context = {}, classification = null) {
  if (!snap || isPageUnloaded(snap)) {
    return [{ id: "wait_load", type: "wait_load", score: 100, reason: "page loading" }];
  }

  const actions = [];
  const filled = fillResult?.filled?.length || 0;
  const fp = classification?.fingerprint || "";
  const oauthProvider = isOauthProviderHost(snap.url || snap.hostname || "");
  const rankedEntries = rankEntryCandidates(snap.entryCandidates || [], context);

  if (classification?.step === "blocked" || classification?.hardStop) {
    return [{ id: "wait_user", type: "wait_user", score: 100, reason: classification?.reason || "blocked" }];
  }

  if (classification?.step === "enter_otp" || shouldEnterOtp(snap, history, context)) {
    return [
      {
        id: "enter_otp",
        type: "enter_otp",
        score: 98,
        reason: classification?.reason || "enter verification code",
        step: "enter_otp",
      },
    ];
  }

  if (snap.cookieBanner && looksLikeRealCookieConsent(snap)) {
    actions.push({
      id: "accept_cookies",
      type: "accept_cookies",
      score: 92,
      reason: "accept cookie consent",
      step: "consent",
    });
  }

  if (snap.hasBlockingOverlay && !shouldNeverDismiss(snap)) {
    const top = snap.dismissCandidates?.[0];
    if (top) {
      actions.push({
        id: "dismiss_overlay",
        type: "dismiss_overlay",
        score: top.score || 75,
        reason: `dismiss overlay — ${top.text || "close"}`,
        targetCandidate: top,
        step: "overlay",
      });
    }
  }

  if (
    !shouldNeverDismiss(snap) &&
    (classification?.step === "overlay" ||
      isResumeReviewUpsell(snap) ||
      isExpertReviewGate(snap) ||
      looksLikeGoogleVignetteAd(snap))
  ) {
    const looping = dismissLoopStalled(history, 2);
    const top = classification?.target || snap.dismissCandidates?.[0];
    // After failed dismisses, demote Escape path so Apply wins.
    if (!looping || top) {
      actions.push({
        id: "dismiss_resume_upsell",
        type: "dismiss_overlay",
        score: looping ? 40 : 96,
        reason: looksLikeGoogleVignetteAd(snap)
          ? "dismiss google vignette ad"
          : top
            ? `dismiss resume upsell — ${top.text || top._text || top.aria || "close"}`
            : "dismiss resume boost / review upsell",
        targetCandidate: top || null,
        step: "overlay",
      });
    }
  }

  if (looksLikeJobBoardIndex(snap) && canUseStagehand(context).ok) {
    actions.push({
      id: "stagehand_job_board",
      type: "stagehand_act",
      score: 95,
      reason: "navigate job board — pick matching listing",
      instruction: buildStagehandInstruction(snap, classification || { step: "entry" }, history, context),
      step: "entry",
      mappedTo: "board_nav",
    });
    for (const c of rankedEntries.slice(0, 2)) {
      actions.push({
        id: `click_apply_${c.text || "entry"}`,
        type: "click_apply",
        score: (c.score || 50) - 10,
        reason: `listing CTA: ${c.text || "Apply"}`,
        targetCandidate: c,
        step: "entry",
      });
    }
  } else if ((rankedEntries.length || snap.entryCount || 0) > 0 && !applyEntrySucceeded(history, fp)) {
    const top = rankedEntries[0] || snap.entryCandidates?.[0];
    const loopingDismiss = dismissLoopStalled(history, 2);
    actions.push({
      id: "click_apply",
      type: "click_apply",
      score: loopingDismiss ? 98 : top?.score || 70,
      reason: loopingDismiss
        ? `dismiss loop — force apply CTA: ${top?.text || "Apply"}`
        : `apply CTA: ${top?.text || "Apply"}`,
      targetCandidate: top || null,
      step: "entry",
    });
  }

  const authPref = resolveAuthPreference(snap, history, context);
  const preferSignup =
    authPref.prefer === "signup" ||
    classification?.step === "signup_entry" ||
    classification?.step === "signup";
  const preferSignin =
    (!preferSignup && (authPref.prefer === "signin" || authPref.prefer === "auth")) ||
    classification?.step === "signin_entry" ||
    (classification?.step === "auth" && !preferSignup);

  if (looksLikeAuthForm(snap) && !isOauthProviderHost(snap.url || snap.hostname || "")) {
    const loginScore = preferSignin ? 92 : preferSignup ? 70 : 88;
    actions.push({
      id: "auth_login",
      type: "auth_login",
      score: loginScore,
      reason: preferSignup ? "auth login form (signup preferred)" : "auth login form",
      step: "auth",
    });
  }
  if (
    (looksLikeSignupForm(snap) || hasIdentityRegistrationFields(snap)) &&
    !isOauthProviderHost(snap.url || snap.hostname || "")
  ) {
    const signupScore = preferSignup ? 92 : preferSignin ? 70 : 86;
    actions.push({
      id: "auth_signup",
      type: "auth_signup",
      score: signupScore,
      reason: preferSignup ? "registration form — signup preferred" : "registration form",
      step: "signup",
    });
    actions.push({
      id: "smart_fill_signup",
      type: "smart_fill",
      score: preferSignup ? 90 : 84,
      reason: "fill registration fields",
      step: "signup",
    });
  }
  if (
    (looksLikeSignupEntry(snap) || classification?.step === "signup_entry" || authPref.step === "signup_entry") &&
    !oauthProvider &&
    !shouldBlockBoardSignupAfterLeave(history, snap) &&
    (preferSignup || classification?.step === "signup_entry" || authPref.step === "signup_entry" || !preferSignin)
  ) {
    const signupScore =
      classification?.step === "signup_entry" || authPref.step === "signup_entry" ? 96 : preferSignup ? 80 : 72;
    actions.push({
      id: "click_signup",
      type: "click_signup",
      score: signupScore,
      reason:
        classification?.step === "signup_entry" || authPref.step === "signup_entry"
          ? "classified signup entry — Create an account"
          : "signup entry CTA",
      targetCandidate: snap.signUpCandidates?.[0] || null,
      step: "signup_entry",
    });
  } else if (shouldBlockBoardSignupAfterLeave(history, snap)) {
    actions.push({
      id: "skip_board_signup",
      type: "wait_user",
      score: 96,
      reason: "board leave done — skip Sign Up (would re-enter onboard)",
      step: "blocked",
    });
    if ((snap.entryCount || 0) > 0) {
      const top = snap.entryCandidates?.[0];
      actions.push({
        id: "click_apply_after_board_leave",
        type: "click_apply",
        score: 97,
        reason: `after board leave — Apply: ${top?.text || "Apply"}`,
        targetCandidate: top || null,
        step: "entry",
      });
    }
  }
  if (
    !oauthProvider &&
    classification?.step !== "signup_entry" &&
    authPref.step !== "signup_entry" &&
    !preferSignup &&
    (classification?.step === "signin_entry" ||
      authPref.step === "signin_entry" ||
      ((snap.signInCount || 0) > 0 && (classification?.step === "auth" || authPref.prefer === "auth")))
  ) {
    // Password form already open — catalog auth_login, don't keep offering click_signin.
    if (looksLikeAuthForm(snap) || (snap.passwordFieldCount || 0) > 0) {
      if (!actions.some((a) => a.type === "auth_login")) {
        actions.push({
          id: "auth_login_from_signin",
          type: "auth_login",
          score: classification?.step === "signin_entry" || authPref.step === "signin_entry" ? 96 : 88,
          reason: "login form already open — fill credentials",
          step: "auth",
        });
      }
    } else {
      const signInTarget = (snap.signInCandidates || []).find(
        (c) => !/magic link|email me a (code|link)|send (me )?(a )?code/i.test(String(c.text || "")),
      );
      actions.push({
        id: "click_signin",
        type: "click_signin",
        score: classification?.step === "signin_entry" || authPref.step === "signin_entry" ? 95 : 74,
        reason: "open sign in for saved site account",
        targetCandidate: signInTarget || null,
        step: "signin_entry",
      });
    }
  }

  if (looksLikeJobBoardWelcomeConfirm(snap)) {
    const top = welcomeConfirmCta(snap) || snap.continueCandidates?.[0];
    actions.push({
      id: "click_welcome_confirm",
      type: "click_continue",
      score: 98,
      reason: `welcome confirm — ${top?.text || "Confirm & See Jobs"}`,
      targetCandidate: top || null,
      step: "continue",
    });
  }

  if (looksLikeDidYouApplyPrompt(snap)) {
    const top = didYouApplyDeclineCta(snap);
    actions.push({
      id: "click_did_you_apply_no",
      type: "click_continue",
      score: 97,
      reason: `did-you-apply — ${top?.text || top?.aria || "Not yet"}`,
      targetCandidate: top || null,
      step: "continue",
    });
  }

  if (looksLikeBoardSignupOnboarding(snap)) {
    const recoveryTries = (history || []).filter((h) => h.action === "nav_recovery").length;
    if (recoveryTries >= 1 || continueLoopStalled(history, fillResult, 2)) {
      actions.push({
        id: "board_onboard_handoff",
        type: "wait_user",
        score: 99,
        reason: "board signup onboarding — not job application (handoff)",
        step: "blocked",
      });
    } else {
      actions.push({
        id: "leave_board_onboard",
        type: "nav_recovery",
        score: 99,
        reason: "board signup onboarding — return to job listing",
        step: "nav_recovery",
      });
    }
  } else if (looksLikePlatformOnboarding(snap)) {
    actions.push({
      id: "smart_fill_onboarding",
      type: "smart_fill",
      score: 92,
      reason: "platform onboarding — fill job function",
      step: "form",
    });
    const next = snap.continueCandidates?.[0];
    if (next) {
      actions.push({
        id: "click_onboarding_next",
        type: "click_continue",
        score: filled >= 1 ? 94 : 70,
        reason: `onboarding — ${next.text || "Next"}`,
        targetCandidate: next,
        step: "continue",
      });
    }
  }

  if (hasPreferencesGateFields(snap) && preferencesGateIncomplete(snap, fillResult)) {
    actions.push({
      id: "smart_fill_prefs",
      type: "smart_fill",
      score: 90,
      reason: "preferences gate — fill salary/location/title",
      step: "form",
    });
  }

  const inlineForm = looksLikeInlineApplicationForm(snap);
  const unfilledFields = hasUnfilledApplicationFields(snap, fillResult);
  const unfilledYesNo = (snap.customControls || []).some((c) => !c.filled && c.widgetType === "yesno");
  const uploadFailed = uploadStalled(history);

  if (unfilledFields || unfilledYesNo || (snap.fieldCount || 0) >= 2) {
    if (!(isResumeReviewUpsell(snap) || isExpertReviewGate(snap) || classification?.step === "overlay")) {
      let fillScore = 72;
      if (inlineForm) fillScore += 20;
      if (uploadFailed) fillScore += 25;
      if (unfilledYesNo) fillScore += 15;
      if (filled === 0) fillScore += 10;
      // Multi-step ATS: keep filling the current panel before Continue can win.
      if (looksLikeSteppedForm(snap) && currentStepIncomplete(snap, fillResult)) fillScore += 22;
      actions.push({
        id: "smart_fill",
        type: "smart_fill",
        score: fillScore,
        reason: inlineForm ? "fill inline application fields" : "fill visible form fields",
        step: "form",
      });
    }
  }

  if ((snap.fileInputCount || 0) > 0 && !uploadAlreadySucceeded(history)) {
    let uploadScore = 60;
    if (shouldPreferUpload(snap, history, fillResult)) uploadScore += 25;
    if (inlineForm && unfilledFields) uploadScore -= 30;
    if (uploadFailed) uploadScore -= 45;
    if (uploadScore > 25) {
      actions.push({
        id: "upload_resume",
        type: "upload_resume",
        score: uploadScore,
        reason: "attach resume to file input",
        step: "upload",
      });
    }
  }

  if (uploadFailed && canUseStagehand(context).ok && (snap.fileInputCount || 0) > 0) {
    actions.push({
      id: "stagehand_upload_fill",
      type: "stagehand_act",
      score: 82,
      reason: "upload stalled — semantic resume upload + fill",
      instruction: buildStagehandInstruction(snap, classification || { step: "form" }, history, context),
      step: "form",
    });
  }

  if ((snap.modalStepCount || 0) > 0 && snap.hasApplyModal && !inlineForm) {
    const top = snap.modalCandidates?.[0];
    if (top) {
      actions.push({
        id: "click_modal",
        type: "click_modal",
        score: top.score || 55,
        reason: `modal step: ${top.text || "continue"}`,
        targetCandidate: top,
        step: "wizard_choice",
      });
    }
  }

  if ((snap.continueCount || 0) > 0 && filled >= 1) {
    const top = snap.continueCandidates?.[0];
    if (top && (top.text || "").length <= 80) {
      let continueScore = 58;
      if (shouldAutoAdvance(snap, fillResult)) continueScore = 88;
      if (looksLikeSteppedForm(snap) && currentStepIncomplete(snap, fillResult)) continueScore = 35;
      if (top.disabled) {
        // Disabled Continue (YC relocate cities, etc.) — keep filling, don't thrash clicks.
        continueScore = Math.min(continueScore, 28);
        actions.push({
          id: "smart_fill_before_continue",
          type: "smart_fill",
          score: 86,
          reason: "continue disabled — fill remaining typeahead/required fields",
          step: "form",
        });
      } else if (looksLikeSteppedForm(snap)) {
        // Continue is enabled — Places/city snap.filled flags are often stale; advance.
        continueScore = Math.max(continueScore, 90);
      }
      actions.push({
        id: "click_continue",
        type: "click_continue",
        score: continueScore,
        reason: shouldAutoAdvance(snap, fillResult) || !top.disabled
          ? `step complete — ${top.text || "Next"}`
          : `continue: ${top.text || "Next"}`,
        targetCandidate: top,
        step: "continue",
      });
    }
  }

  if (
    classification?.step === "ambiguous" &&
    canUseStagehand(context).ok &&
    !looksLikeDeadApplyDestination(snap).dead
  ) {
    actions.push({
      id: "stagehand_ambiguous",
      type: "stagehand_act",
      score: 68,
      reason: "ambiguous page — semantic next step",
      instruction: buildStagehandInstruction(snap, classification, history, context),
      step: "ambiguous",
    });
  }

  // Sparse DOM (login wall, empty listing, SPA shell) — Stagehand observe→act as safety net
  if (
    canUseStagehand(context).ok &&
    (snap.entryCount || 0) === 0 &&
    (snap.fieldCount || 0) < 2 &&
    (snap.continueCount || 0) === 0 &&
    !looksLikeAuthForm(snap) &&
    classification?.step !== "blocked" &&
    !looksLikeDeadApplyDestination(snap).dead
  ) {
    actions.push({
      id: "stagehand_sparse_dom",
      type: "stagehand_act",
      score: 55,
      reason: "sparse DOM — semantic observe/act",
      instruction: buildStagehandInstruction(snap, classification || { step: "entry" }, history, context),
      step: classification?.step || "entry",
    });
  }

  const skills = findRelevantSkills(snap, context?.siteLearnings, {
    limit: 3,
    hostname: snap?.hostname || context?.targetHost,
  });
  for (const skill of skills) {
    if (!skill.action) continue;
    if (actions.some((a) => a.id === `situation_${skill.signature}_${skill.action}`)) continue;
    actions.push({
      id: `situation_${skill.signature}_${skill.action}`,
      type: skill.action,
      score: skill.confidence === "high" ? 88 : 70,
      reason: `situation skill — ${skill.signature}`,
      step: skill.action === "wait_user" ? "blocked" : skill.action === "nav_recovery" ? "nav_recovery" : "ambiguous",
      situationSkillId: skill.id,
      source: "situation-memory",
    });
  }

  const seen = new Set();
  return actions
    .filter((a) => {
      const key = `${a.type}:${a.reason}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score);
}
