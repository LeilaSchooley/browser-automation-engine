/**
 * Per-action attempt tracking — break loops and escalate Stagehand → wait_user.
 */
export class RecoveryTracker {
  /**
   * @param {{ maxPerAction?: number, maxGlobal?: number } } [opts]
   */
  constructor(opts = {}) {
    this.maxPerAction = opts.maxPerAction ?? 3;
    this.maxGlobal = opts.maxGlobal ?? 12;
    /** @type {Map<string, number>} */
    this.attempts = new Map();
    this.total = 0;
  }

  getKey(action, pageHash = "global") {
    return `${action || "unknown"}:${pageHash || "global"}`;
  }

  record(action, pageHash) {
    const key = this.getKey(action, pageHash);
    this.attempts.set(key, (this.attempts.get(key) || 0) + 1);
    this.total += 1;
    return this.getCount(action, pageHash);
  }

  getCount(action, pageHash) {
    return this.attempts.get(this.getKey(action, pageHash)) || 0;
  }

  isLooping(action, maxAttempts, pageHash) {
    const max = maxAttempts ?? this.maxPerAction;
    return this.getCount(action, pageHash) >= max;
  }

  isGlobalExhausted() {
    return this.total >= this.maxGlobal;
  }

  /**
   * @returns {"continue" | "stagehand" | "wait_user"}
   */
  escalate(action, pageHash, { hasUsedStagehand = false } = {}) {
    if (this.isGlobalExhausted()) return "wait_user";
    if (this.isLooping(action, this.maxPerAction, pageHash)) {
      return hasUsedStagehand ? "wait_user" : "stagehand";
    }
    return "continue";
  }

  resetForPage(pageHash) {
    const suffix = `:${pageHash || "global"}`;
    for (const key of [...this.attempts.keys()]) {
      if (key.endsWith(suffix)) this.attempts.delete(key);
    }
  }

  resetAll() {
    this.attempts.clear();
    this.total = 0;
  }
}

/**
 * Derive tracker signals from history without requiring a live RecoveryTracker instance.
 */
export function recoveryEscalateFromHistory(history, action, { max = 3, hasUsedStagehand = false } = {}) {
  const count = (history || []).filter((h) => h.action === action).length;
  if (count < max) return "continue";
  return hasUsedStagehand ? "wait_user" : "stagehand";
}
