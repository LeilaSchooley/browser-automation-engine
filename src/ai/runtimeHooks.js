/**
 * Lazy AI runtime hooks — planner/validator load on first use, not at engine boot.
 */

/** @type {((...args: unknown[]) => Promise<unknown>) | null} */
let _planNextAction = null;

/** @type {((...args: unknown[]) => Promise<unknown>) | null} */
let _validateAction = null;

/** @type {((...args: unknown[]) => Promise<unknown>) | null} */
let _assessEndState = null;

async function loadPlanner() {
  if (!_planNextAction) {
    const mod = await import("../layers/agentPlan.js");
    _planNextAction = mod.planNextAction;
  }
  return _planNextAction;
}

async function loadValidator() {
  if (!_validateAction || !_assessEndState) {
    const mod = await import("../layers/actionValidator.js");
    _validateAction = mod.validateActionOutcome;
    _assessEndState = mod.assessAgentEndState;
  }
  return { validateAction: _validateAction, assessEndState: _assessEndState };
}

/** Default planner — lazy import of agentPlan layer. */
export function createLazyPlanNextAction() {
  return async (...args) => {
    const fn = await loadPlanner();
    return fn(...args);
  };
}

/** Default action validator — lazy import of actionValidator layer. */
export function createLazyValidateAction() {
  return async (...args) => {
    const { validateAction } = await loadValidator();
    return validateAction(...args);
  };
}

/** Default end-state assessor — lazy import of actionValidator layer. */
export function createLazyAssessEndState() {
  return async (...args) => {
    const { assessEndState } = await loadValidator();
    return assessEndState(...args);
  };
}

/** Eager load for tests or apps that re-export AI layers synchronously. */
export async function loadAiLayers() {
  await loadPlanner();
  await loadValidator();
  return {
    planNextAction: _planNextAction,
    validateActionOutcome: _validateAction,
    assessAgentEndState: _assessEndState,
  };
}
