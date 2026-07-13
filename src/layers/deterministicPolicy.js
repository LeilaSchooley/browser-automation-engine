/**
 * Deterministic-first policy: handle common flows without LLM.
 */
import { hasPreferencesGateFields, preferencesGateIncomplete } from "../fillPreferences.js";
import { hasIdentityRegistrationFields } from "../fillProfile.js";
import { shouldNeverDismiss } from "../workflowGates.js";
import { recentPreferencesSignup, preferencesSignupSubmitted, looksLikeJobBoardIndex, pageFingerprintFromSnap } from "../heuristics.js";
import {
  consentFailedTwice,
  looksLikeRealCookieConsent,
} from "../consentDetection.js";

/** True when recent smart_fill steps made no progress (same step or preferences gate). */
export function smartFillStalledOnStep(history = [], classification = null) {
  const recent = (history || []).filter((h) => h?.action === "smart_fill").slice(-3);
  if (recent.length < 2) return false;
  if (!recent.every((h) => !h.progress)) return false;
  const step = classification?.step || classification?.applyStep || "form";
  const onSameStep = recent.every((h) => !h.applyStep || h.applyStep === step || h.step === classification?.step);
  return onSameStep;
}

/**
 * Whether the current state is unambiguous enough for deterministic action.
 * @param {object} classification
 * @param {object} snap
 * @param {object} [pageState]
 * @param {object[]} [history]
 */
export function isDeterministicState(classification, snap, pageState = null, history = []) {
  const step = classification?.step || "";
  const confidence = classification?.confidence || "medium";

  if (["loading", "blocked", "upload", "verify_email"].includes(step)) return true;

  if (step === "consent") {
    const fp = classification?.fingerprint || pageFingerprintFromSnap(snap);
    if (consentFailedTwice(history, fp)) return false;
    if (confidence !== "high") return false;
    return looksLikeRealCookieConsent(snap);
  }

  if (step === "overlay" && confidence !== "low" && !shouldNeverDismiss(snap)) {
    if (preferencesSignupSubmitted(history) || recentPreferencesSignup(history)) return false;
    const modalInteractives = (snap?.interactives || []).filter((i) => i.inModal || i.inDialog);
    if (modalInteractives.length > 1) return false;
    return true;
  }
  if (step === "entry" && confidence === "high" && (snap?.entryCount || 0) === 1) return true;
  if (step === "continue" && confidence === "high") return true;
  if (step === "wizard_choice" && confidence !== "low") return true;

  if (pageState?.uiPhase === "option_selected_uncommitted") return true;
  if (pageState?.uiPhase === "ready_to_continue" && step === "continue") return true;

  if (hasPreferencesGateFields(snap) && preferencesGateIncomplete(snap)) {
    if (looksLikeJobBoardIndex(snap)) return false;
    const recentSmartFill = (history || [])
      .filter((h) => h?.action === "smart_fill")
      .slice(-3);
    if (recentSmartFill.length >= 2 && recentSmartFill.every((h) => !h.progress)) {
      return false;
    }
    if (confidence === "low") return false;
    return true;
  }
  if (hasIdentityRegistrationFields(snap) || (snap?.pageKind === "auth" && (snap?.fieldCount || 0) > 0)) return true;

  return false;
}

/**
 * Build a deterministic plan without LLM for unambiguous states.
 * @param {object} classification
 * @param {object} snap
 * @param {object} [pageState]
 */
export function buildDeterministicPlan(classification, snap, pageState = null) {
  const step = classification?.step || "";
  const reason = classification?.reason || "";

  if (pageState?.uiPhase === "option_selected_uncommitted") {
    const confirm = pageState.pendingCommits?.[0] || "Save";
    return {
      type: "act",
      action: "click",
      target: confirm,
      reason: "selection made but not committed — click confirm",
      source: "deterministic-policy",
      confidence: "high",
      step: classification?.step,
    };
  }

  if (hasPreferencesGateFields(snap) && preferencesGateIncomplete(snap)) {
    if (looksLikeJobBoardIndex(snap)) return null;
    return {
      type: "smart_fill",
      reason: "preferences gate — fill location, title, and salary",
      source: "deterministic-policy",
      confidence: "high",
      step: "form",
    };
  }

  if (hasIdentityRegistrationFields(snap)) {
    return {
      type: "smart_fill",
      reason: "registration form — fill identity fields",
      source: "deterministic-policy",
      confidence: "high",
      step: "signup",
    };
  }

  const actionMap = {
    loading: "wait_load",
    overlay: "dismiss_overlay",
    consent: "accept_cookies",
    entry: "click_apply",
    wizard_choice: "click_modal",
    upload: "upload_resume",
    continue: "click_continue",
    form: "smart_fill",
    auth: "auth_login",
    signup: "auth_signup",
    signup_entry: "click_signup",
    obstacle: "clear_obstacle",
    verify_email: "verify_email",
    nav_recovery: "nav_recovery",
    review: "done",
    blocked: "wait_user",
  };

  const type = actionMap[step];
  if (!type) return null;

  return {
    type,
    reason,
    target: classification?.target,
    targetCandidate: classification?.target,
    confidence: classification?.confidence || "high",
    step,
    source: "deterministic-policy",
  };
}

/**
 * Whether LLM should be invoked for this state.
 * @param {object} classification
 * @param {object} snap
 * @param {object} [pageState]
 * @param {object[]} [history]
 */
export function shouldInvokeLlm(classification, snap, pageState = null, history = []) {
  const fp = classification?.fingerprint || pageFingerprintFromSnap(snap);
  if (smartFillStalledOnStep(history, classification)) return true;
  if (classification?.step === "consent") {
    if (consentFailedTwice(history, fp)) return true;
    if (classification?.confidence !== "high") return true;
  }
  if (isDeterministicState(classification, snap, pageState, history)) return false;
  if (classification?.step === "ambiguous") return true;
  if (classification?.confidence === "low") return true;
  if (classification?.step === "overlay") {
    const modalInteractives = (snap?.interactives || []).filter((i) => i.inModal || i.inDialog);
    if (modalInteractives.length > 1) return true;
  }
  if ((snap?.entryCount || 0) > 3 && classification?.step === "entry") return true;
  if ((snap?.continueCount || 0) > 2 && classification?.step === "continue") return true;
  return true;
}
