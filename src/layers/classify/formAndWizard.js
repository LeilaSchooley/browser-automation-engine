import { looksLikeApplyForm } from "../formDiscovery.js";
import { hasIdentityRegistrationFields } from "../../fillProfile.js";
import { hasPreferencesGateFields, preferencesGateIncomplete } from "../../fillPreferences.js";
import { hasEmptyRequiredControls, controlCount } from "../../controlState.js";
import { looksLikeEmailVerifyWall } from "../../inboxVerify.js";
import { shouldNeverDismiss, isWorkflowGateModal } from "../../workflowGates.js";
import {
  looksLikeRealCookieConsent,
  isNonCookiePopup,
  topCookieCandidateScore,
} from "../../consentDetection.js";
import { canProvisionAccounts } from "../../accountStore.js";
import { isRegistrationSurface } from "../signupActions.js";
import { looksLikeAuthForm } from "../authActions.js";
import {
  candidateSuggestsFileUpload,
  findBestDismissCandidate,
  isExpertReviewGate,
  isResumeChoiceStep,
  isResumeReviewUpsell,
  dismissLoopStalled,
  continueLoopStalled,
  shouldPreferUpload,
  uploadAlreadySucceeded,
  preferencesSignupSubmitted,
  applyEntrySucceeded,
  countRecentAction,
  looksLikeInlineApplicationForm,
  hasUnfilledApplicationFields,
  uploadStalled,
  looksLikeMarketingYesNoModal,
  looksLikeGoogleVignetteAd,
} from "../../heuristics.js";
import {
  classifyJobAlertDismiss,
  hasCompetingAffordances,
  modalChoiceConfidence,
  shouldDismissJobAlertFirst,
} from "./helpers.js";

export function classifyJobAlertFirst(ctx) {
  const { snap, context, affordances, fingerprint: fp } = ctx;
  // Marketing/job-alert modals — dismiss before fake-listing trap or form fill.
  if (!shouldDismissJobAlertFirst(snap, context)) return null;
  const prefix = context?.siteLearnings?.dismissFirst
    ? "learned: dismiss job-alert first"
    : "non-cookie popup";
  return classifyJobAlertDismiss(snap, affordances, fp, prefix);
}

export function classifyPostPreferencesSignup(ctx) {
  const { snap, history, affordances, fingerprint: fp } = ctx;
  // After preferences signup CTA, JobLeads briefly shows listing + modal-close overlay.
  // Dismissing it resets the funnel — wait for auth/registration instead.
  if (!preferencesSignupSubmitted(history)) return null;

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
    return null;
  }
  if (snap.hasApplyModal && (snap.modalStepCount || 0) > 0) {
    /* fall through to wizard handlers below */
    return null;
  }

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
  return null;
}

export function classifyBlockingOverlay(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!(snap.hasBlockingOverlay && (!snap.hasApplyModal || isResumeReviewUpsell(snap)))) return null;
  if (shouldNeverDismiss(snap)) return null;
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

export function classifyGoogleVignette(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!looksLikeGoogleVignetteAd(snap)) return null;
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

export function classifyResumeReviewUpsell(ctx) {
  const { snap, history, affordances, fingerprint: fp } = ctx;
  if (!(isResumeReviewUpsell(snap) || isExpertReviewGate(snap))) return null;
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

export function classifyPreferencesGate(ctx) {
  const { snap, fillResult, filled, affordances, fingerprint: fp } = ctx;
  if (!hasPreferencesGateFields(snap)) return null;
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

export function classifyResumeReviewGateAfterPrefs(ctx) {
  const { snap, history, affordances, fingerprint: fp } = ctx;
  if (
    !(
      (isResumeReviewUpsell(snap) || (uploadAlreadySucceeded(history) && isExpertReviewGate(snap))) &&
      !hasPreferencesGateFields(snap) &&
      !isWorkflowGateModal(snap)
    )
  ) {
    return null;
  }
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

export function classifyIdentityRegistration(ctx) {
  const { snap, context, affordances, fingerprint: fp } = ctx;
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
  if (!(hasIdentityRegistrationFields(snap) && (snap.fieldCount || 0) >= 2 && !provisionableRegistration)) {
    return null;
  }
  return {
    step: "form",
    confidence: "high",
    reason: "registration/identity fields — fill from applicant profile",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyFilledReview(ctx) {
  const { snap, filled, affordances, fingerprint: fp } = ctx;
  if (!(filled >= 2 && looksLikeApplyForm(snap, 2) && !snap.authForm)) return null;
  if (isNonCookiePopup(snap) || looksLikeMarketingYesNoModal(snap)) return null;
  return {
    step: "review",
    confidence: "high",
    reason: `${filled} field(s) filled — ready for manual review`,
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyNonCookiePopup(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  // Non-cookie popups (job alerts, newsletters, phlex) — dismiss, never accept_cookies.
  if (!(isNonCookiePopup(snap) || looksLikeMarketingYesNoModal(snap))) return null;
  return classifyJobAlertDismiss(snap, affordances, fp);
}

export function classifyMisflaggedCookie(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!(snap.cookieBanner && !looksLikeRealCookieConsent(snap) && !snap.hasApplyModal)) return null;
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

export function classifyCookieConsent(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!(looksLikeRealCookieConsent(snap) && !snap.hasApplyModal && !isResumeReviewUpsell(snap))) {
    return null;
  }
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

export function classifyApplyModal(ctx) {
  const { snap, fillResult, history, affordances, fingerprint: fp } = ctx;
  if (!(snap.hasApplyModal && (snap.modalStepCount || 0) > 0)) return null;

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

  return null;
}

export function classifyListingEntry(ctx) {
  const { snap, history, affordances, fingerprint: fp } = ctx;
  if (!(!snap.hasApplyModal && snap.entryCount > 0 && (snap.pageKind === "listing" || snap.pageKind === "content"))) {
    return null;
  }
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
  return null;
}

export function classifyEmptyRequiredControls(ctx) {
  const { snap, fillResult, filled, affordances, fingerprint: fp } = ctx;
  if (!(hasEmptyRequiredControls(snap, fillResult) && filled === 0)) return null;
  return {
    step: "form",
    confidence: "low",
    reason: "empty required controls — fill before advancing",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyVisibleControls(ctx) {
  const { snap, fillResult, filled, affordances, fingerprint: fp } = ctx;
  if (!((controlCount(snap) >= 1 || (snap.customControlCount || 0) >= 1) && !snap.authForm)) {
    return null;
  }
  const unfilled = fillResult?.unfilled_count ?? snap.fieldCount;
  if (!(unfilled > 0 || filled === 0)) return null;
  return {
    step: "form",
    confidence: filled === 0 ? "low" : "high",
    reason: `${controlCount(snap)} control(s) visible, ${filled} filled`,
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyPostUploadWait(ctx) {
  const { snap, history, affordances, fingerprint: fp } = ctx;
  if (!(uploadAlreadySucceeded(history) && (snap.fieldCount || 0) === 0)) return null;
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

export function classifyContinue(ctx) {
  const { snap, fillResult, history, affordances, fingerprint: fp } = ctx;
  if (!(snap.continueCount > 0)) return null;

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
  return null;
}

export function classifySubmitReview(ctx) {
  const { snap, filled, affordances, fingerprint: fp } = ctx;
  if (!(snap.submitCount > 0 && filled >= 2)) return null;
  return {
    step: "review",
    confidence: "high",
    reason: "submit visible after fill — stopping for manual review",
    target: snap.submitCandidates?.[0] || null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyCompetingAmbiguous(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!hasCompetingAffordances(snap)) return null;
  return {
    step: "ambiguous",
    confidence: "low",
    reason: "multiple competing affordances on page",
    target: null,
    affordances,
    fingerprint: fp,
  };
}
