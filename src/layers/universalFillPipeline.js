/**
 * Universal sequential fill — chronological, no-skip, thrash-aware.
 *
 * Contract:
 *  1. Authoritative required list (learned → serverErrors → unfilled customs)
 *  2. Sort once (learned order + chronological bands)
 *  3. Fill via existing custom-control / site adapters (skip already committed)
 *  4. Re-scan only on unlock (caller) / limited passes here
 *  5. CompletenessOracle decides done — never "Continue enabled" alone
 */

import { compareApplyFillOrder, logicalBand } from "../fieldMapper.js";
import { fillCustomControls } from "../fillCustomControls.js";
import { loadStepStructure, maybeLearnSiteStructure } from "../siteStructureLearner.js";
import { hostnameFromUrl } from "../host.js";
import { inspectPage } from "./formDiscovery.js";
import {
  assessCompleteness,
  getAuthoritativeRequiredKeys,
  listMissingFromSnap,
} from "./CompletenessOracle.js";

/** Chronological keyword bands — lower = earlier (wizard-aware). */
export const CHRONOLOGICAL_KEYWORDS = [
  { re: /\b(full\s*)?name|chosen|preferred|pronoun/i, band: 10 },
  { re: /\bemail\b/i, band: 20 },
  { re: /\b(phone|tel|mobile)\b/i, band: 25 },
  { re: /\b(location|city|address|street|zip|postal|country)\b/i, band: 36 },
  { re: /\b(company|employer)\b/i, band: 38 },
  { re: /\b(linkedin|website|github|portfolio)\b/i, band: 45 },
  { re: /\b(role|job\s*function|jobfunction|engineering\s*role)\b/i, band: 48 },
  { re: /\b(job\s*type|employment\s*type|full[\s-]?time|part[\s-]?time)\b/i, band: 49 },
  { re: /\b(student|in[\s_-]?school|school)\b/i, band: 50 },
  { re: /\b(experience|years)\b/i, band: 52 },
  { re: /\b(skill|technolog|proficiency)\b/i, band: 53 },
  { re: /\b(visa|authoriz|sponsor)\b/i, band: 58 },
  { re: /\b(gender|race|veteran|disabilit|eeoc)\b/i, band: 61 },
  { re: /\b(resume|cv)\b/i, band: 70 },
  { re: /\b(cover\s*letter|additional)\b/i, band: 80 },
];

/**
 * Chronological sort for control-like objects ({ mappedTo, type, label, … }).
 * Prefer explicit `preferredOrder` keys when provided (learned / serverErrors).
 */
export function sortChronologically(fields, preferredOrder = null) {
  const list = Array.isArray(fields) ? [...fields] : [];
  const rank = new Map(
    (preferredOrder || []).map((k, i) => [String(k).toLowerCase(), i]),
  );

  function chronoBand(f) {
    const key = String(f?.mappedTo || f?.type || f?.name || "").toLowerCase();
    if (rank.has(key)) return rank.get(key);
    const typed = logicalBand(f);
    if (typed !== 50) return typed + 1000; // keep logical bands after preferred
    const blob = `${f?.label || ""} ${f?.questionLabel || ""} ${f?.clue || ""} ${key}`;
    for (const { re, band } of CHRONOLOGICAL_KEYWORDS) {
      if (re.test(blob)) return band + 1000;
    }
    return 1500;
  }

  return list.sort((a, b) => {
    const ca = chronoBand(a);
    const cb = chronoBand(b);
    if (ca !== cb) return ca - cb;
    return compareApplyFillOrder(a, b, { looksLikeApplyForm: true });
  });
}

/**
 * Snap-level "already committed" — do not re-click radios / retype chips.
 */
export function isAlreadyCommitted(field) {
  if (!field) return false;
  if (field.filled || field.hasValue) return true;
  const val = String(field.value || field.text || "").trim();
  if (val && field.widgetType !== "typeahead") return true;
  return false;
}

/**
 * Fingerprint missing keys for thrash detection.
 * @param {string[]} missing
 */
export function missingFingerprint(missing) {
  return JSON.stringify([...(missing || [])].map(String).sort());
}

/**
 * One (or few) chronological custom-control passes + CompletenessOracle gate.
 *
 * Does not replace native text smart_fill — call after or alongside it.
 * Returns `{ success, reason, missing, filled, snap }` so callers can advance.
 *
 * @param {import('playwright').Page} page
 * @param {object} context
 * @param {object|null} log
 * @param {{
 *   snap?: object|null,
 *   seen?: Set<string>,
 *   allFilled?: object[],
 *   maxPasses?: number,
 *   learnOnComplete?: boolean,
 * }} [opts]
 */
export async function runUniversalFill(page, context, log = null, opts = {}) {
  // One unlockable control per pass + rescan — allow enough passes for wizards.
  const maxPasses = Math.max(1, opts.maxPasses || 8);
  let snap = opts.snap || null;
  const seen = opts.seen || new Set();
  const allFilled = opts.allFilled || [];
  let lastHash = "";
  let lastFilled = [];

  const host = snap?.hostname || hostnameFromUrl(snap?.url || page.url?.() || "");
  const learned = host ? loadStepStructure(host, snap?.url || "") : null;
  let preferredOrder = [
    ...((learned?.requiredOrder?.length && learned.requiredOrder) ||
      getAuthoritativeRequiredKeys(snap, learned) ||
      []),
  ];

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const status = await assessCompleteness(page, snap, { filled: allFilled });
    if (status.complete) {
      log?.layer?.(
        "universal_fill",
        `step complete (${status.reason}) — pass ${pass + 1}`,
        "info",
      );
      // requiredOrder is learned only after verified advance (callers / P3 gate).
      if (opts.learnOnComplete === true && opts.afterAdvance === true && page && snap) {
        await maybeLearnSiteStructure(page, snap, {
          log,
          afterAdvance: true,
          requiredOrder: preferredOrder.length
            ? preferredOrder
            : listMissingFromSnap(snap).length
              ? null
              : (snap.customControls || [])
                  .map((c) => c.mappedTo || c.type)
                  .filter(Boolean),
        }).catch(() => null);
      }
      return {
        success: true,
        reason: status.reason,
        missing: [],
        filled: lastFilled,
        snap,
        preferredOrder,
      };
    }

    const hash = missingFingerprint(status.missing);
    if (pass > 0 && hash && hash === lastHash) {
      log?.layer?.("universal_fill", "no progress — stopping re-fill", "warn");
      break;
    }
    lastHash = hash;

    // Build ordered unfilled targets from snap customs.
    const unfilledControls = (snap?.customControls || []).filter((c) => !isAlreadyCommitted(c));
    const ordered = sortChronologically(unfilledControls, preferredOrder);
    if (snap) {
      // Mutate snap so fillCustomControls walks chrono order via preferredOrder.
      snap._universalPreferredOrder = preferredOrder;
    }

    log?.layer?.(
      "universal_fill",
      `pass ${pass + 1}/${maxPasses} — ${ordered.length} unfilled (order: ${ordered
        .slice(0, 8)
        .map((c) => c.mappedTo || c.type || "?")
        .join(", ")})`,
      "info",
    );

    if (!ordered.length && status.missing.length) {
      // Authoritative missing but no customControls — nothing more to do here.
      log?.layer?.(
        "universal_fill",
        `authoritative missing without controls: ${status.missing.slice(0, 6).join(", ")}`,
        "debug",
      );
      break;
    }

    // Fill at most one unlockable control per pass, then rescan (conditional fields).
    const oneShot = ordered.slice(0, 1);
    const customResult = await fillCustomControls(page, context, {
      snap: oneShot.length
        ? { ...snap, customControls: oneShot, _universalPreferredOrder: preferredOrder }
        : snap,
      log,
      preferredOrder,
      pageCtx: {
        looksLikeApplyForm: true,
        pageText: snap?.pageText || "",
        headings: snap?.headings || "",
      },
      deferVoluntary: pass === 0,
    });

    lastFilled = customResult?.filled || [];
    for (const entry of lastFilled) {
      const key = `uni:${entry.mappedTo || entry.type}:${entry.selector || ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        allFilled.push(entry);
      }
    }

    // Brief settle — unlocks (student → school) need a tick before re-assess.
    try {
      await page.waitForTimeout?.(500);
    } catch {
      /* ignore */
    }

    // Universal rescan: rebuild required queue after unlockable fill.
    if (lastFilled.length && page) {
      try {
        snap = await inspectPage(page);
        const hostNow = snap?.hostname || host;
        const learnedNow = hostNow ? loadStepStructure(hostNow, snap?.url || "") : null;
        const nextOrder =
          (learnedNow?.requiredOrder?.length && learnedNow.requiredOrder) ||
          getAuthoritativeRequiredKeys(snap, learnedNow) ||
          preferredOrder;
        preferredOrder = [...(nextOrder || [])];
        log?.layer?.(
          "universal_fill",
          `rescanned after unlock — ${ (snap?.customControls || []).filter((c) => !isAlreadyCommitted(c)).length } unfilled`,
          "debug",
        );
      } catch (err) {
        log?.layer?.("universal_fill", `rescan failed: ${err?.message || err}`, "warn");
      }
    } else {
      for (const entry of lastFilled) {
        const mapped = String(entry.mappedTo || entry.type || "").toLowerCase();
        for (const c of snap?.customControls || []) {
          if (String(c.mappedTo || c.type || "").toLowerCase() === mapped) c.filled = true;
        }
      }
    }
  }

  const finalStatus = await assessCompleteness(page, snap, { filled: allFilled });
  return {
    success: finalStatus.complete,
    reason: finalStatus.complete ? finalStatus.reason : "still_incomplete",
    missing: finalStatus.missing || [],
    filled: lastFilled,
    snap,
    preferredOrder,
  };
}
