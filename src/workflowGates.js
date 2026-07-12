/**
 * Workflow gates — registration, preferences, auth modals that must NEVER be dismissed as overlays.
 */
import { hasIdentityRegistrationFields } from "./fillProfile.js";
import { hasPreferencesGateFields } from "./fillPreferences.js";
import { looksLikeAuthForm } from "./layers/authActions.js";

/** Modal/step the agent must fill and advance through — not an upsell to close. */
export function isWorkflowGateModal(snap) {
  if (!snap) return false;
  if (hasPreferencesGateFields(snap)) return true;
  if (hasIdentityRegistrationFields(snap)) return true;
  if (looksLikeAuthForm(snap) && (snap.passwordFieldCount || 0) > 0) return true;

  const blob = `${snap.applyModalTitle || ""} ${snap.title || ""} ${snap.pageText || ""}`.toLowerCase();
  if (
    /tell us about yourself|create (an )?account|sign[- ]?up|registration|log in to apply/i.test(blob) &&
    ((snap.fieldCount || 0) >= 2 || (snap.customControlCount || 0) >= 1 || (snap.controlCount || 0) >= 1)
  ) {
    return true;
  }
  return false;
}

export function shouldNeverDismiss(snap) {
  return isWorkflowGateModal(snap);
}
