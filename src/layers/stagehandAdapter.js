/**
 * Stagehand observe/act fallback — attaches to the same browser via CDP.
 * Shares the apply session's CDP endpoint (Playwright, AdsPower, Multilogin).
 */
import { getSettings } from "../runtime.js";
import { getPreferencesFromContext } from "../fillPreferences.js";

let stagehandInstance = null;
let stagehandInitFailed = false;
let stagehandInitError = "";
let stagehandCdpUrl = null;

/** Providers that only attach over CDP — never launch a separate browser. */
const CDP_ATTACH_PROVIDERS = new Set(["adspower", "multilogin", "playwright", "chromium"]);

function resolveStagehandModel(settings = {}) {
  const raw = String(settings.stagehand_model || process.env.STAGEHAND_MODEL || "").trim();
  if (raw.includes("/")) return raw;
  if (raw) return `openai/${raw}`;
  const openai = String(process.env.OPENAI_MODEL || "").trim();
  if (openai) return openai.includes("/") ? openai : `openai/${openai}`;
  const anthropic = String(process.env.ANTHROPIC_MODEL || "").trim();
  if (anthropic && process.env.ANTHROPIC_API_KEY) {
    return anthropic.includes("/") ? anthropic : `anthropic/${anthropic}`;
  }
  return "openai/gpt-4.1-mini";
}

async function loadStagehand() {
  if (stagehandInitFailed) return null;
  try {
    const mod = await import("@browserbasehq/stagehand");
    return mod.Stagehand || mod.default?.Stagehand || mod.default;
  } catch {
    stagehandInitFailed = true;
    return null;
  }
}

/**
 * Stagehand v3 must share the apply browser's CDP endpoint — passing a foreign
 * Playwright page without a matching V3Context causes init/act failures.
 */
export function canUseStagehand(context = {}) {
  if (!getSettings().stagehand_enabled) {
    return { ok: false, reason: "disabled" };
  }
  const provider = String(context.browserProvider || context.browser_provider || "playwright").toLowerCase();
  const cdpUrl = String(context.browserCdpUrl || context.browser_cdp_url || "").trim();
  if (!cdpUrl) {
    return { ok: false, reason: "no_cdp_url" };
  }
  if (!CDP_ATTACH_PROVIDERS.has(provider) && provider !== "playwright") {
    return { ok: false, reason: `unsupported_browser_provider:${provider}` };
  }
  return { ok: true, cdpUrl, provider };
}

async function getStagehand(context) {
  const gate = canUseStagehand(context);
  if (!gate.ok) return null;

  if (stagehandInstance && stagehandCdpUrl === gate.cdpUrl) {
    return stagehandInstance;
  }

  if (stagehandInstance) {
    await closeStagehand();
  }

  const Stagehand = await loadStagehand();
  if (!Stagehand) return null;

  const settings = getSettings();
  const model = resolveStagehandModel(settings);
  const opts = {
    env: "LOCAL",
    verbose: 0,
    modelName: model,
    model: model,
    localBrowserLaunchOptions: {
      cdpUrl: gate.cdpUrl,
    },
  };
  if (settings.stagehand_cache_enabled !== false) {
    opts.cacheDir = context?.stagehandCacheDir || undefined;
  }

  try {
    stagehandInstance = new Stagehand(opts);
    await stagehandInstance.init();
    stagehandCdpUrl = gate.cdpUrl;
    stagehandInitError = "";
    return stagehandInstance;
  } catch (err) {
    stagehandInitError = err.message || String(err);
    context?.log?.layer?.("stagehand", `init failed: ${stagehandInitError}`, "warn");
    return null;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {object} skill
 * @param {{ log?: object, context?: object }} [opts]
 */
export async function replayStagehandSkill(page, skill, log = null, opts = {}) {
  const context = opts.context || {};
  const gate = canUseStagehand(context);
  if (!gate.ok || !skill?.stagehandAction) return { ok: false, reason: gate.reason || "disabled" };

  const stagehand = await getStagehand(context);
  if (!stagehand) return { ok: false, reason: "not_available" };

  try {
    await stagehand.act(skill.stagehandAction, { page });
    log?.layer("stagehand", "replayed cached action", "info");
    return { ok: true };
  } catch (err) {
    log?.layer("stagehand", `cached replay failed: ${err.message}`, "warn");
    return { ok: false, reason: err.message };
  }
}

/**
 * General observe/act for navigation or custom controls.
 * @param {import('playwright').Page} page
 * @param {object} context
 * @param {{ instruction?: string, log?: object, variables?: object }} [opts]
 */
export async function attemptStagehandAct(page, context, opts = {}) {
  const log = opts.log || null;
  const gate = canUseStagehand(context);
  if (!gate.ok) {
    return { ok: false, reason: gate.reason };
  }

  const stagehand = await getStagehand(context);
  if (!stagehand) {
    const reason = stagehandInitError || (stagehandInitFailed ? "load_failed" : "init_failed");
    log?.layer("stagehand", `not available (${reason}) — skip`, "debug");
    return { ok: false, reason };
  }

  const instruction = String(opts.instruction || "").trim();
  if (!instruction) {
    return { ok: false, reason: "no_instruction" };
  }

  const variables = { ...(opts.variables || {}) };

  try {
    const observeOpts = { page };
    if (Object.keys(variables).some((k) => variables[k])) {
      observeOpts.variables = variables;
    }
    const actions = await stagehand.observe(instruction, observeOpts);
    const action = Array.isArray(actions) ? actions[0] : actions;
    if (action) {
      await stagehand.act(action, { page });
      log?.layer("stagehand", `act via observe: ${instruction.slice(0, 80)}`, "info");
      return { ok: true, action, instruction, source: "stagehand" };
    }
    await stagehand.act(instruction, { page, variables });
    log?.layer("stagehand", `act direct: ${instruction.slice(0, 80)}`, "info");
    return { ok: true, instruction, source: "stagehand" };
  } catch (err) {
    log?.layer("stagehand", `failed: ${err.message}`, "warn");
    return { ok: false, reason: err.message };
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {object} context
 * @param {{ instruction?: string, log?: object, variables?: object }} [opts]
 */
export async function attemptStagehandFill(page, context, opts = {}) {
  const log = opts.log || null;
  const prefs = getPreferencesFromContext(context);
  const instruction =
    opts.instruction ||
    (prefs.salary
      ? `In the open modal, open Salary expectations and select the band closest to ${prefs.salary}`
      : "Fill any empty required fields in the current modal");

  const result = await attemptStagehandAct(page, context, {
    instruction,
    log,
    variables: { salary: prefs.salary || "", ...opts.variables },
  });

  if (!result.ok) return result;

  return {
    ok: true,
    action: result.action,
    label: "salary expectations",
    mappedTo: "salary",
    source: "stagehand",
  };
}

export async function closeStagehand() {
  if (stagehandInstance) {
    try {
      await stagehandInstance.close();
    } catch {
      /* ignore */
    }
    stagehandInstance = null;
    stagehandCdpUrl = null;
  }
  stagehandInitFailed = false;
  stagehandInitError = "";
}
