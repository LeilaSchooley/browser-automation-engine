/**
 * First-visit structure learning — capture how a site exposes validation +
 * field layout so future runs prefer authoritative signals over text heuristics.
 */
import { hostnameFromUrl } from "./host.js";
import { recordSiteLearning, loadSiteLearnings } from "./siteLearnings.js";
import { getAuthoritativeValidation, isWaasHost } from "./siteAdapters/waasValidator.js";
import { isLocationValueCommitted } from "./layers/perception/filledState.js";

function stepKeyFromUrl(url = "") {
  try {
    const u = new URL(url);
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return String(url || "").slice(0, 120);
  }
}

/**
 * Build a structural snapshot for the current wizard step.
 * @param {import('playwright').Page} page
 * @param {object} snap
 */
export async function learnSiteStructure(page, snap) {
  const url = snap?.url || page?.url?.() || "";
  const hostname = snap?.hostname || hostnameFromUrl(url);
  if (!hostname) return null;

  const validation = isWaasHost(hostname)
    ? snap?.waasValidation || (await getAuthoritativeValidation(page))
    : { available: false, validationSource: "domState" };

  const fields = (snap?.customControls || []).slice(0, 24).map((c) => ({
    mappedTo: c.mappedTo || c.type || "",
    widgetType: c.widgetType || "",
    label: String(c.label || "").slice(0, 80),
    filled: !!c.filled,
  }));

  const requiredOrder = (snap?.customControls || [])
    .filter((c) => c.required || !c.filled)
    .map((c) => String(c.mappedTo || c.type || "").toLowerCase())
    .filter(Boolean);

  const structure = {
    urlPattern: stepKeyFromUrl(url),
    validationSource: validation.validationSource || (validation.available ? "serverErrors" : "domState"),
    activeSection: validation.activeSection || "",
    missingKeys: validation.missing || [],
    /** Durable chronological fill order for the next visit (fast path). */
    requiredOrder: [...new Set(requiredOrder)],
    fieldCount: snap?.fieldCount || 0,
    customControlCount: (snap?.customControls || []).length,
    fields,
    learnedAt: new Date().toISOString(),
  };

  return { hostname, structure };
}

/**
 * Persist learned step structure (merge by urlPattern per host).
 * `requiredOrder` is written only after a verified advance (`opts.afterAdvance`).
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {{ log?: { layer?: Function }, requiredOrder?: string[], afterAdvance?: boolean, persistRequiredOrder?: boolean }} [opts]
 */
export async function maybeLearnSiteStructure(page, snap, opts = {}) {
  const learned = await learnSiteStructure(page, snap);
  if (!learned?.hostname || !learned.structure) return null;

  const persistOrder = Boolean(opts.afterAdvance || opts.persistRequiredOrder);
  if (persistOrder && Array.isArray(opts.requiredOrder) && opts.requiredOrder.length) {
    learned.structure.requiredOrder = [
      ...new Set(opts.requiredOrder.map((k) => String(k).toLowerCase()).filter(Boolean)),
    ];
  } else if (!persistOrder) {
    // Do not promote speculative order from inspect — keep prior durable order.
    learned.structure.requiredOrder = [];
  }

  const prev = loadSiteLearnings()[learned.hostname]?.stepStructures || {};
  const key = learned.structure.urlPattern;
  const merged = {
    ...prev,
    [key]: {
      ...(prev[key] || {}),
      ...learned.structure,
      // Keep the richer requiredOrder across visits; only replace after verified advance.
      requiredOrder: persistOrder
        ? learned.structure.requiredOrder?.length
          ? learned.structure.requiredOrder
          : prev[key]?.requiredOrder || []
        : prev[key]?.requiredOrder || [],
      visitCount: (prev[key]?.visitCount || 0) + 1,
    },
  };

  recordSiteLearning(learned.hostname, { stepStructures: merged });
  opts.log?.layer?.(
    "site_learn",
    `${learned.hostname}${key}: validation=${learned.structure.validationSource} fields=${learned.structure.fields?.length || 0}${persistOrder ? " requiredOrder=updated" : ""}`,
    "info",
  );
  return merged[key];
}

/**
 * Load a previously learned step structure for this URL.
 * @param {string} hostname
 * @param {string} url
 */
export function loadStepStructure(hostname, url) {
  const host = String(hostname || "").replace(/^www\./, "");
  const key = stepKeyFromUrl(url);
  const structures = loadSiteLearnings()[host]?.stepStructures || {};
  return structures[key] || null;
}

/**
 * Reconcile snap customControl `filled` bits using state-based rules when we
 * have a learned pattern that prefers domState over stale text heuristics.
 * @param {object} snap
 */
export function reconcileSnapFilledState(snap) {
  if (!snap?.customControls?.length) return snap;
  for (const c of snap.customControls) {
    if (c.widgetType === "typeahead" || c.mappedTo === "location") {
      const text = String(c.text || "").trim();
      if (text && !isLocationValueCommitted(text)) c.filled = false;
    }
    if ((c.widgetType === "radio" || c.widgetType === "yesno") && c.filled) {
      const lab = String(c.label || c.questionLabel || "");
      if (/engineer|design|product|marketing|internship|full-time|remote/i.test(lab) && lab.length > 40) {
        c.filled = false;
      }
    }
  }
  return snap;
}
