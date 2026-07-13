/**
 * Accessibility-tree-first page perception with stable element refs and page diffing.
 */
import { getSettings } from "../runtime.js";

let refCounter = 0;
let lastSnapshot = null;

/**
 * Build a compact accessibility snapshot with stable refs (e1, e2, ...).
 * @param {import('playwright').Page} page
 * @param {object} [snap]
 */
export async function buildPagePerception(page, snap = null) {
  if (!getSettings().page_perception_enabled) {
    return { enabled: false, refs: [], diff: null, ariaTree: "" };
  }

  const refs = [];
  refCounter = 0;

  try {
    const nodes = await page.evaluate(() => {
      const out = [];
      const walk = (el, depth = 0) => {
        if (!el || depth > 12) return;
        const role = el.getAttribute?.("role") || el.tagName?.toLowerCase() || "";
        const label =
          el.getAttribute?.("aria-label") ||
          el.getAttribute?.("placeholder") ||
          el.getAttribute?.("data-testid") ||
          (el.labels?.[0]?.textContent || "").trim() ||
          "";
        const interactive =
          /button|link|combobox|textbox|checkbox|radio|listbox|option|tab|menuitem/i.test(role) ||
          el.tagName === "BUTTON" ||
          el.tagName === "A" ||
          el.tagName === "INPUT" ||
          el.tagName === "SELECT" ||
          el.tagName === "TEXTAREA" ||
          /ds-button|btn|cursor-pointer/i.test(String(el.className || ""));
        if (interactive) {
          const rect = el.getBoundingClientRect?.();
          if (rect && rect.width > 0 && rect.height > 0) {
            out.push({
              role: role.slice(0, 24),
              label: String(label || el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80),
              testId: el.getAttribute?.("data-testid") || "",
              id: el.id || "",
              tag: el.tagName?.toLowerCase() || "",
            });
          }
        }
        for (const child of el.children || []) walk(child, depth + 1);
      };
      const roots = [
        ...document.querySelectorAll("[role='dialog'], [aria-modal='true']"),
        document.body,
      ];
      const seen = new Set();
      for (const root of roots) {
        if (seen.has(root)) continue;
        seen.add(root);
        walk(root);
      }
      return out.slice(0, 64);
    });

    for (const node of nodes) {
      refCounter += 1;
      refs.push({
        refId: `e${refCounter}`,
        ...node,
        selector: node.testId
          ? `[data-testid="${node.testId}"]`
          : node.id
            ? `#${CSS.escape(node.id)}`
            : "",
      });
    }
  } catch {
    /* ignore */
  }

  let ariaTree = "";
  try {
    const dialog = page.locator("[role='dialog'], [aria-modal='true']").first();
    if ((await dialog.count()) > 0 && typeof dialog.ariaSnapshot === "function") {
      ariaTree = String(await dialog.ariaSnapshot({ timeout: 3000 }).catch(() => "")).slice(0, 6000);
    }
  } catch {
    /* ignore */
  }

  const perception = {
    enabled: true,
    refs,
    ariaTree,
    url: snap?.url || page.url(),
    pickerOpen: !!snap?.pickerOpen,
    dialogCount: snap?.dialogStack?.length || snap?.modalCount || 0,
  };

  const diff = computePageDiff(lastSnapshot, perception);
  lastSnapshot = perception;

  return { ...perception, diff };
}

/**
 * Compute delta between two perception snapshots.
 * @param {object|null} before
 * @param {object|null} after
 */
export function computePageDiff(before, after) {
  if (!before || !after) return { changed: true, addedRefs: after?.refs?.length || 0, removedRefs: 0 };
  const beforeIds = new Set((before.refs || []).map((r) => `${r.role}:${r.label}`));
  const afterIds = new Set((after.refs || []).map((r) => `${r.role}:${r.label}`));
  let added = 0;
  let removed = 0;
  for (const id of afterIds) if (!beforeIds.has(id)) added += 1;
  for (const id of beforeIds) if (!afterIds.has(id)) removed += 1;
  return {
    changed: added > 0 || removed > 0 || before.pickerOpen !== after.pickerOpen,
    addedRefs: added,
    removedRefs: removed,
    pickerToggled: before.pickerOpen !== after.pickerOpen,
  };
}

/** Whether a perception diff is too small to warrant a full inspectPage rescan. */
export function isMinorPerceptionDiff(diff) {
  return (
    !!diff &&
    !diff.changed &&
    !diff.pickerToggled &&
    (diff.addedRefs || 0) === 0 &&
    (diff.removedRefs || 0) === 0
  );
}

/** Reset cached snapshot (e.g. on navigation). */
export function resetPagePerception() {
  lastSnapshot = null;
  refCounter = 0;
}

/**
 * Refresh page snap — skip full inspectPage when perception diff shows no meaningful change.
 * @param {import('playwright').Page} page
 * @param {object} priorSnap
 * @param {Function} inspectPageFn
 * @param {{ force?: boolean }} [opts]
 */
export async function refreshSnapIfNeeded(page, priorSnap, inspectPageFn, opts = {}) {
  if (opts.force || !getSettings().page_perception_enabled || !priorSnap?._perception?.enabled) {
    return inspectPageFn(page);
  }

  const perception = await buildPagePerception(page, priorSnap).catch(() => null);
  const diff = perception?.diff;
  if (isMinorPerceptionDiff(diff)) {
    return { ...priorSnap, _perception: perception, _snapReused: true };
  }

  const snap = await inspectPageFn(page);
  if (perception?.enabled) snap._perception = perception;
  return snap;
}

/**
 * Resolve a stable ref to a Playwright locator.
 * @param {import('playwright').Page} page
 * @param {string} refId
 * @param {object[]} refs
 */
export function locatorForRef(page, refId, refs = []) {
  const entry = refs.find((r) => r.refId === refId);
  if (!entry) return null;
  if (entry.selector) return page.locator(entry.selector).first();
  if (entry.label) {
    return page.getByRole(entry.role === "link" ? "link" : "button", { name: new RegExp(entry.label.slice(0, 40), "i") }).first();
  }
  return null;
}
