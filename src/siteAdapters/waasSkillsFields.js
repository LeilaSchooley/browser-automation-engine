/**
 * WaaS /application/skills — pick technologies then set proficiency radios.
 * Skills chips alone are not enough; each row needs Beginner/Intermediate/Advanced.
 */
import { humanPause } from "../human.js";
import { getApplicationAnswers, isWaasSkillsStep } from "../fillApplicationAnswers.js";
import { resolveTechSkills, TECH_SKILLS_LABEL_RE } from "../patterns/applicationScreening.js";
import { fillReactSelectMulti } from "../layers/fillWidgets/reactSelect.js";
import { visible } from "../layers/fillWidgets/shared.js";

/** Default proficiency for inferred/profile skills (WaaS radio values). */
const DEFAULT_LEVEL = "intermediate";

/**
 * @param {import('playwright').Page} page
 * @returns {Promise<number>} rows that still need a proficiency radio
 */
export async function countUnsetSkillProficiency(page) {
  return page.evaluate(() => {
    const form = document.querySelector("form");
    if (!form) return 0;
    const radios = [...form.querySelectorAll("input[type='radio']")].filter((el) => {
      const v = String(el.value || "").toLowerCase();
      return /^(beginner|intermediate|advanced)$/.test(v);
    });
    if (!radios.length) return 0;
    const byName = new Map();
    for (const el of radios) {
      const name = el.getAttribute("name") || "";
      // Nameless radios: treat each as its own row keyed by a stable path.
      const key =
        name ||
        `${el.getBoundingClientRect().top.toFixed(0)}:${[...el.parentElement?.querySelectorAll("input[type='radio']") || []].indexOf(el)}`;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(el);
    }
    // Group nameless radios by parent row.
    const rowGroups = new Map();
    for (const el of radios) {
      const row =
        el.closest("tr, [class*='skill'], .mb-2, .mb-3, .mb-4, li, div") || el.parentElement;
      const key = row || el;
      if (!rowGroups.has(key)) rowGroups.set(key, []);
      rowGroups.get(key).push(el);
    }
    let unset = 0;
    for (const group of rowGroups.values()) {
      if (!group.some((g) => g.checked)) unset += 1;
    }
    return unset;
  });
}

/**
 * Click Intermediate (or `level`) for every skill proficiency radio group that is unset.
 * Uses Playwright check() so React controlled inputs commit.
 * @param {import('playwright').Page} page
 * @param {string} [level]
 * @param {{ layer?: Function }} [log]
 */
export async function fillSkillProficiencyRadios(page, level = DEFAULT_LEVEL, log = null) {
  const want = String(level || DEFAULT_LEVEL).toLowerCase();
  const radios = page.locator(`form input[type='radio'][value='${want}']`);
  const total = await radios.count().catch(() => 0);
  let clicked = 0;

  for (let i = 0; i < total; i += 1) {
    const radio = radios.nth(i);
    if (!(await radio.isVisible().catch(() => false))) continue;
    if (await radio.isChecked().catch(() => false)) continue;

    const name = (await radio.getAttribute("name").catch(() => "")) || "";
    if (name) {
      const anyChecked = await page
        .locator(`form input[type='radio'][name="${name.replace(/"/g, '\\"')}"]:checked`)
        .count()
        .catch(() => 0);
      if (anyChecked > 0) continue;
    } else {
      // Same visual row already has a checked proficiency radio.
      const row = radio.locator(
        "xpath=ancestor::tr[1]|ancestor::*[contains(@class,'mb-')][1]|ancestor::li[1]",
      );
      const rowChecked = await row
        .locator("input[type='radio']:checked")
        .count()
        .catch(() => 0);
      if (rowChecked > 0) continue;
    }

    try {
      await radio.check({ force: true, timeout: 2500 });
      clicked += 1;
      await humanPause(60, 120);
    } catch {
      try {
        await radio.click({ force: true, timeout: 2500 });
        clicked += 1;
        await humanPause(60, 120);
      } catch {
        /* next */
      }
    }
  }

  if (clicked) {
    log?.layer?.("waas_skills", `set proficiency=${want} on ${clicked} skill row(s)`, "info");
    await humanPause(250, 450);
  }
  return clicked > 0;
}

/**
 * True when every proficiency radio group has a selection.
 * @param {import('playwright').Page} page
 */
export async function waasSkillsDomLooksComplete(page) {
  const state = await page.evaluate(() => {
    const form = document.querySelector("form");
    if (!form) return { unset: 0, groups: 0 };
    const radios = [...form.querySelectorAll("input[type='radio']")].filter((el) =>
      /^(beginner|intermediate|advanced)$/i.test(String(el.value || "")),
    );
    if (!radios.length) return { unset: 0, groups: 0 };
    const rowGroups = new Map();
    for (const el of radios) {
      const row =
        el.closest("tr, li") ||
        el.closest("[class*='skill' i]") ||
        el.closest(".mb-2, .mb-3, .mb-4") ||
        el.parentElement;
      const key = row || el;
      if (!rowGroups.has(key)) rowGroups.set(key, []);
      rowGroups.get(key).push(el);
    }
    let unset = 0;
    for (const group of rowGroups.values()) {
      if (!group.some((g) => g.checked)) unset += 1;
    }
    return { unset, groups: rowGroups.size };
  });
  if (state.groups === 0) return false;
  return state.unset === 0;
}

/**
 * Fill WaaS Skills step: pick tech chips + set Intermediate proficiency.
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {object} context
 * @param {{ layer?: Function }} [log]
 */
export async function fillWaasSkillsMissing(page, snap, context, log = null) {
  if (!isWaasSkillsStep(snap)) return { ok: false, filled: [], alreadyComplete: false };

  if (await waasSkillsDomLooksComplete(page)) {
    log?.layer?.("waas_skills", "DOM already complete — skip re-fill", "debug");
    return { ok: true, filled: [], alreadyComplete: true };
  }

  const answers = getApplicationAnswers(context);
  const picks = resolveTechSkills(answers.techSkills, answers.desiredTitle);
  const filled = [];

  const unsetBefore = await countUnsetSkillProficiency(page);
  const radioCount = await page
    .locator("form input[type='radio'][value='intermediate']")
    .count()
    .catch(() => 0);

  // No proficiency rows yet → need skill chips first.
  if (radioCount === 0) {
    const block = page.locator("form").filter({ hasText: TECH_SKILLS_LABEL_RE }).first();
    const field = (await visible(block)) ? block : page.locator("form").first();
    if (await fillReactSelectMulti(page, field, picks, log, 8)) {
      filled.push({ mappedTo: "techskills", type: "techskills", source: "waas_skills", field: "skills" });
      await humanPause(400, 700);
    }
  } else if (unsetBefore === radioCount && radioCount > 0) {
    // Rows exist but all unset — still fine to add more chips once, then rate.
  }

  if (await fillSkillProficiencyRadios(page, DEFAULT_LEVEL, log)) {
    filled.push({
      mappedTo: "techskills",
      type: "techskills",
      source: "waas_skills",
      field: "proficiency",
    });
  }

  const alreadyComplete = await waasSkillsDomLooksComplete(page);
  if (filled.length) {
    log?.layer?.(
      "waas_skills",
      `fast-path ${filled.map((f) => f.field).join(", ")}${alreadyComplete ? " — complete" : " — incomplete"}`,
      alreadyComplete ? "info" : "warn",
    );
  }

  return {
    ok: filled.length > 0 || alreadyComplete,
    filled,
    alreadyComplete,
  };
}

export { isWaasSkillsStep };
