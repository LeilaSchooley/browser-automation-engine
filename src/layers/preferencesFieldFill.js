/**
 * @deprecated Use fillCustomControls — thin wrapper for backward compatibility.
 */
import { fillCustomControls, clickPreferencesSignupCta } from "../fillCustomControls.js";
import { getPreferencesFromContext } from "../fillPreferences.js";

export { clickPreferencesSignupCta };

export async function fillPreferencesGate(page, context, log = null, opts = {}) {
  const prefs = getPreferencesFromContext(context);
  const result = await fillCustomControls(page, context, {
    log,
    snap: { pageText: "tell us about yourself salary expectations desired job title" },
  });
  const salaryDone = result.filled.some((f) => f.mappedTo === "salary" || f.type === "salary");
  return {
    ok: result.ok,
    filled: result.filled.map((f) => f.type || f.mappedTo),
    salaryDone,
    complete: salaryDone || !prefs.salary,
  };
}
