import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getRuntime, getSettings } from "./runtime.js";
import { loadSiteMappings } from "./siteMappings.js";
import { humanPause, humanType } from "./human.js";
import { fillCustomControls } from "./fillCustomControls.js";
import { recordSiteLearning, mergeControlSkills } from "./siteLearnings.js";
import { normalizeHost } from "./host.js";
import { hasPreferencesGateFields, getPreferencesFromContext } from "./fillPreferences.js";
import { hasUnfilledYesNoOrEEOC, hasUnfilledApplicationControls } from "./fillApplicationAnswers.js";
import {
  sortByVisualOrder,
  sortApplyFields,
  detectRequiredUnfilled,
  buildRequiredFieldsInstruction,
  isEarlyCustomControl,
  isVoluntaryField,
} from "./fillOrder.js";
import { canUseStagehand, attemptStagehandAct } from "./layers/stagehandAdapter.js";
import { SMART_FILL_SALARY_HELPER } from "./primitives/browserControlPatterns.js";
import { looksLikeJobAlertSignupForm, looksLikeMarketingYesNoModal, looksLikeApplySignupGate, looksLikeGoogleVignetteAd } from "./heuristics.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMART_FILL_JS = fs.readFileSync(path.join(__dirname, "smart_fill.js"), "utf8");

const LONG_TEXT_TYPES = new Set(["coverletter", "additionalinfo"]);

export function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/, 2);
  if (!parts.length) return ["", ""];
  if (parts.length === 1) return [parts[0], ""];
  return [parts[0], parts[1]];
}

async function evaluateSmartFill(page, config, siteMappings, options = {}) {
  return page.evaluate(
    ({ js, helperJs, config: cfg, siteMappings: maps, options: opts }) => {
      // eslint-disable-next-line no-eval
      eval(helperJs);
      // eslint-disable-next-line no-eval
      eval(js);
      return runSmartFill(cfg, maps, opts);
    },
    {
      js: SMART_FILL_JS,
      helperJs: SMART_FILL_SALARY_HELPER,
      config,
      siteMappings,
      options: {
        profile: options.profile || config.profile || "apply",
        disabledFields: options.disabledFields || config.disabledFields || {},
        captureUndo: false,
      },
    },
  );
}

async function fillViaPlaywright(page, selector, value, { longText = false } = {}) {
  try {
    const loc = page.locator(selector).first();
    if (!(await loc.count()) || !(await loc.isVisible())) {
      return false;
    }
    const tag = await loc.evaluate((el) => (el?.tagName || "").toLowerCase()).catch(() => "");
    if (tag === "select") {
      const raw = String(value || "").trim();
      try {
        await loc.selectOption({ label: raw });
        return true;
      } catch {
        /* try value */
      }
      try {
        await loc.selectOption({ value: raw });
        return true;
      } catch {
        return false;
      }
    }
    const human = getSettings().browser_human_behavior;
    if (human) {
      await humanType(loc, value, page);
    } else if (longText) {
      await humanType(loc, value, page);
    } else {
      await loc.fill(value, { timeout: 5000 });
    }
    return true;
  } catch {
    return false;
  }
}

async function uploadFile(page, selector, filePath) {
  const loc = page.locator(selector).first();
  if (!(await loc.count())) return false;
  for (const force of [false, true]) {
    try {
      await loc.setInputFiles(filePath, { timeout: 15000, force });
      await loc.dispatchEvent("input").catch(() => {});
      await loc.dispatchEvent("change").catch(() => {});
      await page.waitForTimeout(500);
      return true;
    } catch {
      /* retry hidden Dropzone inputs with force */
    }
  }
  return false;
}

function fieldHint(entry) {
  return entry.label || entry.name || entry.placeholder || entry.selector || entry.type || "?";
}

function textValueForEntry(entry, config) {
  const byType = {
    email: config.email,
    firstname: config.firstName,
    lastname: config.lastName,
    fullname: config.fullName || [config.firstName, config.lastName].filter(Boolean).join(" "),
    chosenname:
      config.preferredName ||
      config.chosenName ||
      config.fullName ||
      [config.firstName, config.lastName].filter(Boolean).join(" "),
    tel: config.phone,
    coverletter: config.coverLetter,
    additionalinfo: config.coverLetter,
    linkedinurl: config.linkedinUrl,
    website: config.websiteUrl,
    address1: config.addressLine1,
    address2: config.addressLine2,
    city: config.city,
    state: config.state,
    // Host apps send postalCode; older configs used postalCode typo / zip.
    zip: config.postalCode || config.postalCode || config.zip || "",
    country: config.country,
    citystatezip:
      config.cityStateZip ||
      [config.city, config.state, config.postalCode || config.postalCode || config.zip]
        .filter(Boolean)
        .join(", "),
  };
  if (entry.type && byType[entry.type]) return String(byType[entry.type] || "").trim();
  return entry.value || "";
}

function partitionFilled(entries, fileTargets) {
  const shortText = [];
  const longText = [];
  const files = [];
  const hasFileTargets = (fileTargets || []).length > 0;

  for (const entry of entries || []) {
    if (entry.file) {
      if (hasFileTargets) continue;
      files.push(entry);
    } else if (LONG_TEXT_TYPES.has(entry.type)) {
      longText.push(entry);
    } else if (entry.deferred) {
      shortText.push(entry);
    } else {
      shortText.push(entry);
    }
  }

  return { shortText, longText, files };
}

async function processTextEntry(page, entry, config, seen, allFilled, log) {
  const sel = entry.selector || "";
  if (!sel || seen.has(sel)) return;

  log?.layer(
    "smart_fill",
    `match ${entry.type} score=${entry.score ?? "?"} \`${fieldHint(entry)}\` → ${sel.slice(0, 80)}`,
    "debug",
  );

  if (!entry.deferred) {
    seen.add(sel);
    allFilled.push(entry);
    return;
  }

  const value = textValueForEntry(entry, config);
  if (!value) return;

  const longText =
    LONG_TEXT_TYPES.has(entry.type) || value.length > getSettings().human_long_text_threshold;
  if (await fillViaPlaywright(page, sel, value, { longText })) {
    seen.add(sel);
    allFilled.push(entry);
    log?.layer("smart_fill", `typed ${entry.type} → ${sel.slice(0, 80)}`, "info");
  }
}

async function applyCustomControlsResult(
  page,
  context,
  log,
  { snap, seen, allFilled, lastUnfilled, hostname, pageCtx = null, deferVoluntary = false },
) {
  const customResult = await fillCustomControls(page, context, {
    snap,
    learnedSkills: context?.siteLearnings?.controlSkills || [],
    log,
    pageCtx,
    deferVoluntary,
  });

  log?.layer(
    "custom_controls",
    `filled=${customResult.filled.length} unfilled=${customResult.unfilled.length}`,
    customResult.filled.length ? "info" : "debug",
  );

  for (const entry of customResult.filled) {
    const key = entry.selector || `${entry.mappedTo}:${entry.label}`;
    if (key && !seen.has(key)) {
      seen.add(key);
      allFilled.push(entry);
    }
  }

  if (customResult.unfilled.length) {
    const existingTypes = new Set((lastUnfilled || []).map((u) => u.type));
    for (const u of customResult.unfilled) {
      if (!existingTypes.has(u.type)) lastUnfilled.push(u);
    }
  }

  const host = normalizeHost(hostname || context?.targetHost || snap?.hostname || "");
  if (host && customResult.skills?.length) {
    const verifiedSkills = customResult.skills.filter((s) => (s.successCount || 0) >= 2);
    if (verifiedSkills.length) {
      recordSiteLearning(host, { controlSkills: mergeControlSkills([], verifiedSkills) });
    }
  }

  return customResult;
}

/**
 * Smart fill layer — heuristic DOM scoring + site mappings + optional AI fallback.
 */
export async function runSmartFill(page, context, log = null, { sessionId = null, snap = null } = {}) {
  const config = await getRuntime().buildFillConfig(context, { sessionId });
  const siteMappings = loadSiteMappings();
  const seen = new Set();
  const allFilled = [];
  let lastResult = {};
  let lastUnfilled = [];

  log?.layer(
    "smart_fill",
    `config: name=${config.fullName || config.startupName || "?"} email=${config.email ? "✓" : "✗"} file=${config.resumePath || config.filePath ? "✓" : "✗"}`,
  );

  const prefs = getPreferencesFromContext(context);
  log?.layer(
    "smart_fill",
    `prefs: location=${prefs.location || "?"} title=${(prefs.desiredTitle || "?").slice(0, 48)} salary=${prefs.salary || "(from job/settings)"}`,
    "info",
  );

  if (
    snap &&
    (looksLikeJobAlertSignupForm(snap) ||
      looksLikeMarketingYesNoModal(snap) ||
      looksLikeApplySignupGate(snap) ||
      looksLikeGoogleVignetteAd(snap))
  ) {
    const reason = looksLikeApplySignupGate(snap)
      ? "apply signup gate — use auth_signup flow"
      : looksLikeGoogleVignetteAd(snap)
        ? "google vignette ad — dismiss overlay first"
        : "job-alert/marketing signup — dismiss overlay first";
    log?.layer("smart_fill", `skipped: ${reason}`, "info");
    return {
      filled: [],
      unfilled: [],
      unfilled_count: 0,
      skipped: looksLikeApplySignupGate(snap)
        ? "apply_signup_gate"
        : looksLikeGoogleVignetteAd(snap)
          ? "google_vignette"
          : "job_alert_signup",
      hostname: snap.hostname || "",
    };
  }

  const pageCtx = {
    looksLikeApplyForm: true,
    pageText: snap?.pageText || "",
    headings: snap?.headings || "",
    pageKind: snap?.pageKind,
  };

  const preferCustomFirst =
    snap &&
    (hasPreferencesGateFields(snap) ||
      (snap.customControls || []).some((c) => isEarlyCustomControl(c, pageCtx)));
  let customRanEarly = false;
  if (preferCustomFirst) {
    log?.layer("smart_fill", "custom controls first (required yes/no / pronouns / company)", "info");
    await applyCustomControlsResult(page, context, log, {
      snap,
      seen,
      allFilled,
      lastUnfilled,
      hostname: snap?.hostname,
      pageCtx,
      deferVoluntary: true,
    });
    customRanEarly = true;
  }

  const passes = Math.max(1, getSettings().smart_fill_passes);
  for (let passNum = 0; passNum < passes; passNum++) {
    log?.layer("smart_fill", `pass ${passNum + 1}/${passes}`, "info");
    lastResult = await evaluateSmartFill(page, config, siteMappings, {
      profile: config.profile || getSettings().smart_fill_profile || "apply",
      disabledFields: config.disabledFields || {},
    });
    lastUnfilled = lastResult.unfilled || [];

    log?.layer(
      "smart_fill",
      `DOM scan: hostname=${lastResult.hostname || "?"} mapped=[${(lastResult.siteMapped || []).join(", ")}] candidates=${(lastResult.filled || []).length + lastUnfilled.length}`,
    );

    const filePath = config.resumePath || config.filePath || "";
    const { shortText, longText, files } = partitionFilled(
      lastResult.filled,
      lastResult.fileTargets,
    );

    // 1) Profile / short fields — required + logical order (name → pronouns → email → …)
    const orderedShort = sortApplyFields(shortText, pageCtx);
    for (const entry of orderedShort) {
      if (entry.required && !isVoluntaryField(entry, pageCtx)) {
        log?.layer("smart_fill", `priority required: ${entry.type} ${String(entry.clue || "").slice(0, 40)}`, "debug");
      }
      await processTextEntry(page, entry, config, seen, allFilled, log);
    }

    // 2) Resume / cover uploads in apply order
    for (const entry of sortApplyFields(files, pageCtx)) {
      const sel = entry.selector || "";
      if (!sel || seen.has(sel) || !filePath) continue;
      if (await uploadFile(page, sel, filePath)) {
        entry.uploaded = true;
        seen.add(sel);
        allFilled.push(entry);
        log?.layer("smart_fill", `uploaded file → ${sel}`, "info");
      } else {
        log?.layer("smart_fill", `file upload failed → ${sel}`, "warn");
      }
    }

    const resumePath = config.resumePath || config.filePath || "";
    const coverPath = config.coverLetterPath || "";
    const pendingTargets = sortByVisualOrder(
      (lastResult.fileTargets || []).filter((t) => t.selector && !seen.has(t.selector)),
    );

    function classifyUploadTarget(target, index, total) {
      const clue = (target.clue || "").toLowerCase();
      if (/cover\s*letter|upload your cover/.test(clue)) return "cover";
      if (/resume|curriculum|\bcv\b|upload your resume/.test(clue)) return "resume";
      if (total === 2 && coverPath) return index === 0 ? "resume" : "cover";
      return "resume";
    }

    for (let i = 0; i < pendingTargets.length; i++) {
      const target = pendingTargets[i];
      const kind = classifyUploadTarget(target, i, pendingTargets.length);
      const uploadPath = kind === "cover" ? coverPath : resumePath;
      if (!uploadPath) continue;
      if (await uploadFile(page, target.selector, uploadPath)) {
        seen.add(target.selector);
        allFilled.push({
          type: kind === "cover" ? "coverletter_file" : "resume",
          selector: target.selector,
          score: 90,
          file: true,
          uploaded: true,
        });
        const basename = uploadPath.split(/[/\\]/).pop() || uploadPath;
        log?.layer(
          "smart_fill",
          `uploaded ${kind === "cover" ? "cover letter" : "resume"} (${basename}) → ${target.selector.slice(0, 80)} [${target.clue || "no clue"}]`,
          "info",
        );
      } else {
        log?.layer(
          "smart_fill",
          `file upload failed → ${target.selector.slice(0, 80)} [${target.clue || "no clue"}]`,
          "warn",
        );
      }
    }

    // 3) Cover letter / additional info last (top-to-bottom among long fields)
    for (const entry of sortApplyFields(longText, pageCtx)) {
      await processTextEntry(page, entry, config, seen, allFilled, log);
    }

    if (passNum < passes - 1) {
      await humanPause(400, 600);
    }
  }

  const needsLateCustom =
    !customRanEarly ||
    allFilled.length === 0 ||
    hasUnfilledYesNoOrEEOC(snap) ||
    (snap?.customControls || []).some((c) => !c.filled);
  if (needsLateCustom) {
    await applyCustomControlsResult(page, context, log, {
      snap,
      seen,
      allFilled,
      lastUnfilled,
      hostname: lastResult.hostname,
      pageCtx,
      deferVoluntary: false,
    });
  }

  let aiAnswers = {};
  const answerUnfilled = getRuntime().answerUnfilledFields;
  lastUnfilled = sortApplyFields(
    (lastUnfilled || []).map((u) => ({
      ...u,
      label: u.label || u.clue || "",
    })),
    pageCtx,
  );
  if ((lastResult.required_unfilled || 0) > 0) {
    log?.layer(
      "smart_fill",
      `${lastResult.required_unfilled} required field(s) still empty after DOM fill`,
      "info",
    );
  }
  if (getSettings().ai_fill_enabled && lastUnfilled.length && answerUnfilled) {
    // Prefer truly required unfilled for the AI budget; voluntary EEOC last.
    const requiredFirst = [
      ...detectRequiredUnfilled(lastUnfilled, pageCtx),
      ...lastUnfilled.filter((u) => !looksRequiredish(u, pageCtx) && !isVoluntaryField(u, pageCtx)),
      ...lastUnfilled.filter((u) => isVoluntaryField(u, pageCtx)),
    ];
    const orderedUnfilled = requiredFirst.filter(
      (u, i, arr) => arr.findIndex((x) => x.selector === u.selector) === i,
    );
    log?.layer(
      "smart_fill",
      `AI fallback for ${orderedUnfilled.length} job field(s) (${detectRequiredUnfilled(orderedUnfilled, pageCtx).length} required)`,
      "info",
    );
    aiAnswers = await answerUnfilled(context, { unfilled: orderedUnfilled, sessionId });
    for (const entry of orderedUnfilled) {
      const selector = entry.selector || "";
      const value = aiAnswers[selector];
      if (!selector || !value || seen.has(selector)) continue;
      const longText = value.length > getSettings().human_long_text_threshold;
      if (await fillViaPlaywright(page, selector, value, { longText })) {
        seen.add(selector);
        allFilled.push({ type: "ai", selector, score: 0, source: "ai" });
        log?.layer("smart_fill", `AI filled → ${selector.slice(0, 80)}`, "info");
      }
    }
  }

  // Leftover required — one Stagehand nudge (apply fields only), never footer noise.
  const stillRequired = detectRequiredUnfilled(
    (lastUnfilled || []).filter((u) => !seen.has(u.selector)),
    pageCtx,
  );
  if (stillRequired.length && canUseStagehand(context).ok) {
    const instruction = buildRequiredFieldsInstruction(stillRequired, pageCtx);
    if (instruction) {
      log?.layer("smart_fill", `Stagehand required pass (${stillRequired.length})`, "info");
      await attemptStagehandAct(page, context, { instruction, log }).catch(() => null);
    }
  }

  const types = [...new Set(allFilled.map((f) => f.type || "?"))].sort();
  return {
    filled: allFilled,
    filled_types: types,
    unfilled: lastUnfilled.filter((u) => !seen.has(u.selector)),
    unfilled_count: Math.max(0, lastUnfilled.filter((u) => !seen.has(u.selector)).length),
    ai_filled: Object.keys(aiAnswers).length,
    hostname: lastResult.hostname || "",
    site_mapped: lastResult.siteMapped || [],
    required_unfilled: stillRequired.length,
  };
}

function looksRequiredish(u, ctx = {}) {
  return Boolean(u?.required || u?.isRequired) && !isVoluntaryField(u, ctx);
}
