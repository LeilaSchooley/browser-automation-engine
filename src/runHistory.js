/**
 * Append-only run history for Omni retrieve / reflection.
 */
import fs from "fs";
import path from "path";
import { normalizeHost } from "./host.js";
import { getSettings } from "./runtime.js";

function historyPath() {
  return String(getSettings().run_history_path || "").trim();
}

/**
 * @param {object} record
 */
export function appendRunHistory(record) {
  const filePath = historyPath();
  if (!filePath || !record) return null;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const entry = {
      id: record.id || `run_${Date.now().toString(36)}`,
      timestamp: record.timestamp || new Date().toISOString(),
      jobId: record.jobId ?? null,
      host: normalizeHost(record.host || ""),
      url: String(record.url || "").slice(0, 240),
      success: Boolean(record.success),
      filled: Number(record.filled) || 0,
      score: Number(record.score) || 0,
      outcome: record.outcome || (record.success ? "success" : "partial"),
      trail: (record.trail || []).slice(0, 40),
      learnedSkillIds: record.learnedSkillIds || [],
      fingerprint: record.fingerprint || "",
    };
    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`);
    return entry;
  } catch {
    return null;
  }
}

/**
 * @param {{ host?: string, limit?: number }} [opts]
 */
export function loadRecentRuns({ host = "", limit = 20 } = {}) {
  const filePath = historyPath();
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n").filter(Boolean);
    const want = normalizeHost(host);
    const rows = [];
    for (let i = lines.length - 1; i >= 0 && rows.length < limit * 3; i -= 1) {
      try {
        const row = JSON.parse(lines[i]);
        if (want && normalizeHost(row.host) !== want && !String(row.host || "").includes(want)) continue;
        rows.push(row);
        if (rows.length >= limit) break;
      } catch {
        /* skip */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

/**
 * Similar runs by host + simple trail/url overlap for RAG context.
 */
export function loadSimilarRuns(host, url = "", trail = [], { limit = 3 } = {}) {
  const recent = loadRecentRuns({ host, limit: 40 });
  const urlPath = (() => {
    try {
      return new URL(url).pathname.slice(0, 60);
    } catch {
      return String(url || "").slice(0, 60);
    }
  })();
  const trailSet = new Set((trail || []).map((t) => String(t).split(":")[0] || t));
  const scored = recent.map((r) => {
    let score = 0;
    if (urlPath && String(r.url || "").includes(urlPath)) score += 20;
    const rTrail = r.trail || [];
    for (const t of rTrail) {
      const key = String(t).split(":")[0] || t;
      if (trailSet.has(key)) score += 5;
    }
    if (!r.success) score += 3;
    return { ...r, _sim: score };
  });
  return scored
    .filter((r) => r._sim > 0)
    .sort((a, b) => b._sim - a._sim)
    .slice(0, limit);
}

export function trailFingerprint(history = []) {
  return (history || [])
    .slice(-12)
    .map((h) => h.action || h.applyStep || "?")
    .join("→");
}
