/** Quiet logger for tests — avoids console noise without changing engine code. */
export function quietLog() {
  return {
    info() {},
    warn() {},
    error() {},
    debug() {},
    layer() {},
    step() {},
  };
}
