import { CORE_DEFAULT_SETTINGS, DEFAULT_SETTINGS } from "./defaults.js";
import {
  createLazyAssessEndState,
  createLazyPlanNextAction,
  createLazyValidateAction,
} from "./ai/runtimeHooks.js";
import { wrapCallLlmWithMetrics, resetLlmMetrics } from "./observability.js";
import { DEFAULT_PROFILE, isProfile } from "./core/profile.js";

/** @type {import('./index.js').EngineRuntime | null} */
let _runtime = null;

/**
 * @param {Partial<import('./index.js').EngineOptions>} deps
 */
export function initRuntime(deps = {}) {
  const profile = deps.profile == null ? DEFAULT_PROFILE : deps.profile;
  if (!isProfile(profile)) {
    throw new TypeError(
      "initRuntime profile must be a profile descriptor; use createEngine() for named profiles",
    );
  }
  const baseSettings =
    profile.name === DEFAULT_PROFILE.name
      ? DEFAULT_SETTINGS
      : CORE_DEFAULT_SETTINGS;
  const settings = {
    ...baseSettings,
    ...profile.settings,
    ...(deps.settings || {}),
  };
  const rawCallLlm = deps.callLlm || null;
  const callLlm = rawCallLlm ? wrapCallLlmWithMetrics(rawCallLlm) : null;
  resetLlmMetrics();
  _runtime = {
    profile,
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
    answerChoiceFields: deps.answerChoiceFields || null,
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
