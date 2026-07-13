import { DEFAULT_SETTINGS } from "./defaults.js";
import {
  createLazyAssessEndState,
  createLazyPlanNextAction,
  createLazyValidateAction,
} from "./ai/runtimeHooks.js";
import { wrapCallLlmWithMetrics, resetLlmMetrics } from "./observability.js";

/** @type {import('./index.js').EngineRuntime | null} */
let _runtime = null;

/**
 * @param {Partial<import('./index.js').EngineOptions>} deps
 */
export function initRuntime(deps = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(deps.settings || {}) };
  const rawCallLlm = deps.callLlm || null;
  const callLlm = rawCallLlm ? wrapCallLlmWithMetrics(rawCallLlm) : null;
  resetLlmMetrics();
  _runtime = {
    settings,
    loadSiteMappings: deps.loadSiteMappings || (() => ({})),
    buildFillConfig: deps.buildFillConfig || (async () => ({})),
    resolveFileUpload: deps.resolveFileUpload || (async () => ({ ok: false })),
    callLlm,
    // Lazy AI defaults — no-op path when agent_ai / callLlm disabled; modules load on first use.
    planNextAction: deps.planNextAction || createLazyPlanNextAction(),
    validateAction: deps.validateAction || createLazyValidateAction(),
    assessEndState: deps.assessEndState || createLazyAssessEndState(),
    answerUnfilledFields: deps.answerUnfilledFields || null,
    onStatus: deps.onStatus || null,
  };
  return _runtime;
}

export function getRuntime() {
  if (!_runtime) initRuntime({});
  return _runtime;
}

export function getSettings() {
  return getRuntime().settings;
}
