/**
 * Radio / application-radio custom control fillers.
 */
import { humanPause } from "../../human.js";
import { EEOC_DECLINE_OPTION_RE } from "../../primitives/controlPatterns.js";
import { scopedDialog, visible } from "./shared.js";
import { clickYesNoInContainer } from "./yesNo.js";
import { fillReactSelectInScope } from "./reactSelect.js";

export async function fillRadioGroup(page, labelRe, value, log, snap = null) {
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

export async function fillApplicationRadio(page, spec, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  const labelSnippet = (spec.questionLabel || spec.label || "")
    .slice(0, 72)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declineRe = EEOC_DECLINE_OPTION_RE;
  const raw = String(value).trim();
  const yesNo = /^(yes|y|true|1)$/i.test(raw) ? "Yes" : /^(no|n|false|0)$/i.test(raw) ? "No" : null;
  const answerRe = declineRe.test(raw)
    ? declineRe
    : yesNo
      ? new RegExp(`^\\s*${yesNo}\\s*$`, "i")
      : new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  try {
    let field = spec.selector ? root.locator(spec.selector).first() : null;
    if (!field || !(await visible(field))) {
      field = root
        .locator(
          'fieldset, [class*="ashby-application-form-field-entry"], .application-question, .custom-question, [data-qa="multiple-choice"], .field, [class*="field" i], [role="radiogroup"], form div.mb-4, form > div > div',
        )
        .filter({ hasText: new RegExp(labelSnippet, "i") })
        .first();
    }
    if (!(await visible(field))) {
      // Last resort: any block containing the question text (WaaS plain div wrappers).
      field = root.locator("div, section, li").filter({ hasText: new RegExp(labelSnippet, "i") }).first();
    }
    if (!(await visible(field))) return false;

    if (yesNo && (await clickYesNoInContainer(field, yesNo))) {
      await humanPause(200, 350);
      return true;
    }

    const labelOpt = field.locator("label").filter({ hasText: answerRe }).first();
    if (await visible(labelOpt)) {
      await labelOpt.click({ timeout: 4000 });
      await humanPause(200, 350);
      return true;
    }
    // Prefix match: WaaS concatenates title+description ("EngineeringSoftware, hardware…").
    if (!yesNo && raw.length >= 4) {
      const prefix = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 18);
      const prefixOpt = field.locator("label").filter({ hasText: new RegExp(`^\\s*${prefix}`, "i") }).first();
      if (await visible(prefixOpt)) {
        await prefixOpt.click({ timeout: 4000 });
        await humanPause(200, 350);
        return true;
      }
    }
    const textOpt = field.getByText(answerRe).first();
    if (await visible(textOpt)) {
      await textOpt.click({ timeout: 4000 });
      await humanPause(200, 350);
      return true;
    }
    // Soft match for long remote-preference / role-interest option text.
    if (!yesNo && raw.length > 8) {
      const soft = field.getByText(new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 28), "i")).first();
      if (await visible(soft)) {
        await soft.click({ timeout: 4000 });
        await humanPause(200, 350);
        return true;
      }
    }

    // React-select fallback: WaaS renders job function / student / job type as
    // react-select comboboxes (options are not in the DOM until opened), so the
    // label-click strategies above find nothing. Open the control, then pick the
    // matching option from the popup listbox.
    if (await fillReactSelectInScope(page, field, raw, yesNo, log)) return true;
  } catch {
    /* ignore */
  }
  return false;
}

export { fillReactSelectInScope } from "./reactSelect.js";
