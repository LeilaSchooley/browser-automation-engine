/**
 * Adaptive recovery — when heuristics or the validator disagree with reality,
 * derive and execute a smarter next move (any blocker, not just upsells).
 */
import { getRuntime, getSettings } from "../runtime.js";
import {
  isBlockingInterstitial,
  isExpertReviewGate,
  shouldPreferUpload,
  textMatchesInterstitialDismiss,
  uploadAlreadySucceeded,
  recentPreferencesSignup,
  preferencesSignupSubmitted,
} from "../heuristics.js";
import { dismissBlockingOverlays } from "./adDismiss.js";
import { humanPause } from "../human.js";
import { inspectPage } from "./formDiscovery.js";
import { executePlan } from "./executePlan.js";
import { hasIdentityRegistrationFields } from "../fillProfile.js";
import { hasPreferencesGateFields, preferencesGateIncomplete } from "../fillPreferences.js";
import { isWorkflowGateModal, shouldNeverDismiss } from "../workflowGates.js";
import { looksLikeRealCookieConsent } from "../consentDetection.js";
import { hasEmptyRequiredControls } from "../controlState.js";
import { pageStateSummary } from "./pageState.js";
import { canUseStagehand } from "./stagehandAdapter.js";
import { buildStagehandPlan } from "./stagehandPolicy.js";
import { looksLikeDidYouApplyPrompt } from "../platformOnboarding.js";
import { normalizeRecoveryAction } from "./actionValidator.js";

const RECOVERY_ACTIONS = new Set([
  "dismiss_overlay",
  "upload_resume",
  "click_modal",
  "click_apply",
  "click_continue",
  "accept_cookies",
  "smart_fill",
  "wait_load",
  "auth_signup",
  "auth_login",
]);

/** Bind validator recovery string to an executable plan type. */
export function recoveryToPlanType(recovery) {
  const normalized = normalizeRecoveryAction(recovery);
  if (!normalized || normalized === "ai_replan") return null;
  return RECOVERY_ACTIONS.has(normalized) ? normalized : null;
}

export function validatorRecentlyRejected(history, n = 2) {
  return (history || []).slice(-n).some((h) => h.progressSource === "validator" && !h.progress && h.ok);
}

export function repeatedActionWithoutProgress(history, n = 2) {
  if (!history?.length || history.length < n) return false;
  const recent = history.slice(-n);
  const action = recent[0]?.action;
  if (!action) return false;
  return recent.every((h) => h.action === action && !h.progress);
}

export function modalHasDismissControl(snap) {
  return (snap?.interactives || []).some(
    (i) => i.inModal && textMatchesInterstitialDismiss(i.text || i.aria),
  );
}

/** When to involve the AI planner (broad — any stuck/confused state). */
export function shouldEscalateToAi(snap, history, classification) {
  if (!getSettings().agent_ai) return false;
  const layout = pageStateSummary(snap);
  const uncommittedPicker = layout.uiPhase === "option_selected_uncommitted" || snap?.pickerOpen;
  const stalled = history.length >= 2 && history.slice(-2).every((h) => !h.progress);
  const emptyControls = hasEmptyRequiredControls(snap, history[history.length - 1]?.fillResult);
  const lastAction = history[history.length - 1]?.action;
  const smartFillStuck = lastAction === "smart_fill" && validatorRecentlyRejected(history);
  const interstitialLikely =
    !shouldNeverDismiss(snap) &&
    !emptyControls &&
    (isBlockingInterstitial(snap) || ((snap?.modalCount || 0) > 0 && modalHasDismissControl(snap)));
  return (
    !classification ||
    classification.confidence === "low" ||
    classification.step === "ambiguous" ||
    stalled ||
    emptyControls ||
    uncommittedPicker ||
    smartFillStuck ||
    validatorRecentlyRejected(history) ||
    repeatedActionWithoutProgress(history, 2) ||
    interstitialLikely
  );
}

/** When AI plan should replace a confident heuristic plan. */
export function shouldAiOverrideHeuristic(snap, history, classification) {
  if (!classification) return true;
  const stalled = history.length >= 2 && history.slice(-2).every((h) => !h.progress);
  const interstitialLikely =
    !shouldNeverDismiss(snap) &&
    (isBlockingInterstitial(snap) || modalHasDismissControl(snap) || isExpertReviewGate(snap));
  const uploaded = uploadAlreadySucceeded(history);
  return (
    classification.confidence === "low" ||
    classification.step === "ambiguous" ||
    stalled ||
    validatorRecentlyRejected(history) ||
    repeatedActionWithoutProgress(history, 2) ||
    (uploaded && ["entry", "loading"].includes(classification.step)) ||
    (interstitialLikely && ["consent", "listing", "overlay"].includes(classification.step)) ||
    (repeatedActionWithoutProgress(history, 3) && classification.confidence === "high")
  );
}

/** Map validator verdict + page state → concrete recovery plan. */
export function deriveRecoveryPlan({ verdict, snap, history, lastPlan }) {
  const raw = verdict?.recovery;
  if (raw === "click_continue" && hasIdentityRegistrationFields(snap)) {
    return {
      type: "auth_signup",
      reason: "registration form — fill and submit Continue",
      source: "semantic-recovery",
    };
  }
  if (raw === "click_continue" && hasPreferencesGateFields(snap)) {
    return {
      type: preferencesGateIncomplete(snap) ? "smart_fill" : "click_continue",
      reason: preferencesGateIncomplete(snap)
        ? "preferences gate — fill salary/location before continue"
        : "preferences complete — continue",
      source: "semantic-recovery",
    };
  }
  if (raw === "dismiss_overlay" && isWorkflowGateModal(snap)) {
    return {
      type: hasPreferencesGateFields(snap) ? "smart_fill" : "auth_signup",
      reason: "workflow gate — do not dismiss, fill and advance",
      source: "semantic-recovery",
    };
  }
  if (raw === "dismiss_overlay" && (recentPreferencesSignup(history) || preferencesSignupSubmitted(history))) {
    return {
      type: "verify_email",
      reason: "post-preferences signup — poll inbox for activation link",
      source: "semantic-recovery",
    };
  }

  const earlyReason = String(verdict?.reason || "").toLowerCase();
  if (
    looksLikeDidYouApplyPrompt(snap) ||
    /did you apply\??/i.test(earlyReason) ||
    (raw === "dismiss_overlay" && /did you apply\??/i.test(earlyReason))
  ) {
    return {
      type: "click_continue",
      reason: `did-you-apply tracker — choose Not yet (${verdict?.reason || "detected"})`,
      source: "semantic-recovery",
    };
  }
  if (
    /google.?vignette|adsbygoogle|vignette|choose your job type|intercepts pointer|advertisement.*intercept/i.test(
      earlyReason,
    ) ||
    /#google_vignette/i.test(String(snap?.url || ""))
  ) {
    return {
      type: "dismiss_overlay",
      reason: verdict?.reason || "google vignette / ad overlay blocking clicks",
      source: "semantic-recovery",
    };
  }

  if (raw && raw !== "null" && raw !== "ai_replan") {
    const bound = recoveryToPlanType(raw);
    if (bound) {
      return {
        type: bound,
        reason: `validator recovery: ${verdict?.reason || raw}`,
        source: "semantic-recovery",
      };
    }
  }

  const reason = earlyReason;
  if (/password policy|one number|one lowercase|one uppercase|one special|minimum of \d+ character/i.test(reason)) {
    return {
      type: "auth_signup",
      reason: "password policy incomplete — refill and retry",
      source: "semantic-recovery",
    };
  }
  if (/preferences gate|salary expectation|desired job title|tell us about yourself/i.test(reason)) {
    return {
      type: "smart_fill",
      reason: verdict?.reason || "preferences gate — fill remaining fields",
      source: "semantic-recovery",
    };
  }

  if (
    uploadAlreadySucceeded(history) &&
    (isExpertReviewGate(snap) ||
      /expert review|skip and continue|not ready yet|free expert|upsell.*upload/i.test(reason))
  ) {
    return {
      type: "dismiss_overlay",
      reason: verdict?.reason || "expert review gate after upload — skip to application",
      source: "semantic-recovery",
    };
  }
  if (
    (preferencesSignupSubmitted(history) || recentPreferencesSignup(history)) &&
    /activate your account|activation modal|check your email|verify your email/i.test(reason)
  ) {
    return {
      type: "verify_email",
      reason: verdict?.reason || "account activation — poll inbox",
      source: "semantic-recovery",
    };
  }
  if (
    /upsell|interstitial|modal|block|dialog|overlay|another|still blocking|dismiss|marketing|expert review|skip and continue/i.test(
      reason,
    ) ||
    isBlockingInterstitial(snap) ||
    isExpertReviewGate(snap)
  ) {
    if (preferencesSignupSubmitted(history) || recentPreferencesSignup(history)) {
      return {
        type: "verify_email",
        reason: verdict?.reason || "post-preferences signup — poll inbox",
        source: "semantic-recovery",
      };
    }
    return {
      type: "dismiss_overlay",
      reason: verdict?.reason || "blocking dialog still visible",
      source: "semantic-recovery",
    };
  }
  if (shouldPreferUpload(snap, history) && /upload|resume|document|attach|file/i.test(reason)) {
    return {
      type: "upload_resume",
      reason: verdict?.reason || "upload step still needed",
      source: "semantic-recovery",
    };
  }
  if (shouldPreferUpload(snap, history) && lastPlan?.type === "dismiss_overlay") {
    return {
      type: "upload_resume",
      reason: "dismiss did not advance — upload affordance visible",
      source: "semantic-recovery",
    };
  }
  if (/wizard|choice|have a resume|application start/i.test(reason) && snap?.hasApplyModal) {
    if (uploadAlreadySucceeded(history) && (isExpertReviewGate(snap) || (snap.fileInputCount || 0) > 0)) {
      return {
        type: "dismiss_overlay",
        reason: verdict?.reason || "wizard open after upload — dismiss review gate",
        source: "semantic-recovery",
      };
    }
    return {
      type: "click_modal",
      reason: verdict?.reason || "wizard step still open",
      source: "semantic-recovery",
    };
  }
  if (/cookie|consent|onetrust/i.test(reason) && snap?.cookieBanner) {
    if (!looksLikeRealCookieConsent(snap)) {
      return {
        type: "dismiss_overlay",
        reason: verdict?.reason || "misclassified popup — dismiss not accept cookies",
        source: "semantic-recovery",
      };
    }
    return {
      type: "accept_cookies",
      reason: verdict?.reason || "cookie banner blocking",
      source: "semantic-recovery",
    };
  }
  if (snap?.entryCount > 0 && !snap?.hasApplyModal && /listing|apply|interest|job page/i.test(reason)) {
    if (uploadAlreadySucceeded(history) && (snap.fieldCount || 0) === 0) {
      return {
        type: "dismiss_overlay",
        reason: verdict?.reason || "resume uploaded — dismiss gate instead of re-applying",
        source: "semantic-recovery",
      };
    }
    return {
      type: "click_apply",
      reason: verdict?.reason || "still on listing",
      source: "semantic-recovery",
    };
  }
  if ((snap?.fieldCount || 0) >= 1 && /form|field|fill/i.test(reason)) {
    return {
      type: "smart_fill",
      reason: verdict?.reason || "form visible — try fill",
      source: "semantic-recovery",
    };
  }
  return null;
}

export async function attemptSemanticRecovery(
  page,
  snap,
  { verdict, history, lastPlan, log, url, sessionId, fillResult, context },
) {
  let plan = deriveRecoveryPlan({ verdict, snap, history, lastPlan });

  if (!plan) {
    const { planNextAction } = getRuntime();
    if (planNextAction && getSettings().agent_ai) {
      const aiPlan = await planNextAction(
        context || {},
        snap,
        [
          ...(history || []),
          {
            action: lastPlan?.type,
            ok: true,
            progress: false,
            progressSource: "validator",
            progressReason: verdict?.reason,
          },
        ],
        fillResult,
        { step: "ambiguous", confidence: "low", reason: verdict?.reason || "semantic recovery" },
      );
      if (aiPlan && !["wait_user", "done"].includes(aiPlan.type)) {
        plan = { ...aiPlan, source: "semantic-recovery-ai" };
      }
    }
  }

  if (!plan) return { ok: false, plan: null, snap };

  log?.layer("agent", `semantic recovery → ${plan.type}: ${plan.reason}`, "warn");

  if (plan.type === "dismiss_overlay") {
    const ok = await dismissBlockingOverlays(page, log, "agent", snap);
    await humanPause(600, 1100);
    return { ok, plan, snap: await inspectPage(page) };
  }

  const executed = await executePlan(page, plan, {
    snap,
    context: context || {},
    log,
    url,
    sessionId,
    fillResult,
    history,
  });
  return {
    ok: executed.ok,
    plan,
    snap: executed.snap || (await inspectPage(page)),
    fillResult: executed.fillResult,
  };
}

/** Last chance before manual handoff — end-state assessor or AI replan. */
export async function attemptFinalRecovery(
  page,
  snap,
  history,
  fillResult,
  context,
  log,
  { url, sessionId } = {},
) {
  const filledCount = fillResult?.filled?.length || 0;
  if ((snap?.fieldCount || 0) >= 2 && filledCount >= 2) {
    return { recovered: false, plan: null, snap };
  }

  const { assessEndState, planNextAction } = getRuntime();
  if (typeof assessEndState === "function") {
    try {
      const assessment = await assessEndState({ snap, fillResult, history, context });
      if (assessment?.action && !["manual", "done", "wait_user"].includes(assessment.action)) {
        const plan = {
          type: assessment.action,
          target: assessment.target || "",
          reason: assessment.reason || "end-state recovery",
          source: "end-state-assessor",
        };
        log?.layer("agent", `end-state recovery → ${plan.type}: ${plan.reason}`, "warn");
        const executed = await executePlan(page, plan, {
          snap,
          context: context || {},
          log,
          url,
          sessionId,
          fillResult,
          history,
        });
        if (executed.ok) {
          return {
            recovered: true,
            plan,
            snap: executed.snap || (await inspectPage(page)),
            fillResult: executed.fillResult,
          };
        }
      }
    } catch (err) {
      log?.layer("agent", `end-state assessor error: ${err?.message || err}`, "warn");
    }
  }

  if (planNextAction && getSettings().agent_ai) {
    if (canUseStagehand(context || {}).ok) {
      const shPlan = buildStagehandPlan(
        snap,
        { step: "ambiguous", confidence: "low", reason: "final recovery before manual handoff" },
        history,
        context || {},
      );
      log?.layer("agent", `final Stagehand recovery → ${shPlan.instruction.slice(0, 80)}`, "warn");
      const executed = await executePlan(page, shPlan, {
        snap,
        context: context || {},
        log,
        url,
        sessionId,
        fillResult,
        history,
        classification: { step: "ambiguous", confidence: "low" },
      });
      if (executed.ok) {
        return {
          recovered: true,
          plan: shPlan,
          snap: executed.snap || (await inspectPage(page)),
          fillResult: executed.fillResult,
        };
      }
    }

    const aiPlan = await planNextAction(context, snap, history, fillResult, {
      step: "ambiguous",
      confidence: "low",
      reason: "final recovery before manual handoff",
    });
    if (aiPlan && !["wait_user", "done"].includes(aiPlan.type)) {
      log?.layer("agent", `final AI recovery → ${aiPlan.type}: ${aiPlan.reason}`, "warn");
      const executed = await executePlan(page, aiPlan, {
        snap,
        context: context || {},
        log,
        url,
        sessionId,
        fillResult,
        history,
      });
      if (executed.ok) {
        return {
          recovered: true,
          plan: aiPlan,
          snap: executed.snap || (await inspectPage(page)),
          fillResult: executed.fillResult,
        };
      }
    }
  }

  return { recovered: false, plan: null, snap };
}
