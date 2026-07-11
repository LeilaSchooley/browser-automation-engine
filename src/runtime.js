import { DEFAULT_SETTINGS } from "./defaults.js";

/** @type {import('./index.js').EngineRuntime | null} */
let _runtime = null;

/**
 * @param {Partial<import('./index.js').EngineOptions>} deps
 */
export function initRuntime(deps = {}) {
  _runtime = {
    settings: { ...DEFAULT_SETTINGS, ...(deps.settings || {}) },
    loadSiteMappings: deps.loadSiteMappings || (() => ({})),
    buildFillConfig: deps.buildFillConfig || (async () => ({})),
    resolveFileUpload: deps.resolveFileUpload || (async () => ({ ok: false })),
    planNextAction: deps.planNextAction || null,
    validateAction: deps.validateAction || null,
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
