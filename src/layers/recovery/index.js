/**
 * Recovery facade — re-exports semantic / control / navigation / obstacle recovery
 * plus shared stall predicates. Existing module paths remain valid.
 */

export {
  recoveryToPlanType,
  modalHasDismissControl,
  shouldEscalateToAi,
  shouldAiOverrideHeuristic,
  deriveRecoveryPlan,
  attemptSemanticRecovery,
  attemptFinalRecovery,
} from "../semanticRecovery.js";

export { attemptImmediateControlRecovery } from "../controlRecovery.js";

export {
  getTriedEntryKeys,
  enrichContextWithLearnings,
  probeSubmitPaths,
  clickRankedEntry,
  recoverFromWrongNavigation,
  shouldAttemptNavRecovery,
} from "../navigationRecovery.js";

export {
  checkBlockingCheckboxes,
  clickDismissibleOverlay,
  attemptObstacleRecovery,
  pageNeedsObstaclePass,
  reinspectAfterObstacle,
} from "../obstacleActions.js";

export { RecoveryTracker, recoveryEscalateFromHistory } from "../../recoveryTracker.js";

export {
  validatorRecentlyRejected,
  repeatedActionWithoutProgress,
  runStuckFillRecovery,
} from "./stallPredicates.js";
