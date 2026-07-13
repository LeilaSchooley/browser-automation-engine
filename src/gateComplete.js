/**
 * Block advancing (Continue / Sign up) until password or preference gates are satisfied.
 */
import { hasPasswordPolicyGate } from "./passwordPolicy.js";
import { hasPreferencesGateFields, preferencesGateIncomplete, preferencesGateIncompleteLive } from "./fillPreferences.js";

/**
 * @param {object} snap
 * @param {object} [fillResult]
 * @param {import('playwright').Page} [page] — when provided, checks live password checklist
 */
export async function shouldBlockAdvance(snap, fillResult = null, page = null) {
  const prefsIncomplete = page
    ? await preferencesGateIncompleteLive(page, snap, fillResult)
    : (await import("./fillPreferences.js")).preferencesGateIncomplete(snap, fillResult);
  if (prefsIncomplete) {
    return {
      block: true,
      reason: "preferences gate — fill location, title, and salary before continuing",
      recovery: "smart_fill",
    };
  }

  if (hasPasswordPolicyGate(snap) && page) {
    const { readLivePasswordFailures } = await import("./passwordPolicy.js");
    const fails = await readLivePasswordFailures(page).catch(() => []);
    if (fails.length) {
      return {
        block: true,
        reason: `password policy incomplete (${fails.join(", ")})`,
        recovery: "auth_signup",
      };
    }
  }

  return { block: false, reason: "", recovery: null };
}

export { hasPreferencesGateFields, preferencesGateIncomplete, preferencesGateIncompleteLive, hasPasswordPolicyGate };
