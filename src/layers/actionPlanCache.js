/**
 * Fingerprint → plan cache for repeated host affordances.
 *
 * Entry / Apply stays dynamic by default: we only replay click_apply when a proven
 * target (entryKey + href/text) is still present AND still the top-ranked candidate.
 * Bare "click_apply" cache entries (legacy / no target) are ignored.
 *
 * Continue / signup / modal require a bound text label that still exists on the page.
 * stagehand_act is never short-circuited from cache (too free-form).
 */
import { pageFingerprint } from "./formDiscovery.js";
import { recordSiteLearning, loadSiteLearnings } from "../siteLearnings.js";
import { normalizeHost } from "../host.js";
import { entryCandidateKey, rankEntryCandidates } from "./pageIntent.js";

const MEMORY_KEY = "planCache";

/** Actions that may short-circuit only with a bound on-page label. */
const BOUND_CACHE_TYPES = new Set(["click_continue", "click_modal", "click_signup"]);

function targetFromPlan(plan, extras = {}) {
  const c = plan?.targetCandidate || extras.entryCandidate || null;
  const entryKey = String(extras.entryKey || plan?.entryKey || (c ? entryCandidateKey(c) : "")).trim();
  const text = String(c?.text || plan?.entryText || extras.entryText || "").trim();
  const href = String(c?.href || plan?.entryHref || extras.entryHref || "").trim();
  if (!entryKey && !text && !href) return null;
  return { entryKey, text, href };
}

function findMatchingEntry(snap, target, context = {}) {
  if (!target || !snap) return null;
  const ranked = rankEntryCandidates(snap.entryCandidates || [], context);
  if (!ranked.length) return null;

  const match = ranked.find((c) => {
    const key = (c.entryKey || entryCandidateKey(c)).toLowerCase();
    if (target.entryKey && key === target.entryKey.toLowerCase()) return true;
    const text = String(c.text || "").toLowerCase();
    const href = String(c.href || "").toLowerCase();
    if (target.href && href && href === target.href.toLowerCase()) return true;
    if (target.text && text && text === target.text.toLowerCase()) return true;
    return false;
  });
  if (!match) return null;

  const top = ranked[0];
  const matchKey = (match.entryKey || entryCandidateKey(match)).toLowerCase();
  const topKey = (top.entryKey || entryCandidateKey(top)).toLowerCase();
  if (matchKey !== topKey) return null;
  return match;
}

function findBoundLabel(snap, entry) {
  const label = String(entry?.entryText || entry?.instruction || "").trim().toLowerCase();
  if (!label || label.length < 2) return null;
  const pools = [
    ...(snap.continueCandidates || []),
    ...(snap.modalCandidates || []),
    ...(snap.signUpCandidates || []),
    ...(snap.submitCandidates || []),
  ];
  return pools.find((c) => String(c.text || "").trim().toLowerCase() === label) || null;
}

function looksLikeAuthLand(snap) {
  const blob = `${snap?.title || ""} ${snap?.pageText || ""} ${snap?.url || ""}`.toLowerCase();
  return (
    /account\.|\/(login|signin|sign-in|auth|session)\b/.test(blob) ||
    /\b(log\s?in|sign\s?in|create an account|verify code)\b/.test(blob)
  );
}

/**
 * @param {string} hostname
 * @param {object} snap
 * @param {object} [context]
 * @param {string} [planType]
 */
export function lookupCachedPlan(hostname, snap, context = {}, planType = "") {
  const host = normalizeHost(hostname || snap?.hostname || "");
  if (!host) return null;
  const hosts = loadSiteLearnings();
  const cache = hosts[host]?.[MEMORY_KEY] || {};
  const fp = pageFingerprint(snap);
  const entry = cache[fp] || (planType ? cache[`${planType}:${fp}`] : null);
  if (!entry || (entry.successCount || 0) < 2) return null;
  if (planType && entry.type && entry.type !== planType) return null;

  const type = entry.type || "";
  if (type === "stagehand_act") return null;

  if (type === "click_apply") {
    const target = {
      entryKey: entry.entryKey || "",
      text: entry.entryText || "",
      href: entry.entryHref || "",
    };
    if (!target.entryKey && !target.text && !target.href) return null;
    const match = findMatchingEntry(snap, target, context);
    if (!match) return null;
    return {
      type: "click_apply",
      instruction: entry.instruction || "",
      reason: `cached plan (${entry.successCount}×) — click_apply "${(match.text || "").slice(0, 40)}"`,
      source: "plan-cache",
      score: 90,
      targetCandidate: match,
      entryKey: match.entryKey || entryCandidateKey(match),
    };
  }

  if (!BOUND_CACHE_TYPES.has(type)) return null;
  const bound = findBoundLabel(snap, entry);
  if (!bound) return null;

  return {
    type,
    instruction: entry.instruction || "",
    reason: `cached plan (${entry.successCount}×) — ${type} "${(bound.text || "").slice(0, 40)}"`,
    source: "plan-cache",
    score: 90,
    targetCandidate: bound,
  };
}

/**
 * Record a successful plan against the page fingerprint (high-confidence only).
 */
export function recordCachedPlan(
  hostname,
  snap,
  plan,
  { ok = false, progressed = false, afterSnap = null, entryKey = "", entryCandidate = null } = {},
) {
  if (!ok || !progressed || !plan?.type) return;
  if (!["click_apply", "click_continue", "click_modal", "click_signup"].includes(plan.type)) {
    return;
  }
  const afterUrl = String(afterSnap?.url || snap?.url || "");
  if (plan.type === "click_apply" && /ycombinator\.com\/apply\/?(\?|$)/i.test(afterUrl)) {
    return;
  }
  if (afterSnap && looksLikeAuthLand(afterSnap) && plan.type === "click_apply") {
    return;
  }

  const host = normalizeHost(hostname || snap?.hostname || "");
  if (!host) return;

  let target = null;
  if (plan.type === "click_apply") {
    target = targetFromPlan(plan, { entryKey, entryCandidate });
    if (!target) return;
    const match = findMatchingEntry(snap, target, {});
    if (!match && (snap.entryCandidates || []).length > 1) return;
  } else {
    const text = String(plan.targetCandidate?.text || plan.target || "").trim();
    if (!text) return;
    target = { entryKey: "", text, href: "" };
  }

  const fp = pageFingerprint(snap);
  const hosts = loadSiteLearnings();
  const prev = hosts[host]?.[MEMORY_KEY] || {};
  const key = fp;
  const existing = prev[key] || {};
  if (existing.type && existing.type !== plan.type) return;

  const nextEntry = {
    type: plan.type,
    instruction: String(plan.instruction || "").slice(0, 240),
    successCount: (existing.successCount || 0) + 1,
    updatedAt: new Date().toISOString(),
    entryKey: target.entryKey || existing.entryKey || "",
    entryText: target.text || existing.entryText || "",
    entryHref: target.href || existing.entryHref || "",
  };

  recordSiteLearning(host, {
    [MEMORY_KEY]: {
      ...prev,
      [key]: nextEntry,
    },
  });
}

/** Drop poisoned plan-cache entries. */
export function invalidateCachedPlans(hostname, predicate = null) {
  const host = normalizeHost(hostname || "");
  if (!host) return 0;
  const hosts = loadSiteLearnings();
  const prev = hosts[host]?.[MEMORY_KEY] || {};
  const next = {};
  let removed = 0;
  for (const [key, entry] of Object.entries(prev)) {
    const drop =
      typeof predicate === "function"
        ? predicate(key, entry)
        : entry?.type === "click_apply" && !entry?.entryKey && !entry?.entryHref && !entry?.entryText;
    if (drop) {
      removed += 1;
      continue;
    }
    next[key] = entry;
  }
  if (removed) recordSiteLearning(host, { [MEMORY_KEY]: next });
  return removed;
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
