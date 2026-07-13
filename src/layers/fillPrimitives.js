/**
 * Shared Playwright fill/click helpers used by auth + signup layers.
 */
import { normalizeRoleName, safeRoleLocator } from "../primitives/safeLocator.js";

/**
 * @param {import('playwright').Page} page
 * @param {string[]} selectors
 * @param {string} value
 * @param {{ log?: { layer: Function }, layer?: string, label?: string }} [opts]
 */
export async function fillFirstVisible(page, selectors, value, opts = {}) {
  const tracked = await fillFirstVisibleTracked(page, selectors, value, opts);
  return tracked.ok;
}

/**
 * Like fillFirstVisible but returns which selector matched.
 * @returns {Promise<{ ok: boolean, selector: string }>}
 */
export async function fillFirstVisibleTracked(page, selectors, value, opts = {}) {
  const { log, layer = "fill", label } = opts;
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 700 })) {
        await loc.fill(value, { timeout: 5000 });
        if (label) log?.layer(layer, `filled ${label}`, "debug");
        return { ok: true, selector: sel };
      }
    } catch {
      /* next */
    }
  }
  return { ok: false, selector: "" };
}

/**
 * Click a button/link matching any of the given RegExp patterns (role first).
 * @param {import('playwright').Page} page
 * @param {RegExp[]} patterns
 * @param {{ log?: { layer: Function }, layer?: string, roles?: string[] }} [opts]
 */
export async function clickRoleMatching(page, patterns, opts = {}) {
  const { log, layer = "fill", roles = ["button", "link"] } = opts;
  for (const pattern of patterns) {
    const safeName = normalizeRoleName(pattern);
    if (!safeName) continue;
    for (const role of roles) {
      try {
        const loc = safeRoleLocator(page, role, safeName).first();
        if (await loc.isVisible({ timeout: 800 })) {
          await loc.click({ timeout: 8000 });
          log?.layer(layer, `clicked ${role} matching ${safeName}`, "info");
          return true;
        }
      } catch {
        /* next */
      }
    }
  }
  return false;
}

/**
 * Click submit controls whose value/text matches patterns (last-matching if preferLast).
 * @param {import('playwright').Page} page
 * @param {RegExp[]} patterns
 * @param {{ log?: { layer: Function }, layer?: string, preferLast?: boolean }} [opts]
 */
export async function clickSubmitByPatterns(page, patterns, opts = {}) {
  const { log, layer = "fill", preferLast = false } = opts;
  try {
    const submits = page.locator('input[type="submit"][value], button[type="submit"]');
    const count = await submits.count();
    const order = preferLast
      ? Array.from({ length: count }, (_, i) => count - 1 - i)
      : Array.from({ length: count }, (_, i) => i);

    for (const i of order) {
      const el = submits.nth(i);
      const value = ((await el.getAttribute("value")) || (await el.innerText().catch(() => "")) || "").trim();
      if (!value) continue;
      if (patterns.some((p) => p.test(value))) {
        if (await el.isVisible({ timeout: 400 }).catch(() => false)) {
          await el.click({ timeout: 8000 });
          log?.layer(layer, `clicked submit "${value}"`, "info");
          return true;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}
