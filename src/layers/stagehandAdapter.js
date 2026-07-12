/**
 * Stagehand observe/act fallback — uses existing Playwright page via { page }.
 * Lazy-loaded; engine runs without @browserbasehq/stagehand installed.
 */
import { getSettings } from "../runtime.js";
import { getPreferencesFromContext } from "../fillPreferences.js";

let stagehandInstance = null;
let stagehandInitFailed = false;

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

async function getStagehand(context) {
  if (stagehandInstance) return stagehandInstance;
  const Stagehand = await loadStagehand();
  if (!Stagehand) return null;

  const settings = getSettings();
  const opts = {
    env: "LOCAL",
    verbose: 0,
  };
  if (settings.stagehand_model) {
    opts.modelName = settings.stagehand_model;
    opts.model = settings.stagehand_model;
  }
  if (settings.stagehand_cache_enabled !== false) {
    opts.cacheDir = context?.stagehandCacheDir || undefined;
  }

  try {
    stagehandInstance = new Stagehand(opts);
    await stagehandInstance.init();
    return stagehandInstance;
  } catch {
    stagehandInitFailed = true;
    return null;
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {object} skill
 * @param {{ log?: object }} [opts]
 */
export async function replayStagehandSkill(page, skill, log = null) {
  if (!getSettings().stagehand_enabled || !skill?.stagehandAction) return { ok: false };
  const stagehand = await getStagehand({});
  if (!stagehand) return { ok: false };
  try {
    await stagehand.act(skill.stagehandAction, { page });
    log?.layer("stagehand", "replayed cached action", "info");
    return { ok: true };
  } catch (err) {
    log?.layer("stagehand", `cached replay failed: ${err.message}`, "warn");
    return { ok: false };
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {object} context
 * @param {{ instruction?: string, log?: object, variables?: object }} [opts]
 */
export async function attemptStagehandFill(page, context, opts = {}) {
  const log = opts.log || null;
  if (!getSettings().stagehand_enabled) {
    return { ok: false, reason: "disabled" };
  }

  const stagehand = await getStagehand(context);
  if (!stagehand) {
    log?.layer("stagehand", "package not available — skip", "debug");
    return { ok: false, reason: "not_installed" };
  }

  const prefs = getPreferencesFromContext(context);
  const instruction =
    opts.instruction ||
    (prefs.salary
      ? `In the open modal, open Salary expectations and select the band closest to ${prefs.salary}`
      : "Fill any empty required fields in the current modal");

  const variables = { salary: prefs.salary || "", ...opts.variables };

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
      return {
        ok: true,
        action,
        label: "salary expectations",
        mappedTo: "salary",
        source: "stagehand",
      };
    }
    await stagehand.act(instruction, { page, variables });
    log?.layer("stagehand", `act direct: ${instruction.slice(0, 80)}`, "info");
    return { ok: true, label: "custom", mappedTo: "salary", source: "stagehand" };
  } catch (err) {
    log?.layer("stagehand", `failed: ${err.message}`, "warn");
    return { ok: false, reason: err.message };
  }
}

export async function closeStagehand() {
  if (stagehandInstance) {
    try {
      await stagehandInstance.close();
    } catch {
      /* ignore */
    }
    stagehandInstance = null;
  }
}
