import fs from "fs";
import path from "path";
import { normalizeHost } from "./host.js";
import { getSettings } from "./runtime.js";

/** smart_fill internal type → buildFillConfig key */
const FILL_TYPE_TO_CONFIG_KEY = {
  email: "email",
  firstname: "firstName",
  lastname: "lastName",
  fullname: "fullName",
  tel: "phone",
  coverletter: "coverLetter",
  linkedinurl: "linkedinUrl",
  website: "websiteUrl",
  resume: "resumePath",
  description: "description",
};

/** Normalize stored fieldHints — legacy { type: selector } or { selector: { mappedTo } }. */
export function normalizeFieldHints(fieldHints = {}) {
  const out = {};
  if (!fieldHints || typeof fieldHints !== "object") return out;

  for (const [key, val] of Object.entries(fieldHints)) {
    if (val && typeof val === "object" && "mappedTo" in val) {
      out[key] = val;
      continue;
    }
    if (typeof val === "string" && val) {
      const mappedTo = FILL_TYPE_TO_CONFIG_KEY[key] || key;
      out[val] = { mappedTo };
    }
  }
  return out;
}

export function mergeFieldHints(prev = {}, next = {}) {
  return { ...normalizeFieldHints(prev), ...normalizeFieldHints(next) };
}

export function mergeAuthSelectors(prev = {}, next = {}) {
  const out = { ...prev };
  for (const [kind, selectors] of Object.entries(next)) {
    if (!Array.isArray(selectors) || !selectors.length) continue;
    out[kind] = [...new Set([...(out[kind] || []), ...selectors])].slice(0, 12);
  }
  return out;
}

export function mergeModalSelectors(prev = [], next = []) {
  const list = [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(next) ? next : [])].filter(Boolean);
  return [...new Set(list)].slice(0, 16);
}

function learningsPath() {
  return getSettings().site_learnings_path || "";
}

export function loadSiteLearnings() {
  const filePath = learningsPath();
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data?.hosts && typeof data.hosts === "object" ? data.hosts : data;
  } catch {
    return {};
  }
}

export function recordSiteLearning(hostname, patch) {
  const filePath = learningsPath();
  if (!filePath || !hostname) return null;

  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  let store = { hosts: {} };
  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
      store = raw?.hosts ? raw : { hosts: raw };
    } catch {
      store = { hosts: {} };
    }
  }

  const key = normalizeHost(hostname);
  const prev = store.hosts[key] || {};

  const merged = { ...prev, ...patch };
  if (patch.fieldHints) {
    merged.fieldHints = mergeFieldHints(prev.fieldHints, patch.fieldHints);
  }
  if (patch.authSelectors) {
    merged.authSelectors = mergeAuthSelectors(prev.authSelectors, patch.authSelectors);
  }
  if (patch.modalSelectors) {
    merged.modalSelectors = mergeModalSelectors(prev.modalSelectors, patch.modalSelectors);
  }
  if (patch.avoidEntryKeys) {
    merged.avoidEntryKeys = [...new Set([...(prev.avoidEntryKeys || []), ...patch.avoidEntryKeys])];
  }

  store.hosts[key] = {
    ...merged,
    successCount: (prev.successCount || 0) + (patch.success ? 1 : 0),
    attemptCount: (prev.attemptCount || 0) + 1,
    updatedAt: new Date().toISOString(),
  };

  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  return store.hosts[key];
}

/** Convert learnings into site-mapping hints for prep/fill layers. */
export function learningsAsSiteMappings() {
  const hosts = loadSiteLearnings();
  const mappings = {};
  for (const [host, data] of Object.entries(hosts)) {
    if (!data || typeof data !== "object") continue;
    const fieldMap = normalizeFieldHints(data.fieldHints || {});
    mappings[host] = {
      ...fieldMap,
      _apply: {
        entryText: data.entryText,
        entryHref: data.entryHref,
        authRequired: data.authRequired,
        modalSteps: data.modalSelectors || [],
        avoidEntryKeys: data.avoidEntryKeys || [],
        authSelectors: data.authSelectors || {},
      },
    };
  }
  return mappings;
}

export function mergeSiteMappings(base = {}, learned = {}) {
  const out = { ...base };
  for (const [host, val] of Object.entries(learned)) {
    out[host] = { ...(out[host] || {}), ...val };
  }
  return out;
}
