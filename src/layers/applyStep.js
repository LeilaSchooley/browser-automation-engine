/**
 * Affordance-driven apply step classification — reads current page state, not action history.
 */
import { looksLikeApplyForm } from "./formDiscovery.js";
import { isPageUnloaded } from "./pageReady.js";
import { looksLikeDeadApplyDestination, looksLikeAggregatorTrap, isOauthProviderHost } from "./applyUrlSafety.js";
import {
  hasAuthCredentials,
  looksLikeAuthForm,
  looksLikePasswordlessLoginSurface,
  looksLikeSoftOtpGate,
  looksLikeOAuthOnly,
  looksLikeHardGate,
  looksLikeExistingAccount,
  looksLikeExistingAccountError,
  looksLikeExistingAccountSignInPrompt,
} from "./authActions.js";
import {
  canProvisionAccounts,
  resolveAccountForHost,
} from "../accountStore.js";
import {
  looksLikeOAuthOnlySignup,
  looksLikeSignupEntry,
  looksLikeSignupForm,
  isRegistrationSurface,
} from "./signupActions.js";
import { hasIdentityRegistrationFields } from "../fillProfile.js";
import { hasPreferencesGateFields, preferencesGateIncomplete } from "../fillPreferences.js";
import { hasEmptyRequiredControls, controlCount } from "../controlState.js";
import { looksLikeEmailVerifyWall } from "../inboxVerify.js";
import { shouldNeverDismiss } from "../workflowGates.js";
import { isWorkflowGateModal } from "../workflowGates.js";
import {
  looksLikeRealCookieConsent,
  isNonCookiePopup,
  topCookieCandidateScore,
} from "../consentDetection.js";
import {
  candidateSuggestsFileUpload,
  findBestDismissCandidate,
  isExpertReviewGate,
  isResumeChoiceStep,
  isResumeReviewUpsell,
  dismissLoopStalled,
  continueLoopStalled,
  pageFingerprintFromSnap,
  shouldPreferUpload,
  uploadAlreadySucceeded,
  preferencesSignupSubmitted,
  applyEntrySucceeded,
  countRecentAction,
  looksLikeFakeJobListing,
  looksLikeClosedJobListing,
  looksLikeJobBoardIndex,
  looksLikeInlineApplicationForm,
  hasUnfilledApplicationFields,
  uploadStalled,
  isJobAlertInterstitial,
  looksLikeMarketingYesNoModal,
  looksLikeJobAlertSignupForm,
  looksLikeApplySignupGate,
  looksLikeGoogleVignetteAd,
  boardLeaveSucceeded,
  shouldBlockBoardSignupAfterLeave,
} from "../heuristics.js";
import { looksLikePlatformOnboarding, platformOnboardingIncomplete, looksLikeJobBoardWelcomeConfirm, welcomeConfirmCta, looksLikeDidYouApplyPrompt, didYouApplyDeclineCta, looksLikeBoardSignupOnboarding } from "../platformOnboarding.js";
import { BLOCKED_TEXT } from "../patterns/index.js";

/** Maps step type → default agent action. */
export const STEP_ACTIONS = {
  loading: "wait_load",
  overlay: "dismiss_overlay",
  consent: "accept_cookies",
  entry: "click_apply",
  wizard_choice: "click_modal",
  upload: "upload_resume",
  form: "smart_fill",
  auth: "auth_login",
  signup: "auth_signup",
  signup_entry: "click_signup",
  signin_entry: "click_signin",
  obstacle: "clear_obstacle",
  verify_email: "verify_email",
  enter_otp: "enter_otp",
  nav_recovery: "nav_recovery",
  continue: "click_continue",
  review: "done",
  blocked: "wait_user",
  ambiguous: null,
};

export function applyAffordances(snap, pageState = null) {
  if (!snap) return {};
  const ps = pageState || null;
  return {
    pageKind: snap.pageKind,
    fieldCount: snap.fieldCount || 0,
    fileInputCount: snap.fileInputCount || 0,
    entryCount: snap.entryCount || 0,
    modalStepCount: snap.modalStepCount || 0,
    hasApplyModal: !!snap.hasApplyModal,
    cookieBanner: !!snap.cookieBanner,
    hasBlockingOverlay: !!snap.hasBlockingOverlay,
    dismissCount: snap.dismissCount || 0,
    continueCount: snap.continueCount || 0,
    submitCount: snap.submitCount || 0,
    applyModalTitle: snap.applyModalTitle || "",
    topEntry: snap.entryCandidates?.[0]?.text || "",
    topModal: snap.modalCandidates?.[0]?.text || "",
    topContinue: snap.continueCandidates?.[0]?.text || "",
    dialogStackDepth: ps?.dialogStackDepth ?? (snap.dialogStack || []).length,
    pickerOpen: ps?.pickerOpen ?? !!snap.pickerOpen,
    uiPhase: ps?.uiPhase ?? (snap.pickerOpen ? "picker_open" : "idle"),
    pendingCommits: ps?.pendingCommits ?? [],
    confirmCount: snap.confirmCount || 0,
    activeDialogIndex: ps?.activeDialogIndex ?? snap.activeDialogIndex ?? -1,
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
  if (snap.hasBlockingOverlay) count += 1;
  if (snap.cookieBanner && !snap.hasApplyModal) count += 1;
  if (snap.hasApplyModal && snap.modalStepCount > 0) count += 1;
  if (snap.entryCount > 0 && !snap.hasApplyModal) count += 1;
  if ((snap.fieldCount || 0) >= 2) count += 1;
  if (snap.continueCount > 0) count += 1;
  return count >= 2;
}

function loginFailedTwice(history) {
  return history.filter((h) => h.action === "auth_login" && !h.ok).length >= 2;
}

function shouldPreferSignupForAccount(stored) {
  if (!stored) return false;
  return Boolean(stored.pending || stored.verified === false);
}

function ensureAccount(context, hostname) {
  if (hasAuthCredentials(context)) return getAuthFromContext(context);
  const account = resolveAccountForHost(context, hostname, { provision: canProvisionAccounts(context) });
  if (!account) return null;
  if (context) {
    context.auth = {
      ...(context.auth || {}),
      email: account.email,
      password: account.password,
    };
  }
  return account;
}

function getAuthFromContext(context) {
  const auth = context?.auth || {};
  const profile = context?.profile || {};
  return {
    email: auth.email || profile.email || "",
    password: auth.password || "",
  };
}

function classifyJobAlertDismiss(snap, affordances, fp, reasonPrefix = "non-cookie popup") {
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

function shouldDismissJobAlertFirst(snap, context = null) {
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

/**
 * Classify the current apply surface from a DOM snapshot.
 * @returns {{ step: string, confidence: "high"|"low", reason: string, target?: object|null, affordances: object }}
 */
export function classifyApplyStep(snap, fillResult, history = [], context = null) {
  const filled = fillResult?.filled?.length || 0;
  const affordances = applyAffordances(snap);
  const fp = pageFingerprintFromSnap(snap);

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

  const dead = looksLikeDeadApplyDestination(snap);
  if (dead.dead) {
    return {
      step: "blocked",
      confidence: "high",
      reason: dead.reason,
      target: null,
      affordances,
      fingerprint: fp,
      hardStop: true,
    };
  }

  if (isOauthProviderHost(snap.url || snap.hostname || "")) {
    return {
      step: "blocked",
      confidence: "high",
      reason: "third-party SSO (Apple/Google/…) — use email Continue on the job site",
      target: null,
      affordances,
      fingerprint: fp,
      hardStop: true,
    };
  }

  const closedJob = looksLikeClosedJobListing(snap);
  if (closedJob.closed) {
    return {
      step: "blocked",
      confidence: "high",
      reason: closedJob.reason,
      target: null,
      affordances,
      fingerprint: fp,
      hardStop: true,
    };
  }

  const trap = looksLikeAggregatorTrap(snap, history);
  if (trap.trapped) {
    return {
      step: "blocked",
      confidence: "high",
      reason: trap.reason,
      target: null,
      affordances,
      fingerprint: fp,
      hardStop: true,
    };
  }

  // Marketing/job-alert modals — dismiss before fake-listing trap or form fill.
  if (shouldDismissJobAlertFirst(snap, context)) {
    const prefix = context?.siteLearnings?.dismissFirst
      ? "learned: dismiss job-alert first"
      : "non-cookie popup";
    return classifyJobAlertDismiss(snap, affordances, fp, prefix);
  }

  // Site says account already exists (error toast / prior signup) → sign in.
  // Soft "Already have an account?" CTA alone does not override a fresh signup path.
  const signupSaidExists = (history || []).some(
    (h) => h.action === "auth_signup" && (h.existingAccount || h.learnings?.existingAccount),
  );
  const hostname = snap.hostname || "";
  const stored = hostname ? resolveAccountForHost(context, hostname, { provision: false }) : null;
  const hasStoredCreds = Boolean(
    (stored && (stored.email || stored.username) && stored.password) || hasAuthCredentials(context),
  );
  const forceSignIn =
    signupSaidExists ||
    looksLikeExistingAccountError(snap) ||
    (looksLikeExistingAccountSignInPrompt(snap) &&
      !isRegistrationSurface(snap) &&
      (hasStoredCreds || stored?.existsOnSite || stored?.verified));

  if (forceSignIn) {
    if (hostname) ensureAccount(context, hostname);
    if ((snap.signInCount || 0) > 0) {
      return {
        step: "signin_entry",
        confidence: "high",
        reason: "site says account already exists — open sign in",
        target: snap.signInCandidates?.[0] || null,
        affordances,
        fingerprint: fp,
      };
    }
    if (looksLikeAuthForm(snap) || (snap.passwordFieldCount || 0) > 0) {
      return {
        step: "auth",
        confidence: "high",
        reason: "site says account already exists — log in",
        target: snap.signInCandidates?.[0] || null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  // Soft OTP / email-code wall — must win over passwordless "Create account" once a code field is shown.
  if (looksLikeSoftOtpGate(snap)) {
    return {
      step: "enter_otp",
      confidence: "high",
      reason: "OTP / email verification code — poll inbox or wait for paste",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  // Passwordless magic-link/OTP login (e.g. YC): with no verified account, submitting the
  // email just triggers an email-code wall for an account that doesn't exist. Prefer the
  // "Create an account" path instead of filling the login form.
  if (looksLikePasswordlessLoginSurface(snap) && !looksLikeAuthForm(snap)) {
    const hostname = snap.hostname || "";
    const stored = resolveAccountForHost(context, hostname, { provision: false });
    const hasVerifiedCreds =
      hasAuthCredentials(context) ||
      (stored && stored.verified && !shouldPreferSignupForAccount(stored));
    if (!hasVerifiedCreds && (snap.signUpCount || 0) > 0 && canProvisionAccounts(context)) {
      ensureAccount(context, hostname);
      return {
        step: "signup_entry",
        confidence: "high",
        reason: "passwordless login wall, no saved account — open Create an account",
        target: snap.signUpCandidates?.[0] || null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  if (looksLikeApplySignupGate(snap)) {
    const hostname = snap.hostname || "";
    const stored = resolveAccountForHost(context, hostname, { provision: false });
    const hasVerified =
      stored &&
      stored.verified === true &&
      !shouldPreferSignupForAccount(stored) &&
      (stored.email || stored.username) &&
      stored.password;

    if (hasVerified) {
      ensureAccount(context, hostname);
      // Signup modal with "Already a member? Sign in now" — open login first.
      if ((snap.signInCount || 0) > 0) {
        return {
          step: "signin_entry",
          confidence: "high",
          reason: "verified site account — switch to sign in",
          target: snap.signInCandidates?.[0] || null,
          affordances,
          fingerprint: fp,
        };
      }
      return {
        step: "auth",
        confidence: "high",
        reason: "verified site account — log in to apply",
        target: snap.signInCandidates?.[0] || null,
        affordances,
        fingerprint: fp,
      };
    }

    if (canProvisionAccounts(context)) {
      ensureAccount(context, snap.hostname || "");
      return {
        step: "signup",
        confidence: "high",
        reason: "platform signup gate — create account to apply",
        target: snap.signUpCandidates?.[0] || snap.submitCandidates?.[0] || null,
        affordances,
        fingerprint: fp,
      };
    }
    return {
      step: "blocked",
      confidence: "high",
      reason: "sign up required on this job board — create account manually to apply",
      target: null,
      affordances,
      fingerprint: fp,
      hardStop: true,
    };
  }

  const fakeListing = looksLikeFakeJobListing(snap, history);
  if (fakeListing.fake) {
    return {
      step: "blocked",
      confidence: "high",
      reason: fakeListing.reason,
      target: null,
      affordances,
      fingerprint: fp,
      hardStop: true,
    };
  }

  // After preferences signup CTA, JobLeads briefly shows listing + modal-close overlay.
  // Dismissing it resets the funnel — wait for auth/registration instead.
  if (preferencesSignupSubmitted(history)) {
    if (looksLikeEmailVerifyWall(snap)) {
      return {
        step: "verify_email",
        confidence: "high",
        reason: "post-preferences signup — email activation required",
        target: null,
        affordances,
        fingerprint: fp,
      };
    }
    if (looksLikeAuthForm(snap) || hasIdentityRegistrationFields(snap)) {
      /* fall through to auth/registration handlers below */
    } else if (snap.hasApplyModal && (snap.modalStepCount || 0) > 0) {
      /* fall through to wizard handlers below */
    } else {
      const dismiss = snap.dismissCandidates?.[0];
      const genericClose =
        dismiss?.testId === "modal-close" ||
        /^(close|×|x)$/i.test(String(dismiss?.text || dismiss?.aria || "").trim());
      if (
        genericClose ||
        (snap.pageKind === "listing" && (snap.modalCount || 0) > 0 && !uploadAlreadySucceeded(history))
      ) {
        if ((snap.modalCount || 0) > 0 && countRecentAction(history, "wait_load", 3) >= 2) {
          return {
            step: "verify_email",
            confidence: "high",
            reason: "post-preferences signup — account activation modal (poll inbox)",
            target: null,
            affordances,
            fingerprint: fp,
          };
        }
        return {
          step: "loading",
          confidence: "high",
          reason: "post-preferences signup — waiting for registration surface (do not close modal)",
          target: null,
          affordances,
          fingerprint: fp,
        };
      }
    }
  }

  if (snap.hasBlockingOverlay && (!snap.hasApplyModal || isResumeReviewUpsell(snap))) {
    if (!shouldNeverDismiss(snap)) {
      const top = snap.dismissCandidates?.[0];
      return {
        step: "overlay",
        confidence: "high",
        reason: top
          ? `blocking overlay — dismiss "${top.text || top.aria || "close"}"`
          : isResumeReviewUpsell(snap)
            ? "resume review upsell blocking apply"
            : "blocking ad/overlay detected",
        target: top || null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  if (looksLikeGoogleVignetteAd(snap)) {
    const top = findBestDismissCandidate(snap) || snap.dismissCandidates?.[0];
    return {
      step: "overlay",
      confidence: "high",
      reason: top
        ? `google vignette ad — dismiss "${top.text || top.aria || "Close"}"`
        : "google vignette ad (#google_vignette) — dismiss before apply",
      target: top || null,
      affordances,
      fingerprint: fp,
    };
  }

  if (looksLikeJobBoardWelcomeConfirm(snap)) {
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

  if (looksLikeDidYouApplyPrompt(snap)) {
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

  if (isResumeReviewUpsell(snap) || isExpertReviewGate(snap)) {
    // Don't keep Escape-dismiss when Apply is still available and dismiss already failed.
    if (dismissLoopStalled(history, 2) && (snap.entryCount || 0) > 0) {
      const top = snap.entryCandidates?.[0];
      return {
        step: "entry",
        confidence: "high",
        reason: `dismiss loop broken — apply CTA: ${top?.text || "Apply"}`,
        target: top || null,
        affordances,
        fingerprint: fp,
      };
    }
    const top = findBestDismissCandidate(snap) || snap.dismissCandidates?.[0];
    return {
      step: "overlay",
      confidence: "high",
      reason: top
        ? `resume upsell — skip "${top.text || top._text || "Skip"}"`
        : "resume boost / review upsell — dismiss to continue apply",
      target: top || null,
      affordances,
      fingerprint: fp,
    };
  }

  if (looksLikeJobBoardIndex(snap)) {
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

  // Board membership wizard (/onboard/) — not the employer job application.
  if (looksLikeBoardSignupOnboarding(snap)) {
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

  // After leaving board onboard, never re-enter via Sign Up on the board listing.
  if (shouldBlockBoardSignupAfterLeave(history, snap) && (looksLikeSignupEntry(snap) || (snap.signUpCount || 0) > 0)) {
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

  if (looksLikePlatformOnboarding(snap)) {
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

  if (hasPreferencesGateFields(snap)) {
    if (preferencesGateIncomplete(snap, fillResult)) {
      return {
        step: "form",
        confidence: filled === 0 ? "low" : "high",
        reason: "preferences gate — fill location, desired title, and salary",
        target: null,
        affordances,
        fingerprint: fp,
      };
    }
    const top = snap.continueCandidates?.[0] || snap.signUpCandidates?.[0] || snap.modalCandidates?.[0];
    return {
      step: "continue",
      confidence: "high",
      reason: `preferences complete — ${top?.text || "continue / sign up"}`,
      target: top || null,
      affordances,
      fingerprint: fp,
    };
  }

  if (
    (isResumeReviewUpsell(snap) || (uploadAlreadySucceeded(history) && isExpertReviewGate(snap))) &&
    !hasPreferencesGateFields(snap) &&
    !isWorkflowGateModal(snap)
  ) {
    const top = findBestDismissCandidate(snap) || snap.dismissCandidates?.[0];
    return {
      step: "overlay",
      confidence: "high",
      reason: top
        ? `resume review gate — skip "${top.text || top._text || "Skip and continue"}"`
        : "resume review gate — dismiss to continue apply",
      target: top || null,
      affordances,
      fingerprint: fp,
    };
  }

  const hard = looksLikeHardGate(snap);
  if (hard.hard) {
    return {
      step: "blocked",
      confidence: "high",
      reason: hard.reason,
      target: null,
      affordances,
      fingerprint: fp,
      hardStop: true,
    };
  }

  if (looksLikeEmailVerifyWall(snap)) {
    return {
      step: "verify_email",
      confidence: "high",
      reason: "email verification wall — polling inbox",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  // Registration with personal name fields — fill from applicant profile via smart_fill
  // even when auto-signup provisioning is off (job-apply uses real Settings identity).
  // BUT a real create-account surface (password field present) with provisioning enabled must
  // use the signup path: the profile matcher mis-maps identity fields (e.g. email → username),
  // while fillSignupFormFromDom assigns a proper username, generated password, and clears any
  // value the site pre-filled into the wrong field (YC carries the login email into Username).
  const provisionableRegistration =
    isRegistrationSurface(snap) &&
    (snap.passwordFieldCount || 0) > 0 &&
    canProvisionAccounts(context);
  if (hasIdentityRegistrationFields(snap) && (snap.fieldCount || 0) >= 2 && !provisionableRegistration) {
    return {
      step: "form",
      confidence: "high",
      reason: "registration/identity fields — fill from applicant profile",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  // Registration surface (confirm password, username+email, etc.) — always signup, never login
  if (isRegistrationSurface(snap) && canProvisionAccounts(context)) {
    ensureAccount(context, snap.hostname || "");
    return {
      step: "signup",
      confidence: "high",
      reason: "registration form — filling all signup fields from DOM",
      target: snap.signUpCandidates?.[0] || null,
      affordances,
      fingerprint: fp,
    };
  }

  // Prefer signup on dual login+create walls when we can provision and have no saved account
  if (looksLikeSignupForm(snap) && canProvisionAccounts(context)) {
    const hostname = snap.hostname || "";
    const stored = resolveAccountForHost(context, hostname, { provision: false });
    if (!stored || stored.pending || !hasAuthCredentials(context)) {
      ensureAccount(context, hostname);
      return {
        step: "signup",
        confidence: "high",
        reason: "signup / create-account wall — provisioning account on the fly",
        target: snap.signUpCandidates?.[0] || null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  if (looksLikeAuthForm(snap)) {
    const hostname = snap.hostname || "";
    const stored = resolveAccountForHost(context, hostname, { provision: false });

    if (loginFailedTwice(history) && canProvisionAccounts(context)) {
      if ((snap.signUpCount || 0) > 0) {
        ensureAccount(context, hostname);
        return {
          step: "signup_entry",
          confidence: "high",
          reason: "login failed — switching to account creation",
          target: snap.signUpCandidates?.[0] || null,
          affordances,
          fingerprint: fp,
        };
      }
    }

    if (shouldPreferSignupForAccount(stored) && canProvisionAccounts(context)) {
      ensureAccount(context, hostname);
      if (looksLikeSignupForm(snap)) {
        return {
          step: "signup",
          confidence: "high",
          reason: "account not verified on site — completing registration",
          target: snap.signUpCandidates?.[0] || null,
          affordances,
          fingerprint: fp,
        };
      }
      if (looksLikeSignupEntry(snap) || (snap.signUpCount || 0) > 0) {
        return {
          step: "signup_entry",
          confidence: "high",
          reason: "account not verified on site — opening signup",
          target: snap.signUpCandidates?.[0] || null,
          affordances,
          fingerprint: fp,
        };
      }
    }

    if (hasAuthCredentials(context) || (stored && stored.verified)) {
      ensureAccount(context, hostname);
      return {
        step: "auth",
        confidence: "high",
        reason: stored?.verified
          ? "login form — using saved site account"
          : "login form — using configured or provisioned credentials",
        target: snap.signInCandidates?.[0] || null,
        affordances,
        fingerprint: fp,
      };
    }

    if (looksLikeSignupEntry(snap) && canProvisionAccounts(context)) {
      ensureAccount(context, hostname);
      return {
        step: "signup_entry",
        confidence: "high",
        reason: "login wall with signup path — opening registration",
        target: snap.signUpCandidates?.[0] || null,
        affordances,
        fingerprint: fp,
      };
    }

    if (canProvisionAccounts(context)) {
      ensureAccount(context, hostname);
      if ((snap.signUpCount || 0) > 0) {
        return {
          step: "signup_entry",
          confidence: "high",
          reason: "no account yet — creating one for this directory",
          target: snap.signUpCandidates?.[0] || null,
          affordances,
          fingerprint: fp,
        };
      }
      return {
        step: "signup",
        confidence: "medium",
        reason: "auth surface — attempting signup with new account",
        target: null,
        affordances,
        fingerprint: fp,
      };
    }

    return {
      step: "blocked",
      confidence: "high",
      reason: "login required — configure account email/password or enable auto-signup",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  if (looksLikeOAuthOnlySignup(snap) && filled === 0 && !canProvisionAccounts(context)) {
    return {
      step: "blocked",
      confidence: "high",
      reason: "OAuth-only signup — email registration not available on this page",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  if (looksLikeOAuthOnly(snap) && filled === 0) {
    return {
      step: "blocked",
      confidence: "high",
      reason: "OAuth-only sign-in (Google/X/GitHub) — manual login required",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

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

  if (filled >= 2 && looksLikeApplyForm(snap, 2) && !snap.authForm) {
    if (!isNonCookiePopup(snap) && !looksLikeMarketingYesNoModal(snap)) {
      return {
        step: "review",
        confidence: "high",
        reason: `${filled} field(s) filled — ready for manual review`,
        target: null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  // Non-cookie popups (job alerts, newsletters, phlex) — dismiss, never accept_cookies.
  if (isNonCookiePopup(snap) || looksLikeMarketingYesNoModal(snap)) {
    return classifyJobAlertDismiss(snap, affordances, fp);
  }

  if (snap.cookieBanner && !looksLikeRealCookieConsent(snap) && !snap.hasApplyModal) {
    const top = findBestDismissCandidate(snap) || snap.dismissCandidates?.[0];
    return {
      step: "overlay",
      confidence: "high",
      reason: top
        ? `mis-flagged banner — dismiss "${top.text || top.aria || "close"}"`
        : "mis-flagged cookie banner — dismiss first",
      target: top || null,
      affordances,
      fingerprint: fp,
    };
  }

  if (looksLikeRealCookieConsent(snap) && !snap.hasApplyModal && !isResumeReviewUpsell(snap)) {
    const cookieScore = topCookieCandidateScore(snap);
    const confidence = cookieScore >= 80 ? "high" : "medium";
    return {
      step: "consent",
      confidence,
      reason:
        confidence === "high"
          ? "cookie consent — accept button or known consent chrome"
          : "cookie consent — weak candidate, may need brain",
      target: snap.cookieCandidates?.[0] || null,
      affordances,
      fingerprint: fp,
    };
  }

  if (snap.hasApplyModal && (snap.modalStepCount || 0) > 0) {
    const top = snap.modalCandidates?.[0];

    if (looksLikeInlineApplicationForm(snap)) {
      if (hasUnfilledApplicationFields(snap, fillResult) || uploadStalled(history)) {
        return {
          step: "form",
          confidence: uploadStalled(history) ? "low" : "high",
          reason: uploadStalled(history)
            ? "inline application form — upload stalled, fill fields"
            : "inline application form — fill required fields",
          target: null,
          affordances,
          fingerprint: fp,
        };
      }
    }

    if (uploadAlreadySucceeded(history) && isExpertReviewGate(snap)) {
      const skip = findBestDismissCandidate(snap);
      return {
        step: "overlay",
        confidence: "high",
        reason: skip
          ? `expert review after upload — skip "${skip.text || skip._text || "Skip and continue"}"`
          : "expert review after upload — dismiss to reach form",
        target: skip || null,
        affordances,
        fingerprint: fp,
      };
    }

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
      shouldPreferUpload(snap, history, fillResult) &&
      !uploadAlreadySucceeded(history) &&
      !isResumeChoiceStep(snap) &&
      !uploadStalled(history)
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
      if (uploadAlreadySucceeded(history) && candidateSuggestsFileUpload(top)) {
        const skip = findBestDismissCandidate(snap);
        if (skip || isExpertReviewGate(snap)) {
          return {
            step: "overlay",
            confidence: "high",
            reason: skip
              ? `resume already uploaded — skip "${skip.text || skip._text || "Skip and continue"}"`
              : "resume already uploaded — dismiss optional review step",
            target: skip || null,
            affordances,
            fingerprint: fp,
          };
        }
      }
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
    // Only suppress the entry step if we already clicked apply FROM this same page
    // (fromFingerprint). Redirect chains land on new pages that need their own
    // apply click; a global "already clicked once" check breaks multi-hop flows.
    const applySucceeded = applyEntrySucceeded(history, fp);
    if (uploadAlreadySucceeded(history) && (snap.fieldCount || 0) === 0) {
      const skip = findBestDismissCandidate(snap);
      if (skip || isExpertReviewGate(snap) || (snap.modalCount || 0) > 0) {
        return {
          step: "overlay",
          confidence: "high",
          reason: "resume uploaded — dismiss review gate instead of restarting apply",
          target: skip || null,
          affordances,
          fingerprint: fp,
        };
      }
    }
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

  if (hasEmptyRequiredControls(snap, fillResult) && filled === 0) {
    return {
      step: "form",
      confidence: "low",
      reason: "empty required controls — fill before advancing",
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  if ((controlCount(snap) >= 1 || (snap.customControlCount || 0) >= 1) && !snap.authForm) {
    const unfilled = fillResult?.unfilled_count ?? snap.fieldCount;
    if (unfilled > 0 || filled === 0) {
      return {
        step: "form",
        confidence: filled === 0 ? "low" : "high",
        reason: `${controlCount(snap)} control(s) visible, ${filled} filled`,
        target: null,
        affordances,
        fingerprint: fp,
      };
    }
  }

  if (uploadAlreadySucceeded(history) && (snap.fieldCount || 0) === 0) {
    if (isResumeReviewUpsell(snap) || isExpertReviewGate(snap)) {
      const top = findBestDismissCandidate(snap) || snap.dismissCandidates?.[0];
      return {
        step: "overlay",
        confidence: "high",
        reason: top
          ? `resume review gate after upload — skip "${top.text || top._text || "Skip and continue"}"`
          : "resume review gate after upload",
        target: top || null,
        affordances,
        fingerprint: fp,
      };
    }
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
    if (preferencesGateIncomplete(snap, fillResult)) {
      return {
        step: "form",
        confidence: "high",
        reason: "preferences incomplete — fill before continue",
        target: null,
        affordances,
        fingerprint: fp,
      };
    }
    if (continueLoopStalled(history, fillResult, 3) && (fillResult?.filled?.length || 0) === 0) {
      if ((history || []).some((h) => h.action === "nav_recovery")) {
        return {
          step: "blocked",
          confidence: "high",
          reason: "continue loop with no fills — handoff",
          target: null,
          affordances,
          fingerprint: fp,
        };
      }
      return {
        step: "nav_recovery",
        confidence: "high",
        reason: "continue loop with no fills — recover navigation",
        target: null,
        affordances,
        fingerprint: fp,
      };
    }
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
