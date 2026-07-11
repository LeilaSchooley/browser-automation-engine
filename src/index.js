import { initRuntime, getRuntime, getSettings } from "./runtime.js";
import { DEFAULT_SETTINGS } from "./defaults.js";
import { createLogger } from "./logger.js";
import { runPipeline, buildReadyMessage } from "./layers/runPipeline.js";
import { runAutomationAgent, runApplyAgent } from "./layers/automationAgent.js";
import { runSmartFill, splitName } from "./smartFill.js";
import { inspectPage, logPageSnapshot, pageFingerprint, progressScore, looksLikeApplyForm, applyAffordances } from "./layers/formDiscovery.js";
import { preparePageForApply } from "./layers/pagePrep.js";
import { classifyApplyStep, stepToPlan, STEP_ACTIONS } from "./layers/applyStep.js";
import {
  computeApplyOutcome,
  outcomeJobStatus,
  isStuck,
  shouldPreferUpload,
  uploadAlreadySucceeded,
} from "./heuristics.js";
import { loadSiteMappings, loadSiteMappingsFromPath } from "./siteMappings.js";
import { loadSiteLearnings, recordSiteLearning, learningsAsSiteMappings } from "./siteLearnings.js";
import {
  fieldHintsFromFilled,
  recordLearningsFromRun,
  recordPipelineOutcome,
  synthesizeLearningsFromRun,
  shouldRecordLearnings,
} from "./learningRecorder.js";
import { loadSiteAccounts, loadAccountForHost, resolveAccountForHost, saveAccountForHost } from "./accountStore.js";
import * as patterns from "./patterns/index.js";
import { resolveAuthSelectors } from "./layers/authActions.js";
import { allowsHostHop, normalizeHost, resolveHostMapping, targetHostFromContext } from "./host.js";
import { performGenericAct } from "./layers/domActions.js";
import { loadStorageState, saveStorageState, applyStorageStateToContext } from "./sessionStore.js";
import { looksLikeEmailVerifyWall, pollVerifyLink, attemptEmailVerify } from "./inboxVerify.js";
import { gotoWithCloudflareRetry, isCloudflarePage, waitForCloudflareClear } from "./cloudflare.js";
import { humanPause, humanGoto } from "./human.js";

/**
 * @typedef {Object} EngineOptions
 * @property {Record<string, unknown>} [settings]
 * @property {() => Record<string, unknown>} [loadSiteMappings]
 * @property {(context: unknown, opts: { sessionId?: string }) => Promise<Record<string, unknown>>} [buildFillConfig]
 * @property {(sessionId?: string, log?: unknown) => Promise<{ ok: boolean, path?: string, generated?: boolean }>} [resolveFileUpload]
 * @property {(context: unknown, snap: unknown, history: unknown[], fillResult: unknown, classification: unknown) => Promise<{ type: string, reason?: string, target?: string, source?: string } | null>} [planNextAction]
 * @property {(args: { plan: unknown, snapBefore: unknown, snapAfter: unknown, fillResult: unknown, mechanicalProgress: boolean, actorOk: boolean, history: unknown[], context: unknown, classification?: unknown, filledBefore?: number }) => Promise<{ progressed: boolean, reason?: string, source?: string }>} [validateAction]
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
  initRuntime(options);

  return {
    get settings() {
      return getSettings();
    },
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
    humanPause,
    humanGoto,
  };
}

export {
  DEFAULT_SETTINGS,
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
  buildReadyMessage,
  gotoWithCloudflareRetry,
  isCloudflarePage,
  waitForCloudflareClear,
  humanPause,
  humanGoto,
};

/** @deprecated use `patterns` */
export const authPatterns = patterns;
