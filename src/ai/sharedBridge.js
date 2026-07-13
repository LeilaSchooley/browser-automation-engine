/**
 * Optional bridge to @job-apply-ai/shared when installed (job-apply-ai monorepo).
 * Returns null when the package is absent — engine uses local contracts instead.
 */
let _cached = null;
let _attempted = false;

export async function loadOptionalSharedContracts() {
  if (_attempted) return _cached;
  _attempted = true;
  try {
    const shared = await import("@job-apply-ai/shared");
    if (shared?.AgentPlanSchema && shared?.parseJsonFromLlm) {
      _cached = shared;
    }
  } catch {
    _cached = null;
  }
  return _cached;
}
