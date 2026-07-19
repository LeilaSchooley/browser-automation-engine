import { initRuntime, getRuntime, getSettings } from "./runtime.js";
import {
  CORE_DEFAULT_SETTINGS,
  DEFAULT_SETTINGS,
  LEGACY_PROFILE_SETTINGS,
} from "./defaults.js";
import { createLogger } from "./logger.js";
import { runPipeline, buildReadyMessage } from "./layers/runPipeline.js";
import { runAutomationAgent, runApplyAgent } from "./layers/automationAgent.js";
import { runSmartFill, splitName } from "./smartFill.js";
import {
  sortApplyFields,
  isJobApplicationField,
  detectRequiredUnfilled,
  buildRequiredFieldsInstruction,
} from "./fieldMapper.js";
import { inspectPage, logPageSnapshot, pageFingerprint, progressScore, looksLikeApplyForm, applyAffordances } from "./layers/formDiscovery.js";
import { preparePageForApply } from "./layers/pagePrep.js";
import { classifyApplyStep, stepToPlan, STEP_ACTIONS } from "./layers/applyStep.js";
import {
  computeApplyOutcome,
  outcomeJobStatus,
  isStuck,
  shouldPreferUpload,
  uploadAlreadySucceeded,
  dismissLoopStalled,
  actionLoopStalled,
  continueLoopStalled,
  isResumeReviewUpsell,
  boardLeaveSucceeded,
  shouldBlockBoardSignupAfterLeave,
} from "./heuristics.js";
import { loadSiteMappings, loadSiteMappingsFromPath } from "./siteMappings.js";
import {
  loadSiteLearnings,
  recordSiteLearning,
  learningsAsSiteMappings,
  findRelevantSkills,
  mergeSituationSkills,
  seedSituationSkillsForHost,
} from "./siteLearnings.js";
import {
  fieldHintsFromFilled,
  recordLearningsFromRun,
  recordPipelineOutcome,
  synthesizeLearningsFromRun,
  shouldRecordLearnings,
  reflectFromHistory,
} from "./learningRecorder.js";
import { loadSiteAccounts, loadAccountForHost, resolveAccountForHost, saveAccountForHost } from "./accountStore.js";
import * as patterns from "./patterns/index.js";
import { resolveAuthSelectors } from "./layers/authActions.js";
import { allowsHostHop, normalizeHost, resolveHostMapping, targetHostFromContext } from "./host.js";
import { performGenericAct } from "./layers/domActions.js";
import { loadStorageState, saveStorageState, applyStorageStateToContext } from "./sessionStore.js";
import { looksLikeEmailVerifyWall, pollVerifyLink, attemptEmailVerify } from "./inboxVerify.js";
import {
  provideManualVerifyLink,
  cancelManualVerifyLink,
  hasPendingManualVerifyLink,
  isImapConfigured,
  normalizeVerifyLink,
} from "./manualVerifyLink.js";
import {
  provideManualVerifyCode,
  cancelManualVerifyCode,
  hasPendingManualVerifyCode,
  normalizeVerifyCode,
  waitForManualVerifyCode,
} from "./manualVerifyCode.js";
import { looksLikeOtpWall, pollVerifyCode, attemptOtpEntry } from "./inboxOtp.js";
import { generateTotpCode, resolveTotpCode } from "./totp.js";
import { gotoWithCloudflareRetry, isCloudflarePage, waitForCloudflareClear } from "./cloudflare.js";
import {
  detectCaptcha,
  waitForCaptchaClear,
  looksLikeCaptchaInSnap,
  looksLikeCaptchaReason,
  CAPTCHA_SELECTORS,
} from "./captchaDetect.js";
import { humanPause, humanGoto } from "./human.js";
import { planNextAction, buildPageState } from "./layers/agentPlan.js";
import { buildAgentContext } from "./layers/agentContext.js";
import {
  decideWithActionBrain,
  planNextActionOmni,
  resolveActionBrainMode,
  shouldAttachVision,
  preferIndexedAct,
} from "./layers/actionBrain.js";
import { appendRunHistory, loadRecentRuns, loadSimilarRuns, trailFingerprint } from "./runHistory.js";
import {
  enqueueSkillProposal,
  listSkillProposals,
  applyApprovedSkillProposals,
  setSkillProposalStatus,
} from "./skillProposals.js";
import { RecoveryTracker, recoveryEscalateFromHistory } from "./recoveryTracker.js";
import { isEmployerAtsUrl, isBoardOnboardUrl } from "./layers/applyUrlSafety.js";
import { resolveDialogScope } from "./layers/dialogScope.js";
import {
  validateActionOutcome,
  assessAgentEndState,
  computeMechanicalSignals,
  isStrongMechanicalProgress,
  shouldRunValidator,
  parseValidatorResponse,
  parseEndStateResponse,
  normalizeRecoveryAction,
  isLikelyNoopClick,
} from "./layers/actionValidator.js";
import { tryAdoptFormIframe } from "./layers/iframeAdopt.js";
import { isQueueableApplyUrl } from "./layers/applyUrlSafety.js";
import {
  classifyApplyUrlHealth,
  looksLikeScrapedMirrorUrl,
  probeApplyUrlReachability,
  probeClosedJobListing,
} from "./layers/applyUrlHealth.js";
import {
  parseSalaryFromText,
  parseSalaryNumbers,
  pickClosestSalaryOption,
  resolveSalaryExpectation,
} from "./salaryExpectation.js";
import { buildDeterministicPlan, shouldInvokeLlm, isDeterministicState, smartFillStalledOnStep } from "./layers/deterministicPolicy.js";
import { buildPagePerception, computePageDiff } from "./layers/pagePerception.js";
import { recordEngineEvent, getLlmMetrics } from "./observability.js";
import { mapLabelToMapped } from "./primitives/controlPatterns.js";
import {
  escapeRegExp,
  normalizeRoleName,
  roleNameMatcher,
  safeLabelLocator,
  safeRoleLocator,
  safeTextLocator,
  shouldExactMatchName,
} from "./primitives/safeLocator.js";
import { readControlValue, verifyCommitted, interactWidget } from "./primitives/interactWidget.js";
import { refreshSnapIfNeeded } from "./layers/pagePerception.js";
import { loadAiLayers } from "./ai/runtimeHooks.js";
import { prepareWorkingPage, pruneExtraPages, isBlankOrNewTabUrl } from "./layers/tabHygiene.js";
import {
  attachNetworkSkillCapture,
  findApiSkill,
  loadApiSkills,
  saveApiSkill,
  tryDirectoryApiFastPath,
  tryUnbrowseHole,
} from "./networkSkills.js";
import { observeStagehandCandidates } from "./layers/stagehandAdapter.js";
import { recoveryToPlanType } from "./layers/semanticRecovery.js";
import { createAgentCore, runAgentCore } from "./core/agentLoop.js";
import { defineProfile, extendProfile, isProfile } from "./core/profile.js";
import {
  APPLY_PROFILE,
  DIRECTORY_PROFILE,
  GENERIC_PROFILE,
  LEGACY_PROFILE,
  PROFILES,
  resolveProfile,
} from "./profiles/index.js";

/**
 * @typedef {Object} EngineOptions
 * @property {string | object} [profile]
 * @property {Record<string, unknown>} [settings]
 * @property {() => Record<string, unknown>} [loadSiteMappings]
 * @property {(context: unknown, opts: { sessionId?: string }) => Promise<Record<string, unknown>>} [buildFillConfig]
 * @property {(sessionId?: string, log?: unknown) => Promise<{ ok: boolean, path?: string, generated?: boolean }>} [resolveFileUpload]
 * @property {(prompt: string | unknown, opts?: { imageBase64?: string }) => Promise<string | null>} [callLlm]
 * @property {(context: unknown, snap: unknown, history: unknown[], fillResult: unknown, classification: unknown) => Promise<{ type: string, reason?: string, target?: string, source?: string } | null>} [planNextAction]
 * @property {(args: { plan: unknown, snapBefore: unknown, snapAfter: unknown, fillResult: unknown, mechanicalProgress: boolean, actorOk: boolean, history: unknown[], context: unknown, classification?: unknown, filledBefore?: number }) => Promise<{ progressed: boolean, reason?: string, recovery?: string, source?: string }>} [validateAction]
 * @property {(args: { snap: unknown, fillResult: unknown, history: unknown[], context: unknown }) => Promise<{ action: string, target?: string, reason?: string }>} [assessEndState]
 * @property {(context: unknown, opts: { unfilled: unknown[], sessionId?: string }) => Promise<Record<string, string>>} [answerUnfilledFields]
 * @property {(sessionId: string, payload: Record<string, unknown>) => void} [onStatus]
 */

/**
 * @typedef {ReturnType<typeof initRuntime>} EngineRuntime
 */

/**
 * Create a configured browser automation engine instance.
 * @param {EngineOptions} options
 */
export function createEngine(options = {}) {
  const profile = resolveProfile(options.profile);
  const runtime = initRuntime({ ...options, profile });

  return {
    get profile() {
      return runtime.profile;
    },
    get capabilities() {
      return runtime.profile.capabilities;
    },
    get settings() {
      return getSettings();
    },
    /** Create a domain-neutral loop using this engine's active profile metadata. */
    createAgent: (adapter = {}) =>
      createAgentCore({
        ...adapter,
        profile: adapter.profile || runtime.profile,
      }),
    /** Run with the active profile's entry language and settings. */
    run: (page, opts = {}) =>
      runPipeline(page, {
        entryLabel: runtime.profile.entryLabel,
        ...opts,
      }),
    /** Apply-oriented pipeline alias — apps set listing_mode/auto_submit via createEngine settings. */
    apply: (page, opts = {}) => runPipeline(page, { entryLabel: "Apply", ...opts }),
    runPipeline,
    runAutomationAgent,
    runApplyAgent,
    runSmartFill,
    inspectPage,
    preparePageForApply,
    createLogger,
    buildReadyMessage,
    classifyApplyStep,
    stepToPlan,
    computeApplyOutcome,
    outcomeJobStatus,
    loadSiteMappings,
    loadSiteLearnings,
    recordSiteLearning,
    recordLearningsFromRun,
    recordPipelineOutcome,
    synthesizeLearningsFromRun,
    fieldHintsFromFilled,
    loadSiteAccounts,
    loadAccountForHost,
    resolveAccountForHost,
    loadStorageState,
    saveStorageState,
    applyStorageStateToContext,
    gotoWithCloudflareRetry,
    isCloudflarePage,
    waitForCloudflareClear,
    detectCaptcha,
    waitForCaptchaClear,
    looksLikeCaptchaInSnap,
    looksLikeCaptchaReason,
    humanPause,
    humanGoto,
    provideManualVerifyLink,
    cancelManualVerifyLink,
    hasPendingManualVerifyLink,
    isImapConfigured,
    normalizeVerifyLink,
    provideManualVerifyCode,
    cancelManualVerifyCode,
    hasPendingManualVerifyCode,
    normalizeVerifyCode,
  };
}

export function createProfileEngine(profile, options = {}) {
  return createEngine({ ...options, profile: resolveProfile(profile) });
}

export function createApplyEngine(options = {}) {
  return createProfileEngine(APPLY_PROFILE, options);
}

export function createDirectoryEngine(options = {}) {
  return createProfileEngine(DIRECTORY_PROFILE, options);
}

export function createGenericEngine(options = {}) {
  return createProfileEngine(GENERIC_PROFILE, options);
}

export {
  DEFAULT_SETTINGS,
  CORE_DEFAULT_SETTINGS,
  LEGACY_PROFILE_SETTINGS,
  APPLY_PROFILE,
  DIRECTORY_PROFILE,
  GENERIC_PROFILE,
  LEGACY_PROFILE,
  PROFILES,
  resolveProfile,
  defineProfile,
  extendProfile,
  isProfile,
  createAgentCore,
  runAgentCore,
  initRuntime,
  getRuntime,
  getSettings,
  createLogger,
  runPipeline,
  runAutomationAgent,
  runApplyAgent,
  runSmartFill,
  splitName,
  inspectPage,
  logPageSnapshot,
  pageFingerprint,
  progressScore,
  looksLikeApplyForm,
  applyAffordances,
  preparePageForApply,
  classifyApplyStep,
  stepToPlan,
  STEP_ACTIONS,
  computeApplyOutcome,
  outcomeJobStatus,
  isStuck,
  dismissLoopStalled,
  actionLoopStalled,
  continueLoopStalled,
  isResumeReviewUpsell,
  shouldPreferUpload,
  uploadAlreadySucceeded,
  loadSiteMappings,
  loadSiteMappingsFromPath,
  loadSiteLearnings,
  recordSiteLearning,
  learningsAsSiteMappings,
  recordLearningsFromRun,
  recordPipelineOutcome,
  synthesizeLearningsFromRun,
  fieldHintsFromFilled,
  shouldRecordLearnings,
  sortApplyFields,
  isJobApplicationField,
  detectRequiredUnfilled,
  buildRequiredFieldsInstruction,
  loadSiteAccounts,
  loadAccountForHost,
  resolveAccountForHost,
  saveAccountForHost,
  resolveAuthSelectors,
  patterns,
  allowsHostHop,
  normalizeHost,
  performGenericAct,
  resolveHostMapping,
  targetHostFromContext,
  loadStorageState,
  saveStorageState,
  applyStorageStateToContext,
  looksLikeEmailVerifyWall,
  pollVerifyLink,
  attemptEmailVerify,
  provideManualVerifyLink,
  cancelManualVerifyLink,
  hasPendingManualVerifyLink,
  isImapConfigured,
  normalizeVerifyLink,
  provideManualVerifyCode,
  cancelManualVerifyCode,
  hasPendingManualVerifyCode,
  normalizeVerifyCode,
  waitForManualVerifyCode,
  looksLikeOtpWall,
  pollVerifyCode,
  attemptOtpEntry,
  generateTotpCode,
  resolveTotpCode,
  buildReadyMessage,
  gotoWithCloudflareRetry,
  isCloudflarePage,
  waitForCloudflareClear,
  detectCaptcha,
  waitForCaptchaClear,
  looksLikeCaptchaInSnap,
  looksLikeCaptchaReason,
  CAPTCHA_SELECTORS,
  humanPause,
  humanGoto,
  planNextAction,
  buildPageState,
  buildAgentContext,
  decideWithActionBrain,
  planNextActionOmni,
  resolveActionBrainMode,
  shouldAttachVision,
  preferIndexedAct,
  findRelevantSkills,
  mergeSituationSkills,
  seedSituationSkillsForHost,
  appendRunHistory,
  loadRecentRuns,
  loadSimilarRuns,
  trailFingerprint,
  enqueueSkillProposal,
  listSkillProposals,
  applyApprovedSkillProposals,
  setSkillProposalStatus,
  RecoveryTracker,
  recoveryEscalateFromHistory,
  isEmployerAtsUrl,
  isBoardOnboardUrl,
  boardLeaveSucceeded,
  shouldBlockBoardSignupAfterLeave,
  resolveDialogScope,
  validateActionOutcome,
  assessAgentEndState,
  computeMechanicalSignals,
  isStrongMechanicalProgress,
  shouldRunValidator,
  parseValidatorResponse,
  parseEndStateResponse,
  tryAdoptFormIframe,
  parseSalaryFromText,
  parseSalaryNumbers,
  pickClosestSalaryOption,
  resolveSalaryExpectation,
  isQueueableApplyUrl,
  looksLikeScrapedMirrorUrl,
  probeApplyUrlReachability,
  classifyApplyUrlHealth,
  probeClosedJobListing,
  buildDeterministicPlan,
  shouldInvokeLlm,
  isDeterministicState,
  smartFillStalledOnStep,
  buildPagePerception,
  computePageDiff,
  recordEngineEvent,
  getLlmMetrics,
  mapLabelToMapped,
  readControlValue,
  verifyCommitted,
  interactWidget,
  refreshSnapIfNeeded,
  loadAiLayers,
  prepareWorkingPage,
  pruneExtraPages,
  isBlankOrNewTabUrl,
  attachNetworkSkillCapture,
  findApiSkill,
  loadApiSkills,
  saveApiSkill,
  tryDirectoryApiFastPath,
  tryUnbrowseHole,
  escapeRegExp,
  normalizeRoleName,
  roleNameMatcher,
  safeLabelLocator,
  safeRoleLocator,
  safeTextLocator,
  shouldExactMatchName,
  observeStagehandCandidates,
  normalizeRecoveryAction,
  isLikelyNoopClick,
  reflectFromHistory,
  recoveryToPlanType,
};

export {
  AgentPlanSchema,
  ValidatorResponseSchema,
  EndStateResponseSchema,
  GENERIC_ACTIONS,
  HIGH_LEVEL_ACTIONS,
  parseJsonFromLlm,
} from "./ai/contracts.js";
export { loadOptionalSharedContracts } from "./ai/sharedBridge.js";

/** @deprecated use `patterns` */
export const authPatterns = patterns;
