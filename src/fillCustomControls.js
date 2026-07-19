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

/** Discover custom controls from snapshot or page heuristics. */
export function discoverCustomControlsFromSnap(snap) {
  const fromSnap = (snap?.customControls || []).filter((c) => !c.filled);
  // Prefer snapshot controls (includes EEOC/pronouns from formDiscovery) — do not drop them
  // when prefs widgets are also present.
  if (fromSnap.length) return fromSnap;

  const discovered = [];
  const blob = `${snap?.pageText || ""} ${snap?.headings || ""}`.toLowerCase();
  for (const { re, mappedTo, type } of [...LABEL_TO_MAPPED, ...APPLICATION_LABEL_TO_MAPPED]) {
    if (re.test(blob) || (snap?.fields || []).some((f) => re.test(`${f.label} ${f.name}`))) {
      const widgetType =
        mappedTo === "visasponsorship" ||
        mappedTo === "workauthorization" ||
        mappedTo === "willingtorelocate" ||
        mappedTo === "policyack" ||
        mappedTo === "formeremployee" ||
        mappedTo === "employeetenure" ||
        mappedTo === "volunteer" ||
        mappedTo === "contractor"
          ? "yesno"
          : mappedTo === "remotepreference"
            ? "radio"
            : mappedTo === "hidecompanies" || mappedTo === "employeerelation"
              ? "text"
              : mappedTo === "pronouns"
                ? "checkbox"
                : EEOC_MAPPED.has(mappedTo)
                  ? "radio"
                  : /salary|compensation/i.test(type)
                    ? "combobox"
                    : "text";
      discovered.push({ label: type, mappedTo, type, widgetType, filled: false });
    }
  }
  return discovered;
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
  const targets = await enrichControlsVisualOrder(
    page,
    controls.length > 0
      ? controls
      : LABEL_TO_MAPPED.map(({ type, mappedTo }) => ({
          label: type,
          mappedTo,
          type,
          widgetType: mappedTo === "salary" ? "combobox" : "text",
        })),
  );
  targets.sort((a, b) => compareApplyFillOrder(a, b, pageCtx));

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
    checkbox: fillPronounCheckboxGroup,
    date: fillDateControl,
    contenteditable: fillContentEditable,
    text: fillTextControl,
  };

  for (const ctrl of targets) {
    const mappedTo = ctrl.mappedTo || ctrl.type;
    if (filledMapped.has(mappedTo)) continue;
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

    const widgetType =
      ctrl.widgetType ||
      (mapping.mappedTo === "visasponsorship" ||
      mapping.mappedTo === "workauthorization" ||
      mapping.mappedTo === "willingtorelocate" ||
      mapping.mappedTo === "policyack" ||
      mapping.mappedTo === "formeremployee" ||
      mapping.mappedTo === "employeetenure" ||
      mapping.mappedTo === "volunteer" ||
      mapping.mappedTo === "contractor"
        ? "yesno"
        : mapping.mappedTo === "remotepreference"
          ? "radio"
          : mapping.mappedTo === "hidecompanies" || mapping.mappedTo === "employeerelation"
            ? "text"
            : mapping.mappedTo === "pronouns"
              ? "checkbox"
              : EEOC_MAPPED.has(mapping.mappedTo)
                ? "radio"
                : mapping.mappedTo === "location"
                  ? "typeahead"
                  : mapping.mappedTo === "salary"
                    ? "combobox"
                    : "text");
    const widgetTypeResolved =
      mapping.mappedTo === "location" && (widgetType === "combobox" || widgetType === "text")
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
            : labelRe,
      selector: ctrl.selector,
      triggerSelector: ctrl.triggerSelector || ctrl.selector,
      questionLabel: ctrl.questionLabel || label,
      requiresConfirm: mapping.mappedTo === "salary" || ctrl.requiresConfirm,
      confirmPattern: ctrl.confirmPattern,
    };

    const result = await interactWidget(page, spec, value, widgetHandlers, { snap, log });
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
