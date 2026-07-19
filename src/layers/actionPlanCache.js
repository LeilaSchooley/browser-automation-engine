/**
 * Fingerprint → plan cache for repeated host affordances (Stagehand v3-style local reuse).
 */
import { pageFingerprint } from "./formDiscovery.js";
import { recordSiteLearning, loadSiteLearnings } from "../siteLearnings.js";
import { normalizeHost } from "../host.js";

const MEMORY_KEY = "planCache";

/**
 * @param {string} hostname
 * @param {object} snap
 * @param {string} planType
 */
export function lookupCachedPlan(hostname, snap, planType = "") {
  const host = normalizeHost(hostname || snap?.hostname || "");
  if (!host) return null;
  const hosts = loadSiteLearnings();
  const cache = hosts[host]?.[MEMORY_KEY] || {};
  const fp = pageFingerprint(snap);
  const entry = cache[fp] || (planType ? cache[`${planType}:${fp}`] : null);
  if (!entry || (entry.successCount || 0) < 2) return null;
  if (planType && entry.type && entry.type !== planType) return null;
  return {
    type: entry.type,
    instruction: entry.instruction || "",
    reason: `cached plan (${entry.successCount}×) — ${entry.type}`,
    source: "plan-cache",
    score: 90,
  };
}

/**
 * Record a successful plan against the page fingerprint (high-confidence only).
 */
export function recordCachedPlan(hostname, snap, plan, { ok = false, progressed = false } = {}) {
  if (!ok || !progressed || !plan?.type) return;
  if (!["click_apply", "click_continue", "click_modal", "stagehand_act", "click_signup"].includes(plan.type)) {
    return;
  }
  const host = normalizeHost(hostname || snap?.hostname || "");
  if (!host) return;
  const fp = pageFingerprint(snap);
  const hosts = loadSiteLearnings();
  const prev = hosts[host]?.[MEMORY_KEY] || {};
  const key = fp;
  const existing = prev[key] || {};
  if (existing.type && existing.type !== plan.type) return;
  const next = {
    ...prev,
    [key]: {
      type: plan.type,
      instruction: String(plan.instruction || "").slice(0, 240),
      successCount: (existing.successCount || 0) + 1,
      updatedAt: new Date().toISOString(),
    },
  };
  recordSiteLearning(host, { [MEMORY_KEY]: next });
}

/**
 * Persist negative entry keys for mailto / batch-apply / SSO traps.
 */
export function recordNegativeEntryKeys(hostname, candidates = []) {
  const host = normalizeHost(hostname || "");
  if (!host || !candidates.length) return;
  const keys = [];
  for (const c of candidates) {
    const href = String(c.href || "");
    const text = String(c.text || c.aria || "");
    if (/^\s*(mailto:|tel:)/i.test(href)) {
      keys.push(`${text}|${c.testId || ""}|${c.selector || ""}`.toLowerCase());
    }
    if (/ycombinator\.com\/apply\/?$/i.test(href) || /apply (for|to) (fall|winter|spring|summer|yc)\b/i.test(text)) {
      keys.push(`${text}|${c.testId || ""}|${c.selector || ""}`.toLowerCase());
    }
    if (/linkedin\.com|accounts\.google|appleid\.apple|facebook\.com\/login/i.test(href)) {
      keys.push(`${text}|${c.testId || ""}|${c.selector || ""}`.toLowerCase());
    }
  }
  if (!keys.length) return;
  const hosts = loadSiteLearnings();
  const prev = hosts[host]?.avoidEntryKeys || [];
  recordSiteLearning(host, { avoidEntryKeys: [...new Set([...prev, ...keys])] });
}
