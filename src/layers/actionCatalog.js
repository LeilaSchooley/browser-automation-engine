/**
 * Action-driven catalog — all plausible next moves from a page snapshot.
 * Replaces rigid step-type branching as the primary decision input.
 */
import { isPageUnloaded } from "./pageReady.js";
import { looksLikeAuthForm } from "./authActions.js";
import { looksLikeSignupForm, looksLikeSignupEntry } from "./signupActions.js";
import { hasPreferencesGateFields, preferencesGateIncomplete } from "../fillPreferences.js";
import { hasIdentityRegistrationFields } from "../fillProfile.js";
import { shouldNeverDismiss } from "../workflowGates.js";
import { looksLikeRealCookieConsent } from "../consentDetection.js";
import {
  applyEntrySucceeded,
  countRecentAction,
  hasUnfilledApplicationFields,
  looksLikeInlineApplicationForm,
  looksLikeJobBoardIndex,
  shouldPreferUpload,
  uploadAlreadySucceeded,
  uploadStalled,
} from "../heuristics.js";
import { buildStagehandInstruction } from "./stagehandPolicy.js";
import { canUseStagehand } from "./stagehandAdapter.js";

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

  if (classification?.step === "blocked" || classification?.hardStop) {
    return [{ id: "wait_user", type: "wait_user", score: 100, reason: classification?.reason || "blocked" }];
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

  if (looksLikeJobBoardIndex(snap)) {
    actions.push({
      id: "stagehand_job_board",
      type: "stagehand_act",
      score: 95,
      reason: "navigate job board — pick matching listing",
      instruction: buildStagehandInstruction(snap, classification || { step: "entry" }, history, context),
      step: "entry",
    });
    for (const c of (snap.entryCandidates || []).slice(0, 2)) {
      actions.push({
        id: `click_apply_${c.text || "entry"}`,
        type: "click_apply",
        score: (c.score || 50) - 10,
        reason: `listing CTA: ${c.text || "Apply"}`,
        targetCandidate: c,
        step: "entry",
      });
    }
  } else if ((snap.entryCount || 0) > 0 && !applyEntrySucceeded(history, fp)) {
    const top = snap.entryCandidates?.[0];
    actions.push({
      id: "click_apply",
      type: "click_apply",
      score: top?.score || 70,
      reason: `apply CTA: ${top?.text || "Apply"}`,
      targetCandidate: top || null,
      step: "entry",
    });
  }

  if (looksLikeAuthForm(snap)) {
    actions.push({ id: "auth_login", type: "auth_login", score: 88, reason: "auth login form", step: "auth" });
  }
  if (looksLikeSignupForm(snap) || hasIdentityRegistrationFields(snap)) {
    actions.push({ id: "auth_signup", type: "auth_signup", score: 86, reason: "registration form", step: "signup" });
    actions.push({ id: "smart_fill_signup", type: "smart_fill", score: 84, reason: "fill registration fields", step: "signup" });
  }
  if (looksLikeSignupEntry(snap)) {
    actions.push({ id: "click_signup", type: "click_signup", score: 72, reason: "signup entry CTA", step: "signup_entry" });
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
    let fillScore = 72;
    if (inlineForm) fillScore += 20;
    if (uploadFailed) fillScore += 25;
    if (unfilledYesNo) fillScore += 15;
    if (filled === 0) fillScore += 10;
    actions.push({
      id: "smart_fill",
      type: "smart_fill",
      score: fillScore,
      reason: inlineForm ? "fill inline application fields" : "fill visible form fields",
      step: "form",
    });
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
      actions.push({
        id: "click_continue",
        type: "click_continue",
        score: 58,
        reason: `continue: ${top.text || "Next"}`,
        targetCandidate: top,
        step: "continue",
      });
    }
  }

  if (classification?.step === "ambiguous" && canUseStagehand(context).ok) {
    actions.push({
      id: "stagehand_ambiguous",
      type: "stagehand_act",
      score: 68,
      reason: "ambiguous page — semantic next step",
      instruction: buildStagehandInstruction(snap, classification, history, context),
      step: "ambiguous",
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
