/**
 * Affordance-driven apply step classification — reads current page state, not action history.
 */
import { pageFingerprintFromSnap } from "../heuristics.js";
import { STEP_ACTIONS } from "./stepActions.js";
import { runClassifiers } from "./classify/index.js";

export { STEP_ACTIONS } from "./stepActions.js";

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

/**
 * Classify the current apply surface from a DOM snapshot.
 * @returns {{ step: string, confidence: "high"|"low", reason: string, target?: object|null, affordances: object }}
 */
export function classifyApplyStep(snap, fillResult, history = [], context = null) {
  const filled = fillResult?.filled?.length || 0;
  const affordances = applyAffordances(snap);
  const fp = pageFingerprintFromSnap(snap);
  const ctx = { snap, fillResult, filled, history, context, affordances, fingerprint: fp };
  return runClassifiers(ctx) || {
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
