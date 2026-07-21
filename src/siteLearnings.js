import fs from "fs";
import path from "path";
import { normalizeHost } from "./host.js";
import { getSettings } from "./runtime.js";
import { looksLikeJobBoardIndex } from "./heuristics.js";

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
  const out = {};
  const kinds = new Set([...Object.keys(prev || {}), ...Object.keys(next || {})]);
  for (const kind of kinds) {
    const merged = [...(prev[kind] || []), ...(next[kind] || [])]
      .map((s) => String(s || "").trim())
      .filter((s) => s && !isVolatileSelector(s));
    if (!merged.length) continue;
    out[kind] = [...new Set(merged)].slice(0, 12);
  }
  return out;
}

export function mergeModalSelectors(prev = [], next = []) {
  const list = [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(next) ? next : [])].filter(Boolean);
  return [...new Set(list)].slice(0, 16);
}

function skillKey(skill) {
  return `${String(skill.mappedTo || skill.label || "").toLowerCase()}::${String(skill.label || "").toLowerCase()}`;
}

export function mergeControlSkills(prev = [], next = []) {
  const map = new Map();
  for (const s of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(next) ? next : [])]) {
    if (!s || typeof s !== "object") continue;
    const key = skillKey(s);
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        ...s,
        successCount: (existing.successCount || 0) + (s.successCount || 1),
        stagehandAction: s.stagehandAction || existing.stagehandAction,
        requiresConfirm: s.requiresConfirm ?? existing.requiresConfirm,
        confirmPattern: s.confirmPattern || existing.confirmPattern,
        steps: s.steps?.length ? s.steps : existing.steps,
      });
    } else {
      map.set(key, { ...s, successCount: s.successCount || 1 });
    }
  }
  return [...map.values()].slice(0, 20);
}

function normalizeTextSig(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

/** Volatile DOM ids (Vue/React) — do not persist for auth replay. */
export function isVolatileSelector(selector) {
  const s = String(selector || "").trim();
  if (!s) return true;
  if (/^#v-\d+(-\d+)+$/i.test(s)) return true;
  if (/^#[a-z]+-\d+(-\d+){2,}$/i.test(s)) return true;
  if (/^#[0-9a-f]{10,}$/i.test(s)) return true;
  return false;
}

/**
 * Prefer stable selectors for auth fields; drop volatile ids.
 * @param {string} selector
 * @param {{ kind?: string, type?: string, testId?: string, name?: string, autocomplete?: string }} [field]
 */
export function stableAuthSelector(selector, field = {}) {
  const raw = String(selector || "").trim();
  if (raw && !isVolatileSelector(raw)) return raw;
  if (field.testId) return `[data-testid="${String(field.testId).replace(/"/g, '\\"')}"]`;
  if (field.name) return `[name="${String(field.name).replace(/"/g, '\\"')}"]`;
  if (field.autocomplete) return `[autocomplete="${field.autocomplete}"]`;
  const kind = String(field.kind || field.type || "").toLowerCase();
  if (kind === "email") return 'input[type="email"]';
  if (kind === "password" || kind === "confirm_password") return 'input[type="password"]';
  if (kind === "username") return 'input[type="text"]';
  return "";
}

export const AFFORDANCE_INTENTS = {
  ENTRY_APPLY: "entry_apply",
  WIZARD_CONTINUE: "wizard_continue",
  UPSELL_DISMISS: "upsell_dismiss",
  AUTH_SUBMIT: "auth_submit",
  BOARD_NAV: "board_nav",
  UNKNOWN: "unknown",
};

const FILL_STAGES = new Set(["form", "auth", "signup", "signup_entry"]);

/** Infer why a click worked — used for replay gating and merge keys. */
export function inferAffordanceIntent(item, snap = null, classification = null) {
  const sig = affordanceSignature(item);
  const text = sig.textNorm;
  const testId = sig.testId.toLowerCase();
  const stage = classification?.step || "";

  if (isDismissAffordanceSignature(sig)) return AFFORDANCE_INTENTS.UPSELL_DISMISS;
  if (/\b(skip|continue without|continue applying|no thanks|maybe later|not now|dismiss)\b/.test(text)) {
    return AFFORDANCE_INTENTS.UPSELL_DISMISS;
  }

  // Job-board listing row / title click (not Apply CTA).
  if (looksLikeJobBoardIndex(snap) && stage === "entry") {
    if (!/\b(apply|interested|easy apply)\b/i.test(text)) {
      return AFFORDANCE_INTENTS.BOARD_NAV;
    }
  }

  if (FILL_STAGES.has(stage) || snapHasFillableSurface(snap, classification)) {
    if (/\b(continue|sign up|register|create account|submit|log in|login)\b/.test(text)) {
      return AFFORDANCE_INTENTS.AUTH_SUBMIT;
    }
  }

  if (
    stage === "wizard_choice" ||
    /\b(have a resume|need a resume|continue with email|upload resume|start application)\b/.test(text) ||
    /continue-with-email|wizard-option|modal-cta|apply-cta/i.test(testId) ||
    /continue with email|sign up with email/i.test(text)
  ) {
    return AFFORDANCE_INTENTS.WIZARD_CONTINUE;
  }

  if (
    stage === "entry" ||
    /\b(i.?m interested|apply now|apply for|quick apply)\b/.test(text) ||
    /apply|interested/i.test(testId)
  ) {
    return AFFORDANCE_INTENTS.ENTRY_APPLY;
  }

  if (stage === "overlay" && sig.inModal) {
    return AFFORDANCE_INTENTS.UPSELL_DISMISS;
  }

  return AFFORDANCE_INTENTS.UNKNOWN;
}

function intentForStep(stage, snap, classification = null) {
  if (FILL_STAGES.has(stage)) return null;
  if (stage === "wizard_choice") return AFFORDANCE_INTENTS.WIZARD_CONTINUE;
  if (stage === "entry") {
    if (looksLikeJobBoardIndex(snap)) return AFFORDANCE_INTENTS.BOARD_NAV;
    return AFFORDANCE_INTENTS.ENTRY_APPLY;
  }
  if (stage === "overlay") {
    if ((snap?.passwordFieldCount || 0) > 0 || (snap?.fieldCount || 0) > 2) return null;
    return AFFORDANCE_INTENTS.UPSELL_DISMISS;
  }
  return null;
}

function intentMatchesStage(skill, stage, snap, classification) {
  const expected = intentForStep(stage, snap, classification);
  if (!expected) return false;
  if (!skill.intent || skill.intent === AFFORDANCE_INTENTS.UNKNOWN) return true;
  if (skill.intent === expected) return true;
  if (
    stage === "entry" &&
    (skill.intent === AFFORDANCE_INTENTS.BOARD_NAV || skill.intent === AFFORDANCE_INTENTS.ENTRY_APPLY) &&
    (expected === AFFORDANCE_INTENTS.BOARD_NAV || expected === AFFORDANCE_INTENTS.ENTRY_APPLY)
  ) {
    return true;
  }
  return false;
}

/** Stable signature for an interactive affordance (no brittle CSS). */
export function affordanceSignature(item = {}) {
  return {
    role: String(item.role || item.kind || "").toLowerCase().slice(0, 40),
    textNorm: normalizeTextSig(item.text || item.aria),
    inModal: !!item.inModal,
    testId: String(item.testId || "").slice(0, 80),
    kind: String(item.kind || "").slice(0, 40),
  };
}

/** Close / dismiss controls — must not replay over signup or application forms. */
export function isDismissAffordanceSignature(signature = {}) {
  const text = String(signature.textNorm || "").toLowerCase();
  const testId = String(signature.testId || "").toLowerCase();
  if (testId === "modal-close" || testId.includes("close-modal")) return true;
  if (/^(close|dismiss|×|x)$/.test(text)) return true;
  return text.includes("close modal");
}

function snapHasFillableSurface(snap, classification = null) {
  const stage = classification?.step || "";
  if (FILL_STAGES.has(stage)) return true;
  if (!snap) return false;
  if ((snap.fieldCount || 0) > 0) return true;
  if (snap.authForm) return true;
  if ((snap.passwordFieldCount || 0) > 0) return true;
  return (snap.emailFieldCount || 0) > 0 && (snap.passwordFieldCount || 0) > 0;
}

/** Never use affordance replay when the page needs typing/auth. */
export function shouldSkipAffordanceReplay(snap, classification = null) {
  const stage = classification?.step || "";
  if (FILL_STAGES.has(stage)) return true;
  return snapHasFillableSurface(snap, classification);
}

function affordanceKey(skill) {
  const s = skill?.signature || skill || {};
  return `${skill.intent || ""}::${s.role || ""}::${s.textNorm || ""}::${s.inModal ? 1 : 0}::${s.testId || ""}::${s.kind || ""}`;
}

export function mergeAffordanceSkills(prev = [], next = []) {
  const map = new Map();
  for (const s of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(next) ? next : [])]) {
    if (!s || typeof s !== "object") continue;
    const key = affordanceKey(s);
    if (!key.replace(/:/g, "")) continue;
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        ...s,
        successCount: (existing.successCount || 0) + (s.successCount || 1),
        signature: s.signature || existing.signature,
      });
    } else {
      map.set(key, { ...s, successCount: s.successCount || 1 });
    }
  }
  return [...map.values()]
    .sort((a, b) => (b.successCount || 0) - (a.successCount || 0))
    .slice(0, 24);
}

function situationKey(skill) {
  return `${String(skill.signature || "").toLowerCase()}::${String(skill.action || "").toLowerCase()}`;
}

export function mergeSituationSkills(prev = [], next = []) {
  const map = new Map();
  for (const s of [...(Array.isArray(prev) ? prev : []), ...(Array.isArray(next) ? next : [])]) {
    if (!s || typeof s !== "object" || !s.signature || !s.action) continue;
    const key = situationKey(s);
    const existing = map.get(key);
    if (existing) {
      map.set(key, {
        ...existing,
        ...s,
        id: existing.id || s.id,
        successCount: (existing.successCount || 0) + (s.successCount || 1),
        avoidActions: [...new Set([...(existing.avoidActions || []), ...(s.avoidActions || [])])],
        bodyHints: [...new Set([...(existing.bodyHints || []), ...(s.bodyHints || [])])].slice(0, 12),
        priority: Math.max(existing.priority || 0, s.priority || 0),
        lastUsed: s.lastUsed || existing.lastUsed,
      });
    } else {
      map.set(key, {
        id: s.id || `skill_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        successCount: s.successCount || 1,
        confidence: s.confidence || "medium",
        priority: s.priority ?? 60,
        avoidActions: s.avoidActions || [],
        bodyHints: s.bodyHints || [],
        ...s,
      });
    }
  }
  return [...map.values()]
    .sort((a, b) => (b.priority || 0) - (a.priority || 0) || (b.successCount || 0) - (a.successCount || 0))
    .slice(0, 24);
}

/** Built-in cold-start situation skills for known board traps. */
export function seedSituationSkillsForHost(hostname = "") {
  const host = normalizeHost(hostname);
  if (!host) return [];
  if (/remoterocketship\.com$/i.test(host)) {
    return [
      {
        id: "seed_rr_board_onboard",
        signature: "board_signup_onboarding",
        action: "nav_recovery",
        avoidActions: ["click_continue", "click_signup"],
        hostPattern: "remoterocketship.com",
        urlPattern: "/onboard",
        bodyHints: ["how long have you been searching", "find your dream job", "looking for my first remote"],
        priority: 95,
        confidence: "high",
        successCount: 2,
      },
      {
        id: "seed_rr_skip_signup_after_leave",
        signature: "board_leave_skip_signup",
        action: "click_apply",
        avoidActions: ["click_signup"],
        hostPattern: "remoterocketship.com",
        bodyHints: ["apply now", "sign up"],
        priority: 90,
        confidence: "high",
        successCount: 2,
      },
    ];
  }
  return [];
}

/**
 * Rank situation skills for the current page.
 * @returns {object[]}
 */
export function findRelevantSkills(snap, siteLearnings = null, { limit = 5, hostname = "" } = {}) {
  const host = normalizeHost(hostname || snap?.hostname || snap?.url || "");
  const seeds = seedSituationSkillsForHost(host);
  const stored = siteLearnings?.situationSkills || [];
  const skills = mergeSituationSkills(seeds, stored);
  if (!skills.length) return [];

  const url = String(snap?.url || "");
  const body = `${snap?.title || ""} ${snap?.pageText || ""} ${snap?.headings || ""}`.toLowerCase();

  const scored = skills.map((skill) => {
    let score = Number(skill.priority) || 50;
    score += Math.min(20, (skill.successCount || 0) * 3);
    if (skill.confidence === "high") score += 15;
    else if (skill.confidence === "medium") score += 5;
    if (skill.hostPattern && host.includes(String(skill.hostPattern).toLowerCase())) score += 20;
    if (skill.urlPattern) {
      try {
        if (new RegExp(skill.urlPattern, "i").test(url)) score += 35;
      } catch {
        if (url.toLowerCase().includes(String(skill.urlPattern).toLowerCase())) score += 25;
      }
    }
    for (const hint of skill.bodyHints || []) {
      if (hint && body.includes(String(hint).toLowerCase())) score += 12;
    }
    if (skill.signature && body.includes(String(skill.signature).replace(/_/g, " "))) score += 8;
    return { ...skill, _retrieveScore: score };
  });

  return scored
    .sort((a, b) => (b._retrieveScore || 0) - (a._retrieveScore || 0))
    .slice(0, limit);
}

/**
 * High-confidence situation skill that maps to an executable catalog type.
 */
export function findSituationMemoryPlan(snap, siteLearnings, catalogActions = []) {
  const relevant = findRelevantSkills(snap, siteLearnings, { limit: 3 });
  const top = relevant.find(
    (s) =>
      s.confidence === "high" &&
      (s.successCount || 0) >= 2 &&
      (s._retrieveScore || 0) >= 90,
  );
  if (!top) return null;
  const match =
    (catalogActions || []).find((a) => a.type === top.action) ||
    (top.action
      ? { type: top.action, reason: `situation memory — ${top.signature}`, score: top._retrieveScore }
      : null);
  if (!match) return null;
  return {
    ...match,
    reason: match.reason || `situation memory — ${top.signature}`,
    source: "situation-memory",
    situationSkillId: top.id,
    avoidActions: top.avoidActions || [],
  };
}

export function interactiveMatchesSignature(item, signature) {
  if (!item || !signature) return false;
  const sig = affordanceSignature(item);
  if (signature.testId && sig.testId && signature.testId === sig.testId) return true;
  if (signature.textNorm && sig.textNorm && signature.textNorm === sig.textNorm) {
    if (!!signature.inModal === !!sig.inModal) return true;
  }
  return false;
}

/** Mark interactives that previously succeeded on this host. */
export function boostInteractivesWithLearnings(interactives = [], siteLearnings = null) {
  const skills = siteLearnings?.affordanceSkills || [];
  if (!skills.length || !interactives?.length) return interactives;
  return interactives.map((item) => {
    const match = skills.find((s) => interactiveMatchesSignature(item, s.signature));
    if (!match) return item;
    return {
      ...item,
      learned: true,
      hintScore: (item.hintScore || 0) + 12 + Math.min(8, match.successCount || 1),
    };
  });
}

/**
 * If exactly one interactive matches a high-confidence learned skill for this stage, replay it.
 */
export function findLearnedAffordanceReplay(snap, siteLearnings, classification = null) {
  const skills = siteLearnings?.affordanceSkills || [];
  if (!skills.length || !snap?.interactives?.length) return null;

  if (shouldSkipAffordanceReplay(snap, classification)) return null;

  const stage = classification?.step || "";
  const candidates = [];
  for (const skill of skills) {
    if ((skill.successCount || 0) < 2) continue;
    if (skill.stage && stage && skill.stage !== stage && skill.stage !== "any") continue;
    if (!intentMatchesStage(skill, stage, snap, classification)) continue;
    const matches = snap.interactives.filter((i) => interactiveMatchesSignature(i, skill.signature));
    if (matches.length === 1) {
      candidates.push({ skill, item: matches[0] });
    }
  }
  if (candidates.length !== 1) return null;
  const { skill, item } = candidates[0];
  const intentLabel = skill.intent && skill.intent !== AFFORDANCE_INTENTS.UNKNOWN ? ` [${skill.intent}]` : "";
  return {
    type: "act",
    action: skill.action || "click",
    elementIndex: item.index,
    target: item.text || item.selector || "",
    reason: `learned affordance replay${intentLabel} — ${item.text || item.testId || `#${item.index}`}`,
    source: "affordance-memory",
  };
}

export function affordanceSkillFromAct(plan, snap, { stage = "any", classification = null } = {}) {
  if (!plan || plan.type !== "act") return null;
  if (!Number.isInteger(plan.elementIndex)) return null;
  const item = (snap?.interactives || []).find((i) => i.index === plan.elementIndex);
  if (!item) return null;
  const signature = affordanceSignature(item);
  const intent = inferAffordanceIntent(item, snap, classification || { step: stage });
  if (shouldSkipAffordanceReplay(snap, classification || { step: stage })) return null;
  if (intent === AFFORDANCE_INTENTS.UNKNOWN && snapHasFillableSurface(snap, classification)) return null;
  return {
    stage,
    action: plan.action || "click",
    signature,
    intent,
    successCount: 1,
  };
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
  if (prev.authSelectors) {
    prev.authSelectors = mergeAuthSelectors(prev.authSelectors, {});
  }

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
  if (patch.controlSkills) {
    merged.controlSkills = mergeControlSkills(prev.controlSkills, patch.controlSkills);
  }
  if (patch.affordanceSkills) {
    merged.affordanceSkills = mergeAffordanceSkills(prev.affordanceSkills, patch.affordanceSkills);
  }
  if (patch.situationSkills) {
    merged.situationSkills = mergeSituationSkills(prev.situationSkills, patch.situationSkills);
  }
  if (patch.stepStructures) {
    merged.stepStructures = { ...(prev.stepStructures || {}), ...patch.stepStructures };
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
        controlSkills: data.controlSkills || [],
        affordanceSkills: data.affordanceSkills || [],
        situationSkills: data.situationSkills || [],
        dismissFirst: data.dismissFirst || false,
        avoidFillWhenAlert: data.avoidFillWhenAlert || false,
        skipAggregatorApply: data.skipAggregatorApply || false,
        closedAggregator: data.closedAggregator || false,
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
