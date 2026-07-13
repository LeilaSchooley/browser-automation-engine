/**
 * Playwright accessibility snapshot distillation for LLM prompts.
 */
import { resolveDialogScope } from "./dialogScope.js";

/** @param {import('playwright').Page} page @param {object} [snap] */
export async function activeDialogAriaSnapshot(page, snap = null) {
  try {
    const dialog = resolveDialogScope(page, snap, "aria_snapshot");
    if ((await dialog.count()) === 0) return "";
    if (typeof dialog.ariaSnapshot === "function") {
      const tree = await dialog.ariaSnapshot({ timeout: 4000 }).catch(() => "");
      return String(tree || "").slice(0, 6000);
    }
  } catch {
    /* ignore */
  }
  return "";
}

/** @param {object} snap */
export function shouldAttachAriaSnapshot(snap) {
  if (!snap) return false;
  if ((snap.dialogStack || []).length > 0) return true;
  if (snap.pickerOpen) return true;
  if (hasPreferencesGateBlob(snap) && (snap.customControlCount || 0) > 0) return true;
  return false;
}

function hasPreferencesGateBlob(snap) {
  const blob = `${snap.applyModalTitle || ""} ${snap.pageText || ""}`.toLowerCase();
  return /tell us about yourself|salary expectation/i.test(blob);
}

/** @param {import('playwright').Page} page @param {object} snap */
export async function ariaContextBlock(page, snap) {
  if (!shouldAttachAriaSnapshot(snap)) return "";
  const tree = await activeDialogAriaSnapshot(page, snap);
  if (!tree) return "";
  return `\nACTIVE DIALOG ARIA TREE:\n${tree}\n`;
}
