import { initRuntime } from "../../src/runtime.js";

/** Fast, deterministic runtime defaults for fixture / agent tests. */
export function initTestRuntime(overrides = {}) {
  return initRuntime({
    settings: {
      browser_human_behavior: false,
      smart_fill_passes: 1,
      ai_fill_enabled: false,
      agent_enabled: true,
      agent_max_steps: 6,
      agent_ai: false,
      cloudflare_wait_enabled: false,
      listing_mode: false,
      ...(overrides.settings || {}),
    },
    buildFillConfig: overrides.buildFillConfig || (async () => ({})),
    resolveFileUpload: overrides.resolveFileUpload || (async () => ({ ok: false })),
    loadSiteMappings: overrides.loadSiteMappings || (() => ({})),
    planNextAction: overrides.planNextAction || null,
    answerUnfilledFields: overrides.answerUnfilledFields || null,
    onStatus: overrides.onStatus || null,
  });
}
