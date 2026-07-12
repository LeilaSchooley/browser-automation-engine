import { DEFAULT_SETTINGS } from "./defaults.js";
import { planNextAction as defaultPlanNextAction } from "./layers/agentPlan.js";
import {
  validateActionOutcome as defaultValidateAction,
  assessAgentEndState as defaultAssessEndState,
} from "./layers/actionValidator.js";

/** @type {import('./index.js').EngineRuntime | null} */
let _runtime = null;

/**
 * @param {Partial<import('./index.js').EngineOptions>} deps
 */
export function initRuntime(deps = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...(deps.settings || {}) };
  _runtime = {
    settings,
    loadSiteMappings: deps.loadSiteMappings || (() => ({})),
    buildFillConfig: deps.buildFillConfig || (async () => ({})),
    resolveFileUpload: deps.resolveFileUpload || (async () => ({ ok: false })),
    callLlm: deps.callLlm || null,
    // Defaults always wired; they no-op without agent_ai / callLlm / action_validator.
    planNextAction: deps.planNextAction || defaultPlanNextAction,
    validateAction: deps.validateAction || defaultValidateAction,
    assessEndState: deps.assessEndState || defaultAssessEndState,
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
