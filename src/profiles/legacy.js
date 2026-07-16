import { DEFAULT_PROFILE } from "../core/profile.js";

/**
 * Backward-compatible profile used when createEngine() receives no profile.
 * It intentionally adds no settings so existing DEFAULT_SETTINGS behavior is
 * preserved exactly.
 */
export const LEGACY_PROFILE = DEFAULT_PROFILE;

export default LEGACY_PROFILE;
