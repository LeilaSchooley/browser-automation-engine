/**
 * Generic custom control fill — combobox, listbox, contenteditable, div-button.
 * Site-agnostic; label/ARIA driven. Replays learned controlSkills first.
 */
import { getPreferencesFromContext, resolvePreferenceFillValue } from "./fillPreferences.js";
import { resolveIdentityFillValue } from "./fillProfile.js";
import { resolveApplicationAnswer, EEOC_MAPPED } from "./fillApplicationAnswers.js";
import { sortByVisualOrder } from "./fillOrder.js";
import { pickClosestSalaryOption } from "./salaryExpectation.js";
import { humanPause, humanType } from "./human.js";
import { loadSiteLearnings } from "./siteLearnings.js";
import { normalizeHost } from "./host.js";
import { resolveDialogScope, resolvePopoverScope } from "./layers/dialogScope.js";
import { normalizeRoleName, safeRoleLocator } from "./primitives/safeLocator.js";
import {
  LABEL_TO_MAPPED,
  APPLICATION_LABEL_TO_MAPPED,
  SIGNUP_CTA_PATTERNS,
  PICKER_CONFIRM_PATTERNS,
  PLACEHOLDER_RE,
  SALARY_COMMITTED_RE,
  mapLabelToMapped,
  nearbyLabelText,
  BEHAVIORAL_BUTTON_SEL,
  MIN_CONTROL_SKILL_SUCCESS,
  extractSalaryDisplay,
} from "./primitives/controlPatterns.js";
import {
  readControlValue,
  readLiveControlValue,
  verifyCommitted,
  controlCommittedOnPage,
  interactWidget,
} from "./primitives/interactWidget.js";
import { readComboboxElementValue, findSalaryPickerDialog, findPickerConfirmDialog, readSalaryFromPage, readJobLeadsSalaryField, clickSalaryPickerSave, isSalaryPickerOpen, JOBLEADS_SELECTORS, SALARY_BAND_VISIBLE_RE } from "./primitives/comboboxWidget.js";

export { readControlValue, readLiveControlValue, controlCommittedOnPage as salaryCommittedOnPage };

/** Fill combobox by label — reusable entry for salary, location pickers, etc. */
export async function fillComboboxByLabel(page, spec, context, opts = {}) {
  const mappedTo = spec.mappedTo || "custom";
  const label = spec.label || mappedTo;
  const value = spec.value ?? resolveValueForControl(mappedTo, label, context);
  const triggerSelector = spec.triggerSelector || spec.selector || "";
  const snap = opts.snap || null;
  const log = opts.log || null;

  if (triggerSelector) {
    const live = await readComboboxElementValue(page.locator(triggerSelector), mappedTo);
    if (live) {
      log?.layer("custom_controls", `${mappedTo} already committed: ${live.slice(0, 40)}`, "info");
      return { ok: true, value: live };
    }
  }

  const ok = await fillComboboxControl(
    page,
    {
      label,
      mappedTo,
      value,
      triggerSelector,
      confirmPattern: spec.confirmPattern,
      requiresConfirm: spec.requiresConfirm ?? mappedTo === "salary",
    },
    log,
    snap,
  );

  if (!ok) return { ok: false, value: "" };
  const finalValue = await readControlValue(page, mappedTo, { selector: triggerSelector });
  return { ok: Boolean(finalValue), value: finalValue };
}

const SALARY_PLACEHOLDER_RE = PLACEHOLDER_RE;

function scopedDialog(page, snap, intent = "confirm_picker") {
  return resolveDialogScope(page, snap, intent);
}

/** Commit picker selection — targets the topmost open picker dialog. */
async function resolveConfirmScope(page, snap = null) {
  try {
    const salaryPicker = findSalaryPickerDialog(page);
    if ((await salaryPicker.count().catch(() => 0)) > 0 && (await isVisible(salaryPicker))) {
      return salaryPicker;
    }

    const pickerConfirm = findPickerConfirmDialog(page);
    if ((await pickerConfirm.count().catch(() => 0)) > 0 && (await isVisible(pickerConfirm))) {
      const hasBands = (await pickerConfirm.getByText(SALARY_BAND_VISIBLE_RE).count().catch(() => 0)) > 0;
      if (hasBands) return pickerConfirm;
    }

    const dialogs = page.locator("[role='dialog'][aria-modal='true'], [role='dialog']");
    const count = await dialogs.count().catch(() => 0);
    let best = null;
    let bestZ = -1;
    for (let i = 0; i < count; i += 1) {
      const dialog = dialogs.nth(i);
      if (!(await isVisible(dialog))) continue;
      const title = (await dialog.innerText().catch(() => "")).slice(0, 80);
      const hasListbox = (await dialog.locator("[role='listbox']").count().catch(() => 0)) > 0;
      const hasSalaryBands = SALARY_BAND_VISIBLE_RE.test(title);
      const hasSave =
        (await dialog.getByRole("button", { name: /^save$/i }).count().catch(() => 0)) > 0 ||
        (await dialog.locator(BEHAVIORAL_BUTTON_SEL).filter({ hasText: /^save$/i }).count().catch(() => 0)) > 0;
      if (!hasListbox && !hasSave && !hasSalaryBands) continue;
      const z = await dialog
        .evaluate((el) => parseInt(getComputedStyle(el).zIndex, 10) || 0)
        .catch(() => 0);
      if (z >= bestZ) {
        bestZ = z;
        best = dialog;
      }
    }
    if (best) return best;
  } catch {
    /* fall through */
  }
  return scopedDialog(page, snap, "confirm_picker");
}

async function isVisible(loc) {
  return loc.isVisible({ timeout: 900 }).catch(() => false);
}

/** @deprecated use isVisible */
async function visible(loc) {
  return isVisible(loc);
}

/** Commit picker selection — searches active dialog then page. */
export async function commitPendingSelection(page, log, { confirmPattern, snap = null, pageState = null } = {}) {
  if (await clickSalaryPickerSave(page, log)) {
    await humanPause(320, 520);
    await findSalaryPickerDialog(page).waitFor({ state: "hidden", timeout: 3000 }).catch(() => {});
    return true;
  }

  const dialog = await resolveConfirmScope(page, snap);
  const pickerScoped =
    !!snap?.pickerOpen ||
    (await dialog.locator("[role='listbox']").count().catch(() => 0)) > 0 ||
    (await findSalaryPickerDialog(page).count().catch(() => 0)) > 0 ||
    (snap?.dialogStack || []).some((d) => /salary|compensation|picker|select/i.test(d.title || ""));
  const patterns = confirmPattern
    ? [new RegExp(confirmPattern, "i")]
    : PICKER_CONFIRM_PATTERNS;

  const candidates = pageState?.confirmAffordances?.length
    ? pageState.confirmAffordances
    : (snap?.confirmCandidates || []).slice(0, 6).map((c) => ({ text: c.text, selector: c.selector }));

  for (const cand of candidates) {
    if (!cand.text && !cand.selector) continue;
    try {
      if (cand.selector) {
        const loc = dialog.locator(cand.selector).first();
        if ((await loc.count()) > 0 && (await visible(loc))) {
          await loc.click({ timeout: 4000, force: true });
          log?.layer("custom_controls", `confirmed via candidate ${cand.text || cand.selector}`, "info");
          await humanPause(250, 450);
          return true;
        }
      }
      const textRe = normalizeRoleName(String(cand.text || "").slice(0, 40));
      if (!textRe) continue;
      const btn = safeRoleLocator(dialog, "button", textRe);
      if ((await btn.count()) > 0 && (await visible(btn.first()))) {
        await btn.first().click({ timeout: 4000 });
        log?.layer("custom_controls", `confirmed via scored button ${cand.text}`, "info");
        await humanPause(250, 450);
        return true;
      }
    } catch {
      /* next */
    }
  }

  for (const pattern of patterns) {
    try {
      const inDialog = safeRoleLocator(dialog, "button", pattern);
      if ((await inDialog.count()) > 0 && (await visible(inDialog.first()))) {
        await inDialog.first().click({ timeout: 4000, force: true });
        log?.layer("custom_controls", `confirmed picker via button ${pattern}`, "info");
        await humanPause(320, 520);
        await findSalaryPickerDialog(page).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
        return true;
      }
      const safePat = normalizeRoleName(pattern);
      const divBtn = dialog.locator(BEHAVIORAL_BUTTON_SEL).filter({ hasText: safePat || pattern });
      if ((await divBtn.count()) > 0 && (await visible(divBtn.first()))) {
        await divBtn.first().click({ timeout: 4000, force: true });
        log?.layer("custom_controls", `confirmed picker via div-button ${pattern}`, "info");
        await humanPause(320, 520);
        await findSalaryPickerDialog(page).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
        return true;
      }
      if (!pickerScoped) {
        const stacked = findPickerConfirmDialog(page);
        const stackCount = await stacked.count().catch(() => 0);
        for (let i = stackCount - 1; i >= 0; i -= 1) {
          const layer = stacked.nth(i);
          if (!(await visible(layer))) continue;
          const saveInLayer = safeRoleLocator(layer, "button", pattern);
          if ((await saveInLayer.count()) > 0 && (await visible(saveInLayer.first()))) {
            await saveInLayer.first().click({ timeout: 4000, force: true });
            log?.layer("custom_controls", `confirmed picker via stacked dialog button ${pattern}`, "info");
            await humanPause(320, 520);
            await findSalaryPickerDialog(page).waitFor({ state: "hidden", timeout: 2500 }).catch(() => {});
            return true;
          }
        }
        const pageBtn = safeRoleLocator(page, "button", pattern);
        if ((await pageBtn.count()) > 0 && (await visible(pageBtn.first()))) {
          await pageBtn.first().click({ timeout: 4000, force: true });
          log?.layer("custom_controls", `confirmed picker via page button ${pattern}`, "info");
          await humanPause(250, 450);
          return true;
        }
      }
    } catch {
      /* next */
    }
  }
  return false;
}

async function confirmPickerSelection(page, log, opts = {}) {
  return commitPendingSelection(page, log, opts);
}

async function verifyControlCommitted(page, mappedTo, log, opts = {}) {
  return verifyCommitted(page, mappedTo, { ...opts, log });
}

function mapLabelToType(label) {
  return mapLabelToMapped(label);
}

function resolveValueForControl(mappedTo, label, context) {
  const appAnswer = resolveApplicationAnswer(mappedTo, label, context);
  if (appAnswer) return appAnswer;

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

async function collectListOptions(page, snap = null) {
  const dialog = resolvePopoverScope(page, snap);
  const scopes = [];
  const jlOverlay = page.locator(JOBLEADS_SELECTORS.salaryOverlay).filter({ has: page.getByText(/^salary$/i) });
  if ((await jlOverlay.count().catch(() => 0)) > 0) scopes.push({ scope: jlOverlay.last(), salaryBands: true });
  const salaryPicker = findSalaryPickerDialog(page);
  if ((await salaryPicker.count().catch(() => 0)) > 0) scopes.push({ scope: salaryPicker, salaryBands: true });
  if ((await dialog.count().catch(() => 0)) > 0) scopes.push({ scope: dialog, salaryBands: false });
  scopes.push({ scope: page, salaryBands: false });

  const locators = (scope, salaryBands = false) => {
    const list = [
      scope.locator("[role='listbox'] [role='option']"),
      scope.locator("[role='option']"),
    ];
    if (salaryBands) {
      list.push(
        scope.locator("[role='dialog'] *").filter({ hasText: SALARY_BAND_VISIBLE_RE }),
        scope.getByText(SALARY_BAND_VISIBLE_RE),
      );
    }
    list.push(
      scope.locator("[class*='dropdown'] li, [class*='menu'] li, [class*='option']"),
      scope.locator("[class*='select-menu'] li, [class*='select-menu'] button, [class*='select-menu'] div"),
    );
    return list;
  };

  for (const { scope, salaryBands } of scopes) {
    for (const loc of locators(scope, salaryBands)) {
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
  }
  return [];
}

async function openComboboxTrigger(page, labelRe, triggerSelector) {
  if (triggerSelector) {
    try {
      const el = page.locator(triggerSelector).first();
      if ((await el.count()) > 0 && (await visible(el))) {
        await el.click({ timeout: 4000, force: true });
        await humanPause(350, 600);
        return true;
      }
    } catch {
      /* fall through */
    }
  }

  const jlSalary = page.locator(JOBLEADS_SELECTORS.salaryField);
  if ((await jlSalary.count().catch(() => 0)) > 0 && (await visible(jlSalary.first()))) {
    await jlSalary.first().click({ timeout: 4000, force: true });
    await humanPause(350, 600);
    return true;
  }

  const prefsModal = page
    .locator("[role='dialog'], [aria-modal='true']")
    .filter({ hasText: /tell us about yourself|salary expectations/i });
  const candidates = [
    page.getByLabel(/salary expectations|compensation|pay expect/i),
    page.getByText(/^salary expectations$/i),
    prefsModal.locator("[role='combobox'], [aria-haspopup='listbox'], div, button, span").filter({ hasText: /^\?$/ }),
    page.getByRole("combobox", { name: /salary expectations|compensation|pay expect/i }),
    page.locator("[role='combobox']").filter({ hasText: /salary expectations/i }),
    page.locator("[aria-haspopup='listbox']").filter({ hasText: /salary expectations/i }),
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
      await el.click({ timeout: 4000, force: true });
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
  await chosen.locator.nth(chosen.index).click({ timeout: 4000, force: true });
  await humanPause(200, 350);
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

async function fillSelectControl(page, labelRe, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  try {
    const selects = root.locator("select");
    const count = await selects.count();
    for (let i = 0; i < count; i += 1) {
      const sel = selects.nth(i);
      const blob = `${await sel.getAttribute("aria-label").catch(() => "")} ${await sel.getAttribute("name").catch(() => "")}`.toLowerCase();
      if (!labelRe.test(blob) && count > 1) continue;
      await sel.selectOption({ label: value }).catch(() => sel.selectOption({ value }));
      log?.layer("custom_controls", `selected native option ${value}`, "debug");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function fillTypeaheadControl(page, labelRe, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  try {
    const input = root.locator("[role='combobox'] input, input[role='combobox'], [aria-autocomplete]").first();
    if (!(await visible(input))) return false;
    await input.click({ timeout: 3000 });
    await humanType(input, value, page);
    await humanPause(300, 500);
    const opt = page.locator("[role='option']").filter({ hasText: new RegExp(value.slice(0, 12), "i") }).first();
    if (await visible(opt)) {
      await opt.click({ timeout: 3000 });
      return true;
    }
    await page.keyboard.press("Enter").catch(() => {});
    return true;
  } catch {
    return false;
  }
}

async function fillRadioGroup(page, labelRe, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  try {
    const radios = root.locator("[role='radiogroup'] [role='radio'], input[type='radio']");
    const count = await radios.count();
    for (let i = 0; i < count; i += 1) {
      const r = radios.nth(i);
      const blob = `${await r.getAttribute("aria-label").catch(() => "")} ${await r.innerText().catch(() => "")}`;
      if (!labelRe.test(blob) && !new RegExp(value, "i").test(blob)) continue;
      await r.click({ timeout: 3000 });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function fillYesNoControl(page, spec, value, log, snap = null) {
  if (!value) return false;
  const raw = String(value).trim();
  const answer = /^(yes|y|true|1)$/i.test(raw) ? "Yes" : /^(no|n|false|0)$/i.test(raw) ? "No" : raw;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;

  try {
    let container = spec.selector ? root.locator(spec.selector).first() : null;
    if (!container || !(await visible(container))) {
      const labelSnippet = (spec.questionLabel || spec.label || "")
        .slice(0, 50)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      if (!labelSnippet) return false;
      const entry = root
        .locator('[class*="ashby-application-form-field-entry"], fieldset, [data-field-id]')
        .filter({ hasText: new RegExp(labelSnippet, "i") })
        .first();
      container = entry.locator('[class*="yesno" i]').first();
      if (!(await visible(container))) container = entry;
    }
    if (!(await visible(container))) return false;
    const btn = container
      .locator(BEHAVIORAL_BUTTON_SEL)
      .filter({ hasText: new RegExp(`^\\s*${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "i") })
      .first();
    if (!(await visible(btn))) return false;
    await btn.click({ timeout: 4000 });
    await humanPause(200, 350);
    return true;
  } catch {
    return false;
  }
}

async function fillApplicationRadio(page, spec, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  const labelSnippet = (spec.questionLabel || spec.label || "")
    .slice(0, 50)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declineRe = /decline|do not (want to )?answer|prefer not|choose not|self[- ]?identify/i;
  const answerRe = declineRe.test(String(value)) ? declineRe : new RegExp(String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  try {
    let field = spec.selector ? root.locator(spec.selector).first() : null;
    if (!field || !(await visible(field))) {
      field = root
        .locator('fieldset, [class*="ashby-application-form-field-entry"]')
        .filter({ hasText: new RegExp(labelSnippet, "i") })
        .first();
    }
    if (!(await visible(field))) return false;

    const labelOpt = field.locator("label").filter({ hasText: answerRe }).first();
    if (await visible(labelOpt)) {
      await labelOpt.click({ timeout: 4000 });
      await humanPause(200, 350);
      return true;
    }
    const textOpt = field.getByText(answerRe).first();
    if (await visible(textOpt)) {
      await textOpt.click({ timeout: 4000 });
      await humanPause(200, 350);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function fillDateControl(page, labelRe, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  try {
    const inputs = root.locator("input[type='date'], input[type='datetime-local']");
    const count = await inputs.count();
    for (let i = 0; i < count; i += 1) {
      const input = inputs.nth(i);
      const blob = `${await input.getAttribute("aria-label").catch(() => "")} ${await input.getAttribute("name").catch(() => "")}`;
      if (!labelRe.test(blob) && count > 1) continue;
      await input.fill(String(value).slice(0, 10), { timeout: 5000 });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

async function fillComboboxControl(page, { label, mappedTo, value, triggerSelector, confirmPattern, requiresConfirm }, log, snap = null) {
  if (!value && mappedTo !== "salary" && mappedTo !== "custom") return false;

  if (mappedTo === "salary" || mappedTo === "custom") {
    const jlLive = await readJobLeadsSalaryField(page);
    if (jlLive) {
      log?.layer("custom_controls", `jobleads salary already set: ${jlLive.slice(0, 40)}`, "info");
      return true;
    }
    if (!triggerSelector) triggerSelector = JOBLEADS_SELECTORS.salaryField;
  }

  const labelRe = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const needsConfirm = requiresConfirm !== false && (mappedTo === "salary" || requiresConfirm === true);
  const fillValue = value || (mappedTo === "salary" ? "" : "");

  if (await openComboboxTrigger(page, labelRe, triggerSelector)) {
    const options = await collectListOptions(page, snap);
    if (options.length && (await selectFromOptions(page, options, fillValue || value, mappedTo, log))) {
      if (needsConfirm) {
        const verifyOpts = { selector: triggerSelector, log };
        await humanPause(320, 520);
        if (await verifyControlCommitted(page, mappedTo === "custom" ? "salary" : mappedTo, log, verifyOpts)) {
          return true;
        }
        await commitPendingSelection(page, log, { confirmPattern, snap });
        await humanPause(500, 800);
        const verifyMapped = mappedTo === "custom" ? "salary" : mappedTo;
        if (await verifyControlCommitted(page, verifyMapped, log, verifyOpts)) {
          return true;
        }
        const liveSalary =
          mappedTo === "salary" || mappedTo === "custom" ? await readSalaryFromPage(page) : "";
        if (liveSalary && (await isSalaryPickerOpen(page)) === false) {
          log?.layer("custom_controls", `${mappedTo} committed (modal read): ${liveSalary.slice(0, 40)}`, "info");
          return true;
        }
        const prefsText = await page
          .locator("[role='dialog'], [aria-modal='true']")
          .filter({ hasText: /tell us about yourself/i })
          .last()
          .innerText({ timeout: 2000 })
          .catch(() => "");
        if (
          prefsText &&
          /salary expectations/i.test(prefsText) &&
          !/salary expectations[^\n$€£]*\?/i.test(prefsText.replace(/\s+/g, " "))
        ) {
          const fromPrefs = extractSalaryDisplay(prefsText);
          if (fromPrefs) {
            log?.layer("custom_controls", `${mappedTo} committed (prefs text): ${fromPrefs.slice(0, 40)}`, "info");
            return true;
          }
        }
        if (mappedTo !== "salary" && mappedTo !== "custom") return true;
        log?.layer("custom_controls", `${mappedTo} not committed after confirm`, "warn");
        return false;
      }
      return true;
    }
    const combo = page.locator("[role='combobox'], input").filter({ hasText: labelRe }).first();
    if (await visible(combo) && value) {
      await combo.fill(value, { timeout: 3000 }).catch(() => {});
      await page.keyboard.press("Enter").catch(() => {});
      if (needsConfirm) {
        await confirmPickerSelection(page, log, { confirmPattern, snap });
        return verifyControlCommitted(page, mappedTo, log);
      }
      return true;
    }
  }
  if (mappedTo === "salary" && value) {
    const band = page.getByText(/\$[\d,]+|€[\d,]+|£[\d,]+|USD|negotiable|flexible/i).first();
    if (await visible(band)) {
      await band.click({ timeout: 3000 }).catch(() => {});
      if (needsConfirm) {
        await confirmPickerSelection(page, log, { confirmPattern, snap });
        return verifyControlCommitted(page, mappedTo, log);
      }
      return true;
    }
  }
  return false;
}

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
  if (fromSnap.length) return fromSnap;

  const discovered = [];
  const blob = `${snap?.pageText || ""} ${snap?.headings || ""}`.toLowerCase();
  for (const { re, mappedTo, type } of [...LABEL_TO_MAPPED, ...APPLICATION_LABEL_TO_MAPPED]) {
    if (re.test(blob) || (snap?.fields || []).some((f) => re.test(`${f.label} ${f.name}`))) {
      const widgetType =
        mappedTo === "visasponsorship"
          ? "yesno"
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
    typeahead: fillTypeaheadControl,
    radio: (p, spec, val, l, s) =>
      EEOC_MAPPED.has(spec.mappedTo) || spec.widgetType === "application_radio"
        ? fillApplicationRadio(p, spec, val, l, s)
        : fillRadioGroup(p, spec.labelRe, val, l, s),
    yesno: fillYesNoControl,
    date: fillDateControl,
    contenteditable: fillContentEditable,
    text: fillTextControl,
  };

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

    const widgetType =
      ctrl.widgetType ||
      (mapping.mappedTo === "visasponsorship"
        ? "yesno"
        : EEOC_MAPPED.has(mapping.mappedTo)
          ? "radio"
          : mapping.mappedTo === "salary"
            ? "combobox"
            : "text");
    const spec = {
      label,
      mappedTo: mapping.mappedTo,
      type: mapping.type,
      widgetType,
      labelRe,
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
        requiresConfirm: mapping.mappedTo === "salary" || ctrl.requiresConfirm,
        confirmPattern: mapping.mappedTo === "salary" ? "Save" : ctrl.confirmPattern,
        successCount: MIN_CONTROL_SKILL_SUCCESS,
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
