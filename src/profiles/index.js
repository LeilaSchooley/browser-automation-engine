import { isProfile } from "../core/profile.js";
import { APPLY_PROFILE } from "./apply.js";
import { DIRECTORY_PROFILE } from "./directory.js";
import { GENERIC_PROFILE } from "./generic.js";
import { LEGACY_PROFILE } from "./legacy.js";

export { defineProfile, extendProfile, isProfile } from "../core/profile.js";
export {
  APPLY_PROFILE,
  DIRECTORY_PROFILE,
  GENERIC_PROFILE,
  LEGACY_PROFILE,
};

export const PROFILES = Object.freeze({
  apply: APPLY_PROFILE,
  directory: DIRECTORY_PROFILE,
  generic: GENERIC_PROFILE,
  legacy: LEGACY_PROFILE,
});

export function resolveProfile(profile = "legacy") {
  if (isProfile(profile)) return profile;
  const key = String(profile || "legacy").toLowerCase();
  const resolved = PROFILES[key];
  if (!resolved) {
    throw new RangeError(
      `unknown browser engine profile "${key}" (expected ${Object.keys(PROFILES).join(", ")})`,
    );
  }
  return resolved;
}
