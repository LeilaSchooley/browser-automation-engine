import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { getRuntime, getSettings } from "./runtime.js";
import { loadSiteMappings } from "./siteMappings.js";
import { humanPause, humanType } from "./human.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMART_FILL_JS = fs.readFileSync(path.join(__dirname, "smart_fill.js"), "utf8");

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
    if (longText && getSettings().browser_human_behavior) {
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
  try {
    const loc = page.locator(selector).first();
    if (!(await loc.count())) return false;
    await loc.setInputFiles(filePath);
    return true;
  } catch {
    return false;
  }
}

function fieldHint(entry) {
  return entry.label || entry.name || entry.placeholder || entry.selector || entry.type || "?";
}

/**
 * Smart fill layer — heuristic DOM scoring + site mappings + optional AI fallback.
 */
export async function runSmartFill(page, context, log = null, { sessionId = null } = {}) {
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

    for (const entry of lastResult.filled || []) {
      const sel = entry.selector || "";
      if (!sel || seen.has(sel)) continue;

      log?.layer(
        "smart_fill",
        `match ${entry.type} score=${entry.score ?? "?"} \`${fieldHint(entry)}\` → ${sel.slice(0, 80)}`,
        "debug",
      );

      if (entry.file && filePath) {
        if (await uploadFile(page, sel, filePath)) {
          entry.uploaded = true;
          seen.add(sel);
          allFilled.push(entry);
          log?.layer("smart_fill", `uploaded file → ${sel}`, "info");
        } else {
          log?.layer("smart_fill", `file upload failed → ${sel}`, "warn");
        }
        continue;
      }

      const longTextValue = entry.type === "coverletter" ? config.coverLetter : entry.value;
      if (entry.type === "coverletter" && getSettings().browser_human_behavior) {
        if (await fillViaPlaywright(page, sel, longTextValue, { longText: true })) {
          seen.add(sel);
          allFilled.push(entry);
          log?.layer("smart_fill", `typed long text → ${sel}`, "info");
        }
        continue;
      }

      seen.add(sel);
      allFilled.push(entry);
    }

    if (passNum < passes - 1) {
      await humanPause(400, 600);
    }
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
