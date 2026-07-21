/**
 * Generic custom control fill — combobox, listbox, contenteditable, div-button.
 * Site-agnostic; label/ARIA driven. Replays learned controlSkills first.
 *
 * Thin dispatcher: widget implementations live in layers/fillWidgets/.
 */
import {
  EEOC_MAPPED,
  APPLICATION_CONTROL_MAPPED,
} from "./fillApplicationAnswers.js";
import { sortByVisualOrder, compareApplyFillOrder, isVoluntaryField } from "./fillOrder.js";
import { humanPause } from "./human.js";
import { safeRoleLocator } from "./primitives/safeLocator.js";
import {
  LABEL_TO_MAPPED,
  APPLICATION_LABEL_TO_MAPPED,
  SIGNUP_CTA_PATTERNS,
  mapApplicationLabelToMapped,
  MIN_CONTROL_SKILL_SUCCESS,
} from "./primitives/controlPatterns.js";
import {
  REMOTE_PREFERENCE_LABEL_RE,
  WILLING_TO_RELOCATE_LABEL_RE,
  JOB_FUNCTION_LABEL_RE,
  ROLE_INTEREST_LABEL_RE,
  FULL_TIME_STUDENT_LABEL_RE,
  EMPLOYMENT_TYPE_LABEL_RE,
  ENG_ROLES_LABEL_RE,
  TECH_SKILLS_LABEL_RE,
} from "./patterns/applicationScreening.js";
import {
  readControlValue,
  readLiveControlValue,
  controlCommittedOnPage,
  interactWidget,
} from "./primitives/interactWidget.js";
import { readSalaryFromPage, JOBLEADS_SELECTORS } from "./primitives/comboboxWidget.js";
import {
  scopedDialog,
  visible,
  commitPendingSelection,
  verifyControlCommitted,
  mapLabelToType,
  resolveValueForControl,
  learnedSkillsForContext,
} from "./layers/fillWidgets/shared.js";
import { fillTextControl, fillContentEditable } from "./layers/fillWidgets/text.js";
import { fillSelectControl } from "./layers/fillWidgets/select.js";
import { fillComboboxControl, fillComboboxByLabel } from "./layers/fillWidgets/combobox.js";
import { fillTypeaheadControl } from "./layers/fillWidgets/typeahead.js";
import { fillYesNoControl } from "./layers/fillWidgets/yesNo.js";
import { fillRadioGroup, fillApplicationRadio } from "./layers/fillWidgets/radio.js";
import { fillCheckboxGroup } from "./layers/fillWidgets/checkbox.js";
import { fillReactSelectMulti } from "./layers/fillWidgets/reactSelect.js";
import { fillDateControl } from "./layers/fillWidgets/date.js";
import { fillPronounCheckboxGroup } from "./layers/fillWidgets/pronoun.js";

export { readControlValue, readLiveControlValue, controlCommittedOnPage as salaryCommittedOnPage };
export { fillComboboxByLabel, commitPendingSelection };

async function replayLearnedSkill(page, skill, context, log, snap = null) {
  if (!skill) return null;
  const mappedTo = skill.mappedTo || skill.type;
  const value = resolveValueForControl(mappedTo, skill.label || mappedTo, context);
  if (Array.isArray(skill.steps) && skill.steps.length) {
    const ok = await replayInteractionRecipe(page, skill, log, snap);
    if (ok) {
      return { type: mappedTo, mappedTo, widgetType: skill.widgetType || "combobox", label: skill.label, source: "learned_recipe" };
    }
  }
  if (skill.widgetType === "combobox" || skill.optionStrategy === "closest_salary_band") {
    const ok = await fillComboboxControl(
      page,
      {
        label: skill.label || mappedTo,
        mappedTo,
        value,
        triggerSelector: skill.triggerSelector,
        confirmPattern: skill.confirmPattern,
        requiresConfirm: skill.requiresConfirm,
      },
      log,
      snap,
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

async function enrichControlsVisualOrder(page, controls) {
  const enriched = [];
  for (const ctrl of controls || []) {
    let top = ctrl.top ?? 1e9;
    let left = ctrl.left ?? 0;
    if (ctrl.selector) {
      const box = await page
        .locator(ctrl.selector)
        .first()
        .boundingBox()
        .catch(() => null);
      if (box) {
        top = Math.round(box.y);
        left = Math.round(box.x);
      }
    }
    enriched.push({ ...ctrl, top, left });
  }
  return sortByVisualOrder(enriched);
}

function widgetTypeForMapped(mappedTo, type = "") {
  if (
    mappedTo === "visasponsorship" ||
    mappedTo === "workauthorization" ||
    mappedTo === "willingtorelocate" ||
    mappedTo === "policyack" ||
    mappedTo === "formeremployee" ||
    mappedTo === "employeetenure" ||
    mappedTo === "volunteer" ||
    mappedTo === "contractor" ||
    mappedTo === "fulltimestudent"
  ) {
    return "yesno";
  }
  if (
    mappedTo === "remotepreference" ||
    mappedTo === "jobfunction" ||
    mappedTo === "roleinterest"
  ) {
    return "radio";
  }
  if (mappedTo === "employmenttype") return "checkbox";
  if (mappedTo === "engroles" || mappedTo === "techskills") return "combobox";
  if (mappedTo === "hidecompanies" || mappedTo === "employeerelation") return "text";
  if (mappedTo === "pronouns") return "checkbox";
  if (EEOC_MAPPED.has(mappedTo)) return "radio";
  if (mappedTo === "location" || mappedTo === "relocatelocations") return "typeahead";
  if (/salary|compensation/i.test(type)) return "combobox";
  return "text";
}

/**
 * Canonical question phrases for screening controls discovered heuristically
 * (no DOM selector). Used as `questionLabel` so `fillYesNoControl` /
 * `fillApplicationRadio` can locate the on-page radiogroup via hasText — the
 * bare mappedTo string ("visasponsorship") never matches page text.
 */
const SCREENING_QUESTION_PHRASE = {
  workauthorization: "authorized to work",
  visasponsorship: "visa sponsorship",
  remotepreference: "working remotely",
  willingtorelocate: "willing to relocate",
  policyack: "understand",
  hidecompanies: "hidden from",
  jobfunction: "job function",
  roleinterest: "kind of role",
  fulltimestudent: "full-time student",
  employmenttype: "job type",
};

/** Pref controls that must NOT be invented from bare pageText (nav "Location" poison). */
const PREF_HEURISTIC_MAPPED = new Set([
  "location",
  "relocatelocations",
  "desiredtitle",
  "salary",
  "country",
]);

function isWaasRoleUrl(snap) {
  return /\/application\/role\b/i.test(String(snap?.url || ""));
}
/** True when snap.fields / customControls carry a label matching the pattern. */
function snapHasMatchingFieldLabel(snap, re) {
  for (const f of snap?.fields || []) {
    const text = `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`.trim();
    if (text && re.test(text)) return true;
  }
  for (const c of snap?.customControls || []) {
    const text = `${c.label || ""} ${c.questionLabel || ""}`.trim();
    if (text && re.test(text)) return true;
  }
  return false;
}

/** Best on-page label text matching a screening pattern (prefer real DOM text). */
function realQuestionLabel(snap, re, mappedTo) {
  for (const f of snap?.fields || []) {
    const text = `${f.label || ""}`.trim();
    if (text && re.test(text)) return text.slice(0, 120);
  }
  for (const c of snap?.customControls || []) {
    const text = `${c.label || ""} ${c.questionLabel || ""}`.trim();
    if (text && re.test(text)) return text.slice(0, 120);
  }
  return SCREENING_QUESTION_PHRASE[mappedTo] || "";
}

/** Snap already has a real job_type checkbox group — skip phantom radio heuristic. */
function snapHasJobTypeCheckboxGroup(snap) {
  for (const c of snap?.customControls || []) {
    if (String(c.mappedTo || "").toLowerCase() === "employmenttype" && c.widgetType === "checkbox") return true;
    if (c.widgetType === "checkbox" && /full[- ]?time employee/i.test(`${c.label || ""} ${c.questionLabel || ""}`)) {
      return true;
    }
  }
  for (const f of snap?.fields || []) {
    if (/^job_type/i.test(String(f.name || ""))) return true;
  }
  return /name=.?job_type/i.test(String(snap?.pageText || ""));
}

function resolveControlWidgetType(ctrl, mappedTo, type = "") {
  const preferred = widgetTypeForMapped(mappedTo, type);
  // Never let a mis-tagged react-select combobox steal Yes/No / radio screening fills
  // (WaaS Role: fulltimestudent discovered as combobox → fill fails → Stagehand sets Yes).
  if (
    ctrl?.widgetType === "combobox" &&
    (mappedTo === "fulltimestudent" ||
      mappedTo === "jobfunction" ||
      mappedTo === "roleinterest" ||
      preferred === "yesno" ||
      preferred === "radio")
  ) {
    return preferred;
  }
  // Tech skills: never treat the proficiency radio grid as the primary control —
  // chips + proficiency are filled by the dedicated multi-select path.
  if (mappedTo === "techskills") return "combobox";
  if (ctrl?.widgetType) return ctrl.widgetType;
  return preferred;
}

/**
 * Heuristic screening / prefs controls from page text + field labels.
 * Always merged with snap unfilled controls so city typeahead does not starve
 * work-auth / visa / remote / relocate radios (WaaS Location).
 *
 * Pref controls (location/salary/title) require a matching *field* label — never
 * invent from wizard nav pageText alone ("Location" sidebar on Role step).
 */
export function discoverScreeningControlsFromSnap(snap) {
  const discovered = [];
  const seen = new Set();
  const onRole = isWaasRoleUrl(snap);
  const fieldBlob = `${(snap?.fields || [])
    .map((f) => `${f.label || ""} ${f.name || ""}`)
    .join(" ")} ${(snap?.customControls || []).map((c) => `${c.label || ""} ${c.questionLabel || ""}`).join(" ")}`.toLowerCase();
  const pageBlob = `${snap?.pageText || ""} ${snap?.headings || ""} ${fieldBlob}`.toLowerCase();

  for (const { re, mappedTo, type } of [...LABEL_TO_MAPPED, ...APPLICATION_LABEL_TO_MAPPED]) {
    const isPref = PREF_HEURISTIC_MAPPED.has(mappedTo);
    // Role step must never invent Location/salary/title prefs (sidebar + pageText poison).
    if (onRole && isPref) continue;
    const blob = isPref ? fieldBlob : pageBlob;
    if (!re.test(blob)) continue;
    if (isPref && !snapHasMatchingFieldLabel(snap, re)) continue;
    if (seen.has(mappedTo)) continue;
    // Skip location if snap already has it filled — still discover screening.
    const alreadyFilled = (snap?.customControls || []).some(
      (c) => String(c.mappedTo || "").toLowerCase() === mappedTo && c.filled,
    );
    if (alreadyFilled) continue;
    if (mappedTo === "employmenttype" && snapHasJobTypeCheckboxGroup(snap)) continue;
    seen.add(mappedTo);
    const questionLabel = realQuestionLabel(snap, re, mappedTo) || type;
    discovered.push({
      label: questionLabel,
      questionLabel,
      mappedTo,
      type,
      widgetType: widgetTypeForMapped(mappedTo, type),
      filled: false,
      required: true,
    });
  }
  return discovered;
}

/** Discover custom controls from snapshot or page heuristics. */
export function discoverCustomControlsFromSnap(snap) {
  const onRole = isWaasRoleUrl(snap);
  const fromSnap = (snap?.customControls || []).filter((c) => {
    if (c.filled) return false;
    // Role step never treats Location/salary/title prefs as live targets.
    if (onRole && PREF_HEURISTIC_MAPPED.has(String(c.mappedTo || "").toLowerCase())) return false;
    return true;
  });
  const heuristic = discoverScreeningControlsFromSnap(snap);

  // Merge: snap unfilled first, then heuristic mappedTo not already present.
  // Critical: do NOT early-return fromSnap alone — that starved screening radios
  // whenever the city typeahead was still unfilled in the snap.
  const seen = new Set(
    fromSnap.map((c) => String(c.mappedTo || c.type || "").toLowerCase()).filter(Boolean),
  );
  const merged = [...fromSnap];
  for (const h of heuristic) {
    const key = String(h.mappedTo || "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(h);
  }
  if (merged.length) return merged;
  return heuristic;
}

/** @param {import('playwright').Page} page */
export async function replayInteractionRecipe(page, recipe, log, snap = null) {
  if (!recipe?.steps?.length) return false;
  for (const step of recipe.steps) {
    try {
      if (step.action === "verify") {
        const mapped = recipe.mappedTo || "salary";
        if (!(await verifyControlCommitted(page, mapped, log))) return false;
        continue;
      }
      const scope =
        step.scope === "confirm_picker"
          ? scopedDialog(page, snap, "confirm_picker")
          : step.scope === "fill_parent"
            ? scopedDialog(page, snap, "fill_parent")
            : page;
      if (step.action === "click") {
        if (step.selector) {
          await scope.locator(step.selector).first().click({ timeout: 5000 });
        } else if (step.text) {
          await safeRoleLocator(scope, "button", step.text).first().click({ timeout: 5000 });
        }
        await humanPause(200, 400);
      } else if (step.action === "fill" && step.selector && step.value) {
        await scope.locator(step.selector).first().fill(step.value, { timeout: 5000 });
      }
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * @param {import('playwright').Page} page
 * @param {object} context
 * @param {{ snap?: object, learnedSkills?: object[], log?: { layer: Function }, pageCtx?: object, deferVoluntary?: boolean }} [opts]
 */
export async function fillCustomControls(page, context, opts = {}) {
  const log = opts.log || null;
  const snap = opts.snap || null;
  const pageCtx = {
    looksLikeApplyForm: true,
    pageText: snap?.pageText || "",
    headings: snap?.headings || "",
    ...(opts.pageCtx || {}),
  };
  const deferVoluntary = Boolean(opts.deferVoluntary);
  const skills = opts.learnedSkills || learnedSkillsForContext(context);
  const filled = [];
  const newSkills = [];
  const unfilled = [];

  let controls = discoverCustomControlsFromSnap(snap);
  if (deferVoluntary) {
    controls = controls.filter((c) => !isVoluntaryField(c, pageCtx));
  }
  // Never invent Location/salary/title from an empty discovery list — on Role
  // that fallback was the exact "5 unfilled prefs" regression.
  const fallbackPrefs = isWaasRoleUrl(snap)
    ? []
    : LABEL_TO_MAPPED.map(({ type, mappedTo }) => ({
        label: type,
        mappedTo,
        type,
        widgetType: mappedTo === "salary" ? "combobox" : "text",
      }));
  const targets = await enrichControlsVisualOrder(
    page,
    controls.length > 0 ? controls : fallbackPrefs,
  );
  const preferredOrder =
    opts.preferredOrder ||
    snap?._universalPreferredOrder ||
    null;
  if (Array.isArray(preferredOrder) && preferredOrder.length) {
    const rank = new Map(
      preferredOrder.map((k, i) => [String(k).toLowerCase(), i]),
    );
    targets.sort((a, b) => {
      const ka = String(a.mappedTo || a.type || "").toLowerCase();
      const kb = String(b.mappedTo || b.type || "").toLowerCase();
      const ra = rank.has(ka) ? rank.get(ka) : 999;
      const rb = rank.has(kb) ? rank.get(kb) : 999;
      if (ra !== rb) return ra - rb;
      return compareApplyFillOrder(a, b, pageCtx);
    });
  } else {
    targets.sort((a, b) => compareApplyFillOrder(a, b, pageCtx));
  }

  log?.layer("custom_controls", `discovered ${targets.length} control target(s)`, "info");

  const filledMapped = new Set();

  for (const skill of skills) {
    if (filledMapped.has(skill.mappedTo)) continue;
    const result = await replayLearnedSkill(page, skill, context, log, snap);
    if (result) {
      filled.push(result);
      filledMapped.add(skill.mappedTo);
    }
  }

  const widgetHandlers = {
    combobox: (p, spec, val, l, s) =>
      fillComboboxControl(
        p,
        {
          label: spec.label,
          mappedTo: spec.mappedTo,
          value: val,
          triggerSelector: spec.triggerSelector || spec.selector,
          requiresConfirm: spec.requiresConfirm,
          confirmPattern: spec.confirmPattern,
        },
        l,
        s,
      ),
    select: fillSelectControl,
    typeahead: (p, labelRe, val, l, s, spec) => fillTypeaheadControl(p, labelRe, val, l, s, spec),
    radio: (p, spec, val, l, s) =>
      EEOC_MAPPED.has(spec.mappedTo) ||
      APPLICATION_CONTROL_MAPPED.has(spec.mappedTo) ||
      spec.widgetType === "application_radio"
        ? fillApplicationRadio(p, spec, val, l, s)
        : fillRadioGroup(p, spec.labelRe, val, l, s),
    yesno: fillYesNoControl,
    checkbox: (p, spec, val, l, s) => {
      if (spec.mappedTo === "pronouns") return fillPronounCheckboxGroup(p, spec, val, l, s);
      if (spec.mappedTo === "employmenttype") return fillCheckboxGroup(p, spec, val, l, s);
      return fillApplicationRadio(p, spec, val, l, s);
    },
    date: fillDateControl,
    contenteditable: fillContentEditable,
    text: fillTextControl,
  };

  for (const ctrl of targets) {
    // Unmapped choice groups are handled by the semantic option-resolver, not
    // the deterministic vocabulary — never guess a value for them here.
    if (ctrl.unmapped || ctrl.mappedTo === null) continue;
    const mappedTo = String(ctrl.mappedTo || ctrl.type || "").toLowerCase();
    if (filledMapped.has(mappedTo)) continue;

    // Tech skills: never use single-select combobox (that picks ABAP from A-Z lists).
    // Chips + proficiency are owned by the multi-select / waas_skills path.
    if (mappedTo === "techskills") {
      const { waasSkillsDomLooksComplete, fillSkillProficiencyRadios, fillWaasSkillsMissing } =
        await import("./siteAdapters/waasSkillsFields.js");
      if (await waasSkillsDomLooksComplete(page)) {
        filledMapped.add(mappedTo);
        filled.push({
          type: "techskills",
          mappedTo: "techskills",
          widgetType: "combobox",
          label: ctrl.label || "techskills",
          source: "already_complete",
        });
        continue;
      }
      const skillsResult = await fillWaasSkillsMissing(page, snap, context, log);
      if (skillsResult.ok || skillsResult.alreadyComplete) {
        filledMapped.add(mappedTo);
        for (const entry of skillsResult.filled || []) filled.push(entry);
        if (!skillsResult.filled?.length) {
          await fillSkillProficiencyRadios(page, "intermediate", log);
        }
        continue;
      }
      unfilled.push({
        type: "techskills",
        mappedTo: "techskills",
        widgetType: "combobox",
        label: ctrl.label || "techskills",
        clue: ctrl.label || "techskills",
      });
      log?.layer?.(
        "custom_controls",
        `unfilled techskills (multi): ${String(ctrl.label || "").slice(0, 50)}`,
        "warn",
      );
      continue;
    }
    const label = ctrl.label || mappedTo;
    const mapping =
      mapLabelToType(label) ||
      mapApplicationLabelToMapped(mappedTo) ||
      { mappedTo, type: mappedTo };
    const value = resolveValueForControl(mapping.mappedTo, label, context);
    const labelRe = new RegExp(
      mapping.mappedTo === "desiredtitle"
        ? "desired job title|job title"
        : mapping.mappedTo === "salary"
          ? "salary|compensation|pay expect"
          : mapping.mappedTo === "location"
            ? "location|where are you|based in|what city|which city|city do you live|live in|hometown"
            : mapping.mappedTo === "relocatelocations"
              ? "where else|relocat|cities|regions|countries"
              : mapping.mappedTo === "eeocgender"
              ? "gender|eeo\\[gender\\]"
              : mapping.mappedTo === "eeocrace"
                ? "race|ethnic|eeo\\[race\\]"
                : mapping.mappedTo === "eeocveteran"
                  ? "veteran|eeo\\[veteran\\]"
                  : mapping.mappedTo === "eeocdisability"
                    ? "disabilit|eeo\\[disability\\]"
                    : mapping.mappedTo === "pronouns"
                      ? "pronoun"
                      : label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "i",
    );

    const widgetType = resolveControlWidgetType(ctrl, mapping.mappedTo, mapping.type);
    const widgetTypeResolved =
      (mapping.mappedTo === "location" || mapping.mappedTo === "relocatelocations") &&
      (widgetType === "combobox" || widgetType === "text")
        ? "typeahead"
        : widgetType;
    const spec = {
      label,
      mappedTo: mapping.mappedTo,
      type: mapping.type,
      widgetType: widgetTypeResolved,
      labelRe:
        mapping.mappedTo === "remotepreference"
          ? REMOTE_PREFERENCE_LABEL_RE
          : mapping.mappedTo === "willingtorelocate"
            ? WILLING_TO_RELOCATE_LABEL_RE
            : mapping.mappedTo === "jobfunction"
              ? JOB_FUNCTION_LABEL_RE
              : mapping.mappedTo === "roleinterest"
                ? ROLE_INTEREST_LABEL_RE
                : mapping.mappedTo === "fulltimestudent"
                  ? FULL_TIME_STUDENT_LABEL_RE
                  : mapping.mappedTo === "employmenttype"
                    ? EMPLOYMENT_TYPE_LABEL_RE
                    : mapping.mappedTo === "engroles"
                      ? ENG_ROLES_LABEL_RE
                      : mapping.mappedTo === "techskills"
                        ? TECH_SKILLS_LABEL_RE
                        : labelRe,
      selector: ctrl.selector,
      triggerSelector: ctrl.triggerSelector || ctrl.selector,
      questionLabel: ctrl.questionLabel || label,
      requiresConfirm: mapping.mappedTo === "salary" || ctrl.requiresConfirm,
      confirmPattern: ctrl.confirmPattern,
    };

    const result =
      mapping.mappedTo === "engroles" || mapping.mappedTo === "techskills"
        ? {
            ok: await (async () => {
              const scope = scopedDialog(page, snap, "fill_parent");
              const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
              let field = ctrl.selector ? root.locator(ctrl.selector).first() : null;
              if (!field || !(await visible(field))) {
                const labelMatch =
                  mapping.mappedTo === "techskills" ? TECH_SKILLS_LABEL_RE : ENG_ROLES_LABEL_RE;
                field = root
                  .locator("form div.mb-4, .field, form")
                  .filter({ hasText: labelMatch })
                  .first();
              }
              if (!(await visible(field))) return false;
              const roles = String(value || "")
                .split(/[,;|]/)
                .map((s) => s.trim())
                .filter(Boolean);
              const picks = roles.length ? roles : [value].filter(Boolean);
              const max = mapping.mappedTo === "techskills" ? 8 : 4;
              const multiOk = await fillReactSelectMulti(page, field, picks, log, max);
              if (mapping.mappedTo === "techskills") {
                const { fillSkillProficiencyRadios } = await import("./siteAdapters/waasSkillsFields.js");
                await humanPause(350, 550);
                const profOk = await fillSkillProficiencyRadios(page, "intermediate", log);
                return multiOk || profOk;
              }
              return multiOk;
            })(),
            committed: true,
          }
        : await interactWidget(page, spec, value, widgetHandlers, { snap, log });
    const ok = result.ok;

    if (ok) {
      const entry = {
        type: mapping.type,
        mappedTo: mapping.mappedTo,
        widgetType: widgetTypeResolved,
        label,
        source: "custom_controls",
        selector: ctrl.selector || ctrl.triggerSelector || "",
      };
      filled.push(entry);
      filledMapped.add(mapping.mappedTo);
      newSkills.push({
        label,
        mappedTo: mapping.mappedTo,
        widgetType: widgetTypeResolved,
        triggerSelector: ctrl.selector || ctrl.triggerSelector || "",
        optionStrategy: mapping.mappedTo === "salary" ? "closest_salary_band" : "text_match",
        requiresConfirm: mapping.mappedTo === "salary" || ctrl.requiresConfirm,
        confirmPattern: mapping.mappedTo === "salary" ? "Save" : ctrl.confirmPattern,
        successCount: MIN_CONTROL_SKILL_SUCCESS,
      });
    } else if (value || mapping.mappedTo === "salary") {
      unfilled.push({
        type: mapping.type,
        mappedTo: mapping.mappedTo,
        widgetType: widgetTypeResolved,
        label,
        clue: label,
        selector: ctrl.selector || `[role=combobox]:has-text("${label}")`,
      });
      log?.layer?.(
        "custom_controls",
        `unfilled ${mapping.mappedTo} (${widgetTypeResolved}): ${String(label).slice(0, 50)}`,
        "warn",
      );
    }
  }

  for (const mappedTo of ["salary", "location", "desiredtitle"]) {
    const live =
      mappedTo === "salary" ? await readSalaryFromPage(page) : await readLiveControlValue(page, mappedTo);
    if (!live) continue;
    const idx = unfilled.findIndex((u) => (u.mappedTo || u.type) === mappedTo);
    if (idx >= 0) unfilled.splice(idx, 1);
    if (!filledMapped.has(mappedTo)) {
      filled.push({ type: mappedTo, mappedTo, label: mappedTo, source: "live_reconcile" });
      filledMapped.add(mappedTo);
    }
  }

  return { ok: filled.length > 0, filled, unfilled, skills: newSkills };
}

export async function clickPreferencesSignupCta(page, log, layer = "custom_controls") {
  const salaryLive = (await readSalaryFromPage(page)) || (await readLiveControlValue(page, "salary"));
  if (!salaryLive) {
    log?.layer(layer, "signup CTA skipped — salary not committed", "debug");
    return false;
  }

  try {
    const jlBtn = page.locator(JOBLEADS_SELECTORS.submitButton);
    if ((await jlBtn.count()) > 0 && (await visible(jlBtn.first()))) {
      await jlBtn.first().click({ timeout: 8000, force: true });
      log?.layer(layer, "clicked JobLeads signup CTA (testid)", "info");
      return true;
    }
  } catch {
    /* fall through */
  }

  for (const pattern of SIGNUP_CTA_PATTERNS) {
    try {
      const btn = safeRoleLocator(page, "button", pattern);
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
