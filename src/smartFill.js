import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getRuntime, getSettings } from "./runtime.js";
import { loadSiteMappings } from "./siteMappings.js";
import { humanPause, humanType } from "./human.js";
import { fillCustomControls } from "./fillCustomControls.js";
import { recordSiteLearning, mergeControlSkills } from "./siteLearnings.js";
import { normalizeHost } from "./host.js";
import { hasPreferencesGateFields } from "./fillPreferences.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMART_FILL_JS = fs.readFileSync(path.join(__dirname, "smart_fill.js"), "utf8");

const LONG_TEXT_TYPES = new Set(["coverletter", "additionalinfo"]);

export function splitName(fullName) {
  const parts = fullName.trim().split(/\s+/, 2);
  if (!parts.length) return ["", ""];
  if (parts.length === 1) return [parts[0], ""];
  return [parts[0], parts[1]];
}

async function evaluateSmartFill(page, config, siteMappings) {
  return page.evaluate(
    ({ js, config: cfg, siteMappings: maps }) => {
      // eslint-disable-next-line no-eval
      eval(js);
      return runSmartFill(cfg, maps);
    },
    { js: SMART_FILL_JS, config, siteMappings },
  );
}

async function fillViaPlaywright(page, selector, value, { longText = false } = {}) {
  try {
    const loc = page.locator(selector).first();
    if (!(await loc.count()) || !(await loc.isVisible())) {
      return false;
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
    tel: config.phone,
    coverletter: config.coverLetter,
    additionalinfo: config.coverLetter,
    linkedinurl: config.linkedinUrl,
    website: config.websiteUrl,
    address1: config.addressLine1,
    address2: config.addressLine2,
    city: config.city,
    state: config.state,
    zip: config.postalCode,
    country: config.country,
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

async function applyCustomControlsResult(page, context, log, { snap, seen, allFilled, lastUnfilled, hostname }) {
  const customResult = await fillCustomControls(page, context, {
    snap,
    learnedSkills: context?.siteLearnings?.controlSkills || [],
    log,
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
    recordSiteLearning(host, { controlSkills: mergeControlSkills([], customResult.skills) });
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

  const preferCustomFirst = snap && ((snap.customControlCount || 0) > 0 || hasPreferencesGateFields(snap));
  let customRanEarly = false;
  if (preferCustomFirst) {
    log?.layer("smart_fill", "custom controls first (modal comboboxes)", "info");
    await applyCustomControlsResult(page, context, log, {
      snap,
      seen,
      allFilled,
      lastUnfilled,
      hostname: snap?.hostname,
    });
    customRanEarly = true;
  }

  const passes = Math.max(1, getSettings().smart_fill_passes);
  for (let passNum = 0; passNum < passes; passNum++) {
    log?.layer("smart_fill", `pass ${passNum + 1}/${passes}`, "info");
    lastResult = await evaluateSmartFill(page, config, siteMappings);
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

    // 1) Profile / short fields first (human-typed when enabled)
    for (const entry of shortText) {
      await processTextEntry(page, entry, config, seen, allFilled, log);
    }

    // 2) Resume / cover uploads before optional long text
    for (const entry of files) {
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
    const pendingTargets = (lastResult.fileTargets || []).filter(
      (t) => t.selector && !seen.has(t.selector),
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

    // 3) Cover letter / additional info last
    for (const entry of longText) {
      await processTextEntry(page, entry, config, seen, allFilled, log);
    }

    if (passNum < passes - 1) {
      await humanPause(400, 600);
    }
  }

  if (!customRanEarly || allFilled.length === 0) {
    await applyCustomControlsResult(page, context, log, {
      snap,
      seen,
      allFilled,
      lastUnfilled,
      hostname: lastResult.hostname,
    });
  }

  let aiAnswers = {};
  const answerUnfilled = getRuntime().answerUnfilledFields;
  if (getSettings().ai_fill_enabled && lastUnfilled.length && answerUnfilled) {
    log?.layer("smart_fill", `AI fallback for ${lastUnfilled.length} unfilled field(s)`, "info");
    aiAnswers = await answerUnfilled(context, { unfilled: lastUnfilled, sessionId });
    for (const [selector, value] of Object.entries(aiAnswers)) {
      if (seen.has(selector)) continue;
      const longText = value.length > getSettings().human_long_text_threshold;
      if (await fillViaPlaywright(page, selector, value, { longText })) {
        seen.add(selector);
        allFilled.push({ type: "ai", selector, score: 0, source: "ai" });
        log?.layer("smart_fill", `AI filled → ${selector.slice(0, 80)}`, "info");
      }
    }
  }

  const types = [...new Set(allFilled.map((f) => f.type || "?"))].sort();
  return {
    filled: allFilled,
    filled_types: types,
    unfilled: lastUnfilled,
    unfilled_count: Math.max(0, lastUnfilled.length - Object.keys(aiAnswers).length),
    ai_filled: Object.keys(aiAnswers).length,
    hostname: lastResult.hostname || "",
    site_mapped: lastResult.siteMapped || [],
  };
}
