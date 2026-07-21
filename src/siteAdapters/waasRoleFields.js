/**
 * WaaS /application/role fast path — fill by live DOM + serverErrors, not label soup.
 *
 * Always runs on the Role step (even when serverErrors is empty/stale) so we:
 * - force correct in_school (No for non-students → hides school/grad follow-ups)
 * - fill eng_type multi-select when visible
 * - fill job_type checkboxes when none checked
 * - if student path is still open, fill school name / graduation / roleinterest
 */
import { humanPause } from "../human.js";
import { getApplicationAnswers, isWaasRoleStep } from "../fillApplicationAnswers.js";
import {
  resolveJobFunctionRadioValue,
  resolveEngRolesFromTitle,
  resolveEmploymentTypeAnswer,
  resolveRoleInterestAnswer,
} from "../patterns/applicationScreening.js";
import { requiredHintsFromSnap } from "../layers/fillWidgets/choiceResolver.js";
import { fillReactSelectMulti } from "../layers/fillWidgets/reactSelect.js";
import { fillApplicationRadio } from "../layers/fillWidgets/radio.js";

const JOB_TYPE_VALUE = {
  "Full-time employee": ["fulltime"],
  Contractor: ["contract", "contractor"],
  Cofounder: ["cofounder"],
};

/** @param {import('playwright').Page} page */
async function clickRadioByNameValue(page, name, value, log) {
  const sel = `input[type='radio'][name="${name}"][value="${value}"]`;
  const loc = page.locator(sel).first();
  if ((await loc.count().catch(() => 0)) === 0) return false;
  try {
    const already = await loc.isChecked().catch(() => false);
    if (already) return true;
    const label = loc.locator("xpath=ancestor::label[1]");
    if ((await label.count()) > 0) {
      await label.first().click({ timeout: 4000 });
    } else {
      await loc.click({ timeout: 4000 });
    }
    await humanPause(200, 350);
    log?.layer?.("waas_role", `clicked ${name}=${value}`, "debug");
    return true;
  } catch {
    return false;
  }
}

/** @param {import('playwright').Page} page */
async function checkJobType(page, value, log) {
  const selectors = [
    `input[type='checkbox'][name="job_type"][value="${value}"]`,
    `input[type='checkbox'][name="job_type[]"][value="${value}"]`,
  ];
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count().catch(() => 0)) === 0) continue;
    try {
      if (await loc.isChecked().catch(() => false)) return true;
      const label = loc.locator("xpath=ancestor::label[1]");
      if ((await label.count()) > 0) await label.first().click({ timeout: 4000 });
      else await loc.click({ timeout: 4000 });
      await humanPause(200, 350);
      log?.layer?.("waas_role", `checked job_type=${value}`, "debug");
      return true;
    } catch {
      /* try next selector */
    }
  }
  return false;
}

async function anyJobTypeChecked(page) {
  const count = await page
    .locator('input[type="checkbox"][name="job_type"], input[type="checkbox"][name="job_type[]"]')
    .evaluateAll((els) => els.some((el) => el.checked))
    .catch(() => false);
  return Boolean(count);
}

/** @param {import('playwright').Page} page */
async function fillEngTypeIfVisible(page, context, log) {
  const answers = getApplicationAnswers(context);
  const roles = resolveEngRolesFromTitle(
    answers.desiredTitle,
    context?.preferences?.engRoles ?? context?.applicant?.engRoles,
  );
  const block = page
    .locator("form div.mb-4")
    .filter({ hasText: /engineering roles|choose up to four/i })
    .first();
  if ((await block.count().catch(() => 0)) === 0) return false;
  if (!(await block.isVisible().catch(() => false))) return false;
  const hidden = page.locator("input[name='eng_type']").first();
  const hiddenVal = await hidden.inputValue().catch(() => "");
  if (hiddenVal && String(hiddenVal).trim()) return true;
  // Already has chips / multi-values
  const chips = await block.locator("[class*='multi-value'], [class*='MultiValue']").count().catch(() => 0);
  if (chips > 0) return true;
  return fillReactSelectMulti(page, block, roles, log, 4);
}

function schoolNameFromContext(context) {
  const p = context?.preferences || {};
  const a = context?.applicant || context?.profile || {};
  const explicit = String(p.schoolName || a.schoolName || "").trim();
  if (explicit) return explicit;
  const education = String(p.education || a.education || p.your_education || "").trim();
  if (!education) return "";
  // "Degree | School | Year" or lines with school-ish tokens
  const lines = education.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    const parts = line.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
    const schoolish = parts.find((part) =>
      /\b(school|college|university|institute|academy|polytechnic)\b/i.test(part),
    );
    if (schoolish) return schoolish;
    if (parts.length >= 2 && parts[1].length >= 3) return parts[1];
  }
  return "";
}

function graduationFromContext(context) {
  const p = context?.preferences || {};
  const a = context?.applicant || context?.profile || {};
  const month = String(p.graduationMonth || a.graduationMonth || "").trim();
  const year = String(p.graduationYear || a.graduationYear || "").trim();
  if (month || year) return { month, year };
  const education = String(p.education || a.education || p.your_education || "").trim();
  const yearMatch = education.match(/\b(20\d{2})\b/);
  return { month: "June", year: yearMatch ? yearMatch[1] : "" };
}

/** @param {import('playwright').Page} page */
async function schoolPathVisible(page) {
  const school = page
    .locator("form")
    .getByText(/name of the school or bootcamp|school name/i)
    .first();
  return (await school.count().catch(() => 0)) > 0 && (await school.isVisible().catch(() => false));
}

/** @param {import('playwright').Page} page */
async function fillSchoolName(page, schoolName, log) {
  if (!schoolName) return false;
  const candidates = [
    page.locator('input[name="school"], input[name="school_name"], input[placeholder*="School" i]').first(),
    page
      .locator("form div.mb-4")
      .filter({ hasText: /name of the school or bootcamp/i })
      .locator("input[type='text'], input:not([type]), [role='combobox']")
      .first(),
  ];
  for (const loc of candidates) {
    if ((await loc.count().catch(() => 0)) === 0) continue;
    if (!(await loc.isVisible().catch(() => false))) continue;
    try {
      await loc.click({ timeout: 3000 });
      await loc.fill(schoolName, { timeout: 5000 });
      await humanPause(250, 400);
      // Typeahead: press Enter / click first option if a list appears
      const option = page.locator("[role='option'], [class*='suggestion'], [class*='option']").first();
      if ((await option.count().catch(() => 0)) > 0 && (await option.isVisible().catch(() => false))) {
        await option.click({ timeout: 3000 }).catch(() => {});
      } else {
        await page.keyboard.press("Enter").catch(() => {});
      }
      await humanPause(200, 350);
      log?.layer?.("waas_role", `filled school="${schoolName.slice(0, 40)}"`, "debug");
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

/** @param {import('playwright').Page} page */
async function fillGraduation(page, { month, year }, log) {
  const block = page.locator("form div.mb-4").filter({ hasText: /when do you graduate/i }).first();
  if ((await block.count().catch(() => 0)) === 0) return false;
  if (!(await block.isVisible().catch(() => false))) return false;
  let ok = false;

  const monthSelect = block.locator("select").first();
  const yearSelect = block.locator("select").nth(1);
  if ((await monthSelect.count().catch(() => 0)) > 0 && month) {
    try {
      await monthSelect.selectOption({ label: month }).catch(() => monthSelect.selectOption(month));
      ok = true;
    } catch {
      /* ignore */
    }
  }
  if ((await yearSelect.count().catch(() => 0)) > 0 && year) {
    try {
      await yearSelect.selectOption({ label: year }).catch(() => yearSelect.selectOption(year));
      ok = true;
    } catch {
      /* ignore */
    }
  }

  if (!ok && month) {
    const monthCombo = block.locator("[role='combobox'], [class*='select__control']").first();
    if (await monthCombo.isVisible().catch(() => false)) {
      try {
        await monthCombo.click({ timeout: 2000, force: true });
        await humanPause(200, 350);
        const opt = page.getByRole("option", { name: new RegExp(`^\\s*${month}`, "i") }).first();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click({ timeout: 3000 });
          ok = true;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (year) {
    const combos = block.locator("[role='combobox'], [class*='select__control']");
    const count = await combos.count().catch(() => 0);
    if (count >= 1) {
      const yearCombo = count >= 2 ? combos.nth(1) : combos.first();
      try {
        await yearCombo.click({ timeout: 2000, force: true });
        await humanPause(200, 350);
        const opt = page.getByRole("option", { name: new RegExp(`^\\s*${year}\\s*$`) }).first();
        if (await opt.isVisible().catch(() => false)) {
          await opt.click({ timeout: 3000 });
          ok = true;
        }
      } catch {
        /* ignore */
      }
    }
  }
  if (ok) log?.layer?.("waas_role", `filled graduation ${month || "?"} ${year || "?"}`, "debug");
  return ok;
}

/** @param {import('playwright').Page} page */
async function fillRoleInterestIfVisible(page, context, log) {
  const block = page
    .locator("form div.mb-4")
    .filter({ hasText: /kind of role you interested|what kind of role/i })
    .first();
  if ((await block.count().catch(() => 0)) === 0) return false;
  if (!(await block.isVisible().catch(() => false))) return false;
  const answer = resolveRoleInterestAnswer(
    context?.preferences?.roleInterest ?? context?.applicant?.roleInterest ?? "fulltime",
  );
  const label = block.locator("label").filter({ hasText: new RegExp(answer.slice(0, 24), "i") }).first();
  if (await label.isVisible().catch(() => false)) {
    await label.click({ timeout: 4000 });
    await humanPause(200, 350);
    log?.layer?.("waas_role", `clicked roleinterest`, "debug");
    return true;
  }
  return fillApplicationRadio(
    page,
    {
      label: "kind of role",
      questionLabel: "What kind of role you interested in",
      widgetType: "radio",
    },
    answer,
    log,
    null,
  );
}

/**
 * True when Role core radios/checkboxes are already set (skip re-click churn).
 * @param {import('playwright').Page} page
 */
export async function waasRoleDomLooksComplete(page) {
  const roleOk =
    (await page
      .locator('input[type="radio"][name="role"]:checked, input[type="radio"][name="job_function"]:checked')
      .count()
      .catch(() => 0)) > 0;
  const schoolOk =
    (await page
      .locator('input[type="radio"][name="in_school"]:checked, input[type="radio"][name="student"]:checked')
      .count()
      .catch(() => 0)) > 0;
  const jobOk = await anyJobTypeChecked(page);
  if (!roleOk || !schoolOk || !jobOk) return false;

  const engBlock = page
    .locator("form div.mb-4")
    .filter({ hasText: /engineering roles|choose up to four/i })
    .first();
  if ((await engBlock.count().catch(() => 0)) > 0 && (await engBlock.isVisible().catch(() => false))) {
    const hidden = await page.locator("input[name='eng_type']").inputValue().catch(() => "");
    const chips = await engBlock.locator("[class*='multi-value'], [class*='MultiValue']").count().catch(() => 0);
    if (!String(hidden || "").trim() && chips === 0) return false;
  }
  if (await schoolPathVisible(page)) return false;
  return true;
}

/**
 * Fill missing / unfilled WaaS Role fields using DOM + optional serverErrors.
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {object} context
 * @param {{ layer?: Function }} [log]
 */
export async function fillWaasRoleMissing(page, snap, context, log = null) {
  if (!isWaasRoleStep(snap)) return { ok: false, filled: [], alreadyComplete: false };

  if (await waasRoleDomLooksComplete(page)) {
    log?.layer?.("waas_role", "DOM already complete — skip re-fill", "debug");
    return { ok: true, filled: [], alreadyComplete: true };
  }

  const missing = requiredHintsFromSnap(snap);
  const answers = getApplicationAnswers(context);
  const filled = [];
  const need = (key) => !missing.length || missing.includes(key);

  // Job function — by missing key or when no role radio is checked.
  const roleChecked = await page
    .locator('input[type="radio"][name="role"]:checked, input[type="radio"][name="job_function"]:checked')
    .count()
    .catch(() => 0);
  if (need("role") || roleChecked === 0) {
    const roleVal = resolveJobFunctionRadioValue(answers.desiredTitle, context?.preferences?.jobFunction);
    for (const name of ["role", "job_function"]) {
      const before = await page
        .locator(`input[type='radio'][name="${name}"][value="${roleVal}"]`)
        .isChecked()
        .catch(() => false);
      if (await clickRadioByNameValue(page, name, roleVal, log)) {
        if (!before) {
          filled.push({ mappedTo: "jobfunction", type: "jobfunction", source: "waas_role", field: "role" });
        }
        break;
      }
    }
    await humanPause(300, 500);
  }

  // Engineering sub-roles — only when empty.
  {
    const beforeEng = await page.locator("input[name='eng_type']").inputValue().catch(() => "");
    const beforeChips = await page
      .locator("form div.mb-4")
      .filter({ hasText: /engineering roles|choose up to four/i })
      .locator("[class*='multi-value'], [class*='MultiValue']")
      .count()
      .catch(() => 0);
    if (!String(beforeEng || "").trim() && beforeChips === 0) {
      if (await fillEngTypeIfVisible(page, context, log)) {
        filled.push({ mappedTo: "engroles", type: "engroles", source: "waas_role", field: "eng_type" });
      }
    }
  }

  // Student — only click when wrong / unset (avoid unchecking via re-click churn).
  {
    const studentVal = answers.fullTimeStudent ? "yes" : "no";
    for (const name of ["in_school", "student"]) {
      const want = page.locator(`input[type='radio'][name="${name}"][value="${studentVal}"]`);
      if ((await want.count().catch(() => 0)) === 0) continue;
      const already = await want.isChecked().catch(() => false);
      if (already) break;
      if (await clickRadioByNameValue(page, name, studentVal, log)) {
        filled.push({ mappedTo: "fulltimestudent", type: "fulltimestudent", source: "waas_role", field: "in_school" });
        break;
      }
    }
    await humanPause(300, 500);
  }

  // Student follow-ups: only if the school path is still visible (Yes stuck or intentional).
  if (await schoolPathVisible(page)) {
    if (answers.fullTimeStudent) {
      const schoolName = schoolNameFromContext(context);
      if (schoolName && (await fillSchoolName(page, schoolName, log))) {
        filled.push({ mappedTo: "schoolname", type: "schoolname", source: "waas_role", field: "school" });
      }
      const grad = graduationFromContext(context);
      if (await fillGraduation(page, grad, log)) {
        filled.push({ mappedTo: "graduation", type: "graduation", source: "waas_role", field: "graduation" });
      }
      if (await fillRoleInterestIfVisible(page, context, log)) {
        filled.push({ mappedTo: "roleinterest", type: "roleinterest", source: "waas_role", field: "role_interest" });
      }
    } else {
      for (const name of ["in_school", "student"]) {
        const no = page.locator(`input[type='radio'][name="${name}"][value="no"]`);
        if ((await no.isChecked().catch(() => false))) break;
        await clickRadioByNameValue(page, name, "no", log);
      }
      await humanPause(300, 500);
      if (await schoolPathVisible(page)) {
        const schoolName = schoolNameFromContext(context) || "Not applicable";
        if (await fillSchoolName(page, schoolName, log)) {
          filled.push({ mappedTo: "schoolname", type: "schoolname", source: "waas_role", field: "school" });
        }
        const grad = graduationFromContext(context);
        if (await fillGraduation(page, grad, log)) {
          filled.push({ mappedTo: "graduation", type: "graduation", source: "waas_role", field: "graduation" });
        }
        if (await fillRoleInterestIfVisible(page, context, log)) {
          filled.push({ mappedTo: "roleinterest", type: "roleinterest", source: "waas_role", field: "role_interest" });
        }
      }
    }
  } else if (await fillRoleInterestIfVisible(page, context, log)) {
    filled.push({ mappedTo: "roleinterest", type: "roleinterest", source: "waas_role", field: "role_interest" });
  }

  if (need("job_type") || !(await anyJobTypeChecked(page))) {
    const label = resolveEmploymentTypeAnswer(context?.preferences?.employmentType ?? "");
    const jtVals = JOB_TYPE_VALUE[label] || ["fulltime"];
    for (const jtVal of jtVals) {
      if (await checkJobType(page, jtVal, log)) {
        filled.push({ mappedTo: "employmenttype", type: "employmenttype", source: "waas_role", field: "job_type" });
        break;
      }
    }
  }

  if (filled.length) {
    log?.layer?.("waas_role", `fast-path filled ${filled.map((f) => f.field).join(", ")}`, "info");
  }

  const alreadyComplete = await waasRoleDomLooksComplete(page);
  return {
    ok: filled.length > 0 || alreadyComplete,
    filled,
    alreadyComplete,
  };
}

export { isWaasRoleStep, schoolNameFromContext, schoolPathVisible };
