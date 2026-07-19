/**
 * Pronoun checkbox-group filler.
 */
import { scopedDialog, visible } from "./shared.js";

export async function fillPronounCheckboxGroup(page, spec, value, log, snap = null) {
  const raw = String(value || "").trim();
  if (!raw) return false;
  const scope = scopedDialog(page, snap, "fill_parent");
  const root = (await scope.count().catch(() => 0)) > 0 ? scope : page;
  try {
    let group = spec.selector ? root.locator(spec.selector).first() : null;
    if (!group || !(await visible(group))) {
      group = root.locator("#candidatePronounsCheckboxes, [data-qa='candidatePronounsCheckboxes']").first();
    }
    if (!(await visible(group))) {
      group = root.locator(".application-question").filter({ hasText: /\bpronouns?\b/i }).first();
    }
    if (!(await visible(group))) return false;

    const compact = raw.replace(/\s+/g, "").toLowerCase();
    const escape = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fuzzyRe = new RegExp(escape.replace(/\s*\/\s*/g, "\\s*/\\s*"), "i");

    let box = group.locator(`input[type="checkbox"][value="${raw.replace(/"/g, '\\"')}"]`).first();
    if (!(await box.count().catch(() => 0))) {
      box = group
        .locator("label")
        .filter({ hasText: new RegExp(`^\\s*${escape}\\s*$`, "i") })
        .locator('input[type="checkbox"]')
        .first();
    }
    if (!(await box.count().catch(() => 0))) {
      box = group.locator('input[type="checkbox"]').filter({ hasText: fuzzyRe }).first();
    }
    if (!(await box.count().catch(() => 0))) {
      const boxes = group.locator('input[type="checkbox"]');
      const n = await boxes.count();
      for (let i = 0; i < n; i += 1) {
        const b = boxes.nth(i);
        const v = ((await b.getAttribute("value").catch(() => "")) || "").replace(/\s+/g, "").toLowerCase();
        if (v === compact || fuzzyRe.test(v)) {
          box = b;
          break;
        }
      }
    }
    // Fallback: "Use name only" when preferred pronouns option missing.
    if (!(await box.count().catch(() => 0)) && !/use name only/i.test(raw)) {
      box = group.locator('input[type="checkbox"][value="Use name only"], #useNameOnlyPronounsOption').first();
    }
    if (!(await box.count().catch(() => 0))) return false;

    const checked = await box.isChecked().catch(() => false);
    if (!checked) {
      await box.check({ force: true }).catch(async () => {
        await box.click({ force: true, timeout: 3000 });
      });
      // Lever sometimes needs the label / span click.
      if (!(await box.isChecked().catch(() => false))) {
        const label = group.locator("label").filter({ has: box }).first();
        await label.click({ force: true, timeout: 3000 }).catch(() => {});
      }
    }
    const ok = await box.isChecked().catch(() => false);
    if (ok) log?.layer("custom_controls", `checked pronoun ${raw}`, "debug");
    return ok;
  } catch {
    return false;
  }
}
