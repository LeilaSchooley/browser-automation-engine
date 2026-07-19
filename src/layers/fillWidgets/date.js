/**
 * Date input custom control filler.
 */
import { scopedDialog } from "./shared.js";

export async function fillDateControl(page, labelRe, value, log, snap = null) {
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
