/**
 * Optional AI layer — LLM planner, validator, and shared contracts.
 * Core listing/auth/fill pipelines do not require this module at install time.
 */
export {
  AgentPlanSchema,
  EndStateResponseSchema,
  ValidatorResponseSchema,
  GENERIC_ACTIONS,
  HIGH_LEVEL_ACTIONS,
  RECOVERY_ACTIONS,
  parseJsonFromLlm,
} from "./contracts.js";

export { loadOptionalSharedContracts } from "./sharedBridge.js";
