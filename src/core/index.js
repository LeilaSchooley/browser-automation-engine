export { createAgentCore, runAgentCore } from "./agentLoop.js";
export { CORE_DEFAULT_SETTINGS } from "./defaults.js";
export {
  DEFAULT_PROFILE,
  defineProfile,
  extendProfile,
  isProfile,
} from "./profile.js";

export { createLogger } from "../logger.js";
export {
  isBrowserSessionGone,
  raceUntilGone,
  isBrowserClosedError,
} from "../pageAlive.js";
export {
  escapeRegExp,
  normalizeRoleName,
  roleNameMatcher,
  safeLabelLocator,
  safeRoleLocator,
  safeTextLocator,
  shouldExactMatchName,
} from "../primitives/safeLocator.js";
