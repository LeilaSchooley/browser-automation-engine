/**
 * Control state helpers — empty required fields, dismiss blocking.
 */
import { hasPreferencesGateFields, preferencesGateIncomplete } from "./fillPreferences.js";
import { hasIdentityRegistrationFields } from "./fillProfile.js";

function fieldLooksEmpty(f) {
  if (!f) return true;
  if (f.filled) return false;
  if (f.type === "select" || f.widgetType === "combobox") return true;
  return true;
}

function customControlEmpty(c) {
  if (!c) return false;
  return !c.filled;
}

/** True when page still has empty required-looking controls (native or custom). */
export function hasEmptyRequiredControls(snap, fillResult = null) {
  if (!snap) return false;

  if (hasPreferencesGateFields(snap) && preferencesGateIncomplete(snap, fillResult)) {
    return true;
  }

  if (hasIdentityRegistrationFields(snap)) {
    const identityTypes = new Set(["email", "firstname", "lastname", "fullname", "password"]);
    const unfilledIdentity = (fillResult?.unfilled || []).some((u) => identityTypes.has(u.type));
    if (unfilledIdentity) return true;
    const emptyPw = (snap.passwordFieldCount || 0) > 0 && (snap.fields || []).some(
      (f) => (f.type || "").toLowerCase() === "password" && fieldLooksEmpty(f),
    );
    if (emptyPw) return true;
  }

  const emptyCustom = (snap.customControls || []).filter(customControlEmpty);
  if (emptyCustom.length > 0) return true;

  const unfilled = fillResult?.unfilled || [];
  if (unfilled.length > 0 && (fillResult?.filled?.length || 0) === 0) return true;

  if ((snap.controlCount || snap.fieldCount || 0) >= 1 && (fillResult?.filled?.length || 0) === 0) {
    const hasEmptyField = (snap.fields || []).some((f) => fieldLooksEmpty(f));
    if (hasEmptyField) return true;
  }

  return false;
}

/** Block overlay dismiss when workflow controls still need filling. */
export function shouldBlockDismissForControls(snap, fillResult = null) {
  return hasEmptyRequiredControls(snap, fillResult);
}

export function controlCount(snap) {
  if (!snap) return 0;
  return snap.controlCount ?? (snap.fieldCount || 0) + (snap.customControlCount || 0);
}
