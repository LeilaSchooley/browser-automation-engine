/**
 * Affordance-driven apply step classification — reads current page state, not action history.
 */
import { looksLikeApplyForm } from "./formDiscovery.js";
import { isPageUnloaded } from "./pageReady.js";
import {
  hasAuthCredentials,
  looksLikeAuthForm,
  looksLikeOAuthOnly,
  looksLikeHardGate,
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
import { looksLikeEmailVerifyWall } from "../inboxVerify.js";
import {
  isResumeChoiceStep,
  isResumeReviewUpsell,
  pageFingerprintFromSnap,
  shouldPreferUpload,
  uploadAlreadySucceeded,
} from "../heuristics.js";
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
  obstacle: "clear_obstacle",
  verify_email: "verify_email",
  nav_recovery: "nav_recovery",
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
    hasBlockingOverlay: !!snap.hasBlockingOverlay,
    dismissCount: snap.dismissCount || 0,
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

  if (snap.hasBlockingOverlay && (!snap.hasApplyModal || isResumeReviewUpsell(snap))) {
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

  if (isResumeReviewUpsell(snap)) {
    const top = snap.dismissCandidates?.[0];
    return {
      step: "overlay",
      confidence: "high",
      reason: top
        ? `resume review upsell — skip "${top.text || "Skip"}"`
        : "resume review upsell — dismiss to continue apply",
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
    return {
      step: "review",
      confidence: "high",
      reason: `${filled} field(s) filled — ready for manual review`,
      target: null,
      affordances,
      fingerprint: fp,
    };
  }

  // OneTrust / cookie chrome often stays in DOM while resume-score upsell is open —
  // never prefer consent over Skip when the upsell markers are present.
  if (snap.cookieBanner && !snap.hasApplyModal && !isResumeReviewUpsell(snap)) {
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
    // Only suppress the entry step if we already clicked apply FROM this same page
    // (fromFingerprint). Redirect chains land on new pages that need their own
    // apply click; a global "already clicked once" check breaks multi-hop flows.
    const applySucceeded = history.some(
      (h) =>
        h.action === "click_apply" &&
        h.ok &&
        (h.fromFingerprint ? h.fromFingerprint === fp : true),
    );
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

  if ((snap.fieldCount || 0) >= 1 && !snap.authForm) {
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
    if (isResumeReviewUpsell(snap)) {
      const top = snap.dismissCandidates?.[0];
      return {
        step: "overlay",
        confidence: "high",
        reason: top
          ? `resume review upsell after upload — skip "${top.text || "Skip"}"`
          : "resume review upsell after upload",
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
