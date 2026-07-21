/**
 * Checkbox group fillers (WaaS job_type employment type, etc.).
 */
import { humanPause } from "../../human.js";
import { scopedDialog, visible } from "./shared.js";

/**
 * Click a checkbox option inside a scoped group by matching label text.
 * @param {import('playwright').Page} page
 */
export async function fillCheckboxGroup(page, spec, value, log, snap = null) {
  if (!value) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  const raw = String(value).trim();
  const answerRe = new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  const labelSnippet = (spec.questionLabel || spec.label || "")
    .slice(0, 72)
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  try {
    let field = spec.selector ? root.locator(spec.selector).first() : null;
    if (!field || !(await visible(field))) {
      field = root
        .locator("form div.mb-4, fieldset, .field, [class*='field' i]")
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

    const prefix = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 18);
    const prefixOpt = field.locator("label").filter({ hasText: new RegExp(`^\\s*${prefix}`, "i") }).first();
    if (await visible(prefixOpt)) {
      await prefixOpt.click({ timeout: 4000 });
      await humanPause(200, 350);
      return true;
    }

    const cb = field.locator(`input[type='checkbox']`).filter({ hasText: answerRe }).first();
    if (await visible(cb)) {
      await cb.click({ timeout: 4000 });
      await humanPause(200, 350);
      return true;
    }

    const byValue = field.locator(`input[type='checkbox'][value]`).first();
    const count = await field.locator("input[type='checkbox']").count().catch(() => 0);
    for (let i = 0; i < count; i += 1) {
      const box = field.locator("input[type='checkbox']").nth(i);
      const lbl = box.locator("xpath=ancestor::label[1]");
      const text = (await lbl.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (answerRe.test(text) || (prefix.length >= 3 && new RegExp(`^\\s*${prefix}`, "i").test(text))) {
        await lbl.click({ timeout: 4000 }).catch(() => box.click({ timeout: 4000 }));
        await humanPause(200, 350);
        return true;
      }
    }
    void byValue;
  } catch {
    /* ignore */
  }
  return false;
}
