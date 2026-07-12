/**
 * Generic custom control fill — combobox, listbox, contenteditable, div-button.
 * Site-agnostic; label/ARIA driven. Replays learned controlSkills first.
 */
import { getPreferencesFromContext, resolvePreferenceFillValue } from "./fillPreferences.js";
import { resolveIdentityFillValue } from "./fillProfile.js";
import { pickClosestSalaryOption } from "./salaryExpectation.js";
import { humanPause, humanType } from "./human.js";
import { loadSiteLearnings } from "./siteLearnings.js";
import { normalizeHost } from "./host.js";

const LABEL_TO_MAPPED = [
  { re: /desired\s*job|job\s*title|target\s*role|position\s*sought/i, mappedTo: "desiredtitle", type: "desiredtitle" },
  { re: /salary|compensation|pay\s*expect|expected\s*pay/i, mappedTo: "salary", type: "salary" },
  { re: /\blocation\b|where\s*are\s*you|based\s*in|city\s*region/i, mappedTo: "location", type: "location" },
  { re: /\bcountry\b/i, mappedTo: "country", type: "country" },
];

const SIGNUP_CTA_PATTERNS = [/sign up now/i, /sign up for free/i, /get started/i, /^continue$/i];

async function visible(loc) {
  return loc.isVisible({ timeout: 900 }).catch(() => false);
}

function mapLabelToType(label) {
  const blob = String(label || "").toLowerCase();
  for (const { re, mappedTo, type } of LABEL_TO_MAPPED) {
    if (re.test(blob)) return { mappedTo, type };
  }
  return null;
}

function resolveValueForControl(mappedTo, label, context) {
  const hint = `${label} ${mappedTo}`;
  const prefs = getPreferencesFromContext(context);
  const byMapped = {
    location: prefs.location,
    desiredtitle: prefs.desiredTitle,
    salary: prefs.salary,
    country: prefs.country,
  };
  if (byMapped[mappedTo]) return String(byMapped[mappedTo] || "").trim();
  return (
    String(resolvePreferenceFillValue(hint, "", context) || "").trim() ||
    String(resolveIdentityFillValue(hint, "", context) || "").trim()
  );
}

function learnedSkillsForContext(context) {
  const host = normalizeHost(context?.targetHost || context?.hostname || "");
  const fromContext = context?.siteLearnings?.controlSkills;
  if (Array.isArray(fromContext) && fromContext.length) return fromContext;
  if (!host) return [];
  const hosts = loadSiteLearnings();
  return hosts[host]?.controlSkills || [];
}

async function collectListOptions(page) {
  const locators = [
    page.locator("[role='listbox'] [role='option']"),
    page.locator("[role='option']"),
    page.locator("[class*='dropdown'] li, [class*='menu'] li, [class*='option']"),
  ];
  for (const loc of locators) {
    const count = await loc.count().catch(() => 0);
    if (!count) continue;
    const opts = [];
    for (let i = 0; i < Math.min(count, 32); i += 1) {
      const item = loc.nth(i);
      if (!(await visible(item))) continue;
      const text = (await item.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!text) continue;
      opts.push({ text, index: i, locator: loc });
    }
    if (opts.length) return opts;
  }
  return [];
}

async function openComboboxTrigger(page, labelRe, triggerSelector) {
  if (triggerSelector) {
    try {
      const el = page.locator(triggerSelector).first();
      if ((await el.count()) > 0 && (await visible(el))) {
        await el.click({ timeout: 4000 });
        await humanPause(350, 600);
        return true;
      }
    } catch {
      /* fall through */
    }
  }
  const candidates = [
    page.getByRole("combobox", { name: labelRe }),
    page.locator("[role='combobox']").filter({ hasText: labelRe }),
    page.locator("[aria-haspopup='listbox']").filter({ hasText: labelRe }),
    page.getByText(labelRe),
    page.locator("button, div, span").filter({ hasText: labelRe }),
    page.locator("[class*='select'], [class*='dropdown']").filter({ hasText: labelRe }),
  ];
  for (const loc of candidates) {
    try {
      const el = loc.first();
      if (!(await visible(el))) continue;
      await el.click({ timeout: 4000 });
      await humanPause(350, 600);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

async function selectFromOptions(page, options, value, mappedTo, log) {
  if (!options.length || !value) return false;
  let chosen = null;
  if (mappedTo === "salary") {
    const pick = pickClosestSalaryOption(
      options.map((o) => ({ text: o.text, value: String(o.index) })),
      value,
    );
    chosen = pick ? options[Number(pick.value)] : null;
    if (!chosen) {
      chosen =
        options.find((o) => /negotiable|flexible|prefer not|open/i.test(o.text)) ||
        options.find((o) => o.index > 0) ||
        options[0];
    }
  } else {
    const lower = value.toLowerCase();
    chosen =
      options.find((o) => o.text.toLowerCase() === lower) ||
      (lower.length >= 3 ? options.find((o) => o.text.toLowerCase().includes(lower)) : null) ||
      options[0];
  }
  if (!chosen) return false;
  await chosen.locator.nth(chosen.index).click({ timeout: 4000 });
  log?.layer("custom_controls", `selected "${chosen.text}" for ${mappedTo}`, "info");
  return true;
}

async function fillTextControl(page, labelRe, value, log) {
  if (!value) return false;
  try {
    const byLabel = page.getByLabel(labelRe, { exact: false });
    if ((await byLabel.count()) > 0 && (await visible(byLabel.first()))) {
      const cur = await byLabel.first().inputValue().catch(() => "");
      if (!cur.trim()) {
        await byLabel.first().fill(value, { timeout: 5000 });
        log?.layer("custom_controls", `filled ${labelRe} via label`, "debug");
        return true;
      }
    }
  } catch {
    /* next */
  }
  try {
    const scope = page.locator("[role='dialog'], [aria-modal='true']").first();
    const root = (await scope.count()) > 0 ? scope : page;
    const inputs = root.locator("input[type='text'], input:not([type]), textarea");
    const count = await inputs.count();
    for (let i = 0; i < count; i += 1) {
      const input = inputs.nth(i);
      const blob = `${await input.getAttribute("placeholder").catch(() => "")} ${await input.getAttribute("aria-label").catch(() => "")}`.toLowerCase();
      if (labelRe.test(blob)) {
        const cur = await input.inputValue().catch(() => "");
        if (!cur.trim()) {
          await input.fill(value, { timeout: 5000 });
          log?.layer("custom_controls", `filled ${labelRe} via placeholder`, "debug");
          return true;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function fillContentEditable(page, labelRe, value, log) {
  if (!value) return false;
  try {
    const scope = page.locator("[role='dialog'], [aria-modal='true']").first();
    const root = (await scope.count()) > 0 ? scope : page;
    const editables = root.locator("[contenteditable='true']");
    const count = await editables.count();
    for (let i = 0; i < count; i += 1) {
      const el = editables.nth(i);
      const aria = (await el.getAttribute("aria-label").catch(() => "")) || "";
      const near = (await el.evaluate((node) => {
        const lbl = node.closest("label");
        return lbl ? lbl.textContent : "";
      }).catch(() => "")) || "";
      const blob = `${aria} ${near}`.toLowerCase();
      if (!labelRe.test(blob)) continue;
      if (!(await visible(el))) continue;
      await el.click({ timeout: 3000 });
      await humanType(el, value, page);
      log?.layer("custom_controls", `filled contenteditable ${labelRe}`, "debug");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function fillComboboxControl(page, { label, mappedTo, value, triggerSelector }, log) {
  if (!value && mappedTo !== "salary") return false;
  const labelRe = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  if (await openComboboxTrigger(page, labelRe, triggerSelector)) {
    const options = await collectListOptions(page);
    if (options.length && (await selectFromOptions(page, options, value, mappedTo, log))) {
      return true;
    }
    const combo = page.locator("[role='combobox'], input").filter({ hasText: labelRe }).first();
    if (await visible(combo) && value) {
      await combo.fill(value, { timeout: 3000 }).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      return true;
    }
  }
  if (mappedTo === "salary" && value) {
    const band = page.getByText(/\$[\d,]+|€[\d,]+|£[\d,]+|negotiable|flexible/i).first();
    if (await visible(band)) {
      await band.click({ timeout: 3000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function replayLearnedSkill(page, skill, context, log) {
  if (!skill) return null;
  const mappedTo = skill.mappedTo || skill.type;
  const value = resolveValueForControl(mappedTo, skill.label || mappedTo, context);
  if (skill.widgetType === "combobox" || skill.optionStrategy === "closest_salary_band") {
    const ok = await fillComboboxControl(
      page,
      { label: skill.label || mappedTo, mappedTo, value, triggerSelector: skill.triggerSelector },
      log,
    );
    if (ok) {
      return { type: mappedTo, mappedTo, widgetType: "combobox", label: skill.label, source: "learned_skill" };
    }
  }
  if (skill.triggerSelector && value) {
    try {
      const loc = page.locator(skill.triggerSelector).first();
      if ((await loc.count()) > 0 && (await visible(loc))) {
        await loc.fill(value, { timeout: 5000 });
        return { type: mappedTo, mappedTo, widgetType: skill.widgetType || "text", label: skill.label, source: "learned_skill" };
      }
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** Discover custom controls from snapshot or page heuristics. */
export function discoverCustomControlsFromSnap(snap) {
  const fromSnap = (snap?.customControls || []).filter((c) => !c.filled);
  if (fromSnap.length) return fromSnap;

  const discovered = [];
  const blob = `${snap?.pageText || ""} ${snap?.headings || ""}`.toLowerCase();
  for (const { re, mappedTo, type } of LABEL_TO_MAPPED) {
    if (re.test(blob) || (snap?.fields || []).some((f) => re.test(`${f.label} ${f.name}`))) {
      discovered.push({ label: type, mappedTo, type, widgetType: /salary|compensation/i.test(type) ? "combobox" : "text", filled: false });
    }
  }
  return discovered;
}

/**
 * @param {import('playwright').Page} page
 * @param {object} context
 * @param {{ snap?: object, learnedSkills?: object[], log?: { layer: Function } }} [opts]
 */
export async function fillCustomControls(page, context, opts = {}) {
  const log = opts.log || null;
  const snap = opts.snap || null;
  const skills = opts.learnedSkills || learnedSkillsForContext(context);
  const filled = [];
  const newSkills = [];
  const unfilled = [];

  const controls = discoverCustomControlsFromSnap(snap);
  const targets =
    controls.length > 0
      ? controls
      : LABEL_TO_MAPPED.map(({ type, mappedTo }) => ({
          label: type,
          mappedTo,
          type,
          widgetType: mappedTo === "salary" ? "combobox" : "text",
        }));

  log?.layer("custom_controls", `discovered ${targets.length} control target(s)`, "info");

  const filledMapped = new Set();

  for (const skill of skills) {
    if (filledMapped.has(skill.mappedTo)) continue;
    const result = await replayLearnedSkill(page, skill, context, log);
    if (result) {
      filled.push(result);
      filledMapped.add(skill.mappedTo);
    }
  }

  for (const ctrl of targets) {
    const mappedTo = ctrl.mappedTo || ctrl.type;
    if (filledMapped.has(mappedTo)) continue;
    const label = ctrl.label || mappedTo;
    const mapping = mapLabelToType(label) || { mappedTo, type: mappedTo };
    const value = resolveValueForControl(mapping.mappedTo, label, context);
    const labelRe = new RegExp(
      mapping.mappedTo === "desiredtitle"
        ? "desired job title|job title"
        : mapping.mappedTo === "salary"
          ? "salary|compensation|pay expect"
          : mapping.mappedTo === "location"
            ? "location|where are you|based in"
            : label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );

    let ok = false;
    const widgetType = ctrl.widgetType || (mapping.mappedTo === "salary" ? "combobox" : "text");

    if (widgetType === "combobox" || mapping.mappedTo === "salary") {
      ok = await fillComboboxControl(
        page,
        { label, mappedTo: mapping.mappedTo, value, triggerSelector: ctrl.triggerSelector || ctrl.selector },
        log,
      );
    } else if (widgetType === "contenteditable") {
      ok = await fillContentEditable(page, labelRe, value, log);
    } else {
      ok = await fillTextControl(page, labelRe, value, log);
    }

    if (ok) {
      const entry = {
        type: mapping.type,
        mappedTo: mapping.mappedTo,
        widgetType,
        label,
        source: "custom_controls",
        selector: ctrl.selector || ctrl.triggerSelector || "",
      };
      filled.push(entry);
      filledMapped.add(mapping.mappedTo);
      newSkills.push({
        label,
        mappedTo: mapping.mappedTo,
        widgetType,
        triggerSelector: ctrl.selector || ctrl.triggerSelector || "",
        optionStrategy: mapping.mappedTo === "salary" ? "closest_salary_band" : "text_match",
        successCount: 1,
      });
    } else if (value || mapping.mappedTo === "salary") {
      unfilled.push({
        type: mapping.type,
        mappedTo: mapping.mappedTo,
        widgetType,
        label,
        clue: label,
        selector: ctrl.selector || `[role=combobox]:has-text("${label}")`,
      });
    }
  }

  return { ok: filled.length > 0, filled, unfilled, skills: newSkills };
}

export async function clickPreferencesSignupCta(page, log, layer = "custom_controls") {
  for (const pattern of SIGNUP_CTA_PATTERNS) {
    try {
      const btn = page.getByRole("button", { name: pattern });
      if ((await btn.count()) > 0 && (await visible(btn.first()))) {
        await btn.first().click({ timeout: 8000 });
        log?.layer(layer, `clicked CTA matching ${pattern}`, "info");
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}
