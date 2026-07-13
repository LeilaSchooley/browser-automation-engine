/**
 * Structured observability: per-step events, LLM metrics, optional screenshots.
 */
import fs from "fs";
import path from "path";
import { getSettings } from "./runtime.js";

const llmMetrics = { calls: 0, totalMs: 0, tokensEstimate: 0 };
let eventLogPath = null;

function ensureLogDir() {
  const dir = getSettings().event_log_dir || "";
  if (!dir) return null;
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

/**
 * Initialize event log for a session.
 * @param {string} sessionId
 */
export function initEventLog(sessionId) {
  const dir = ensureLogDir();
  if (!dir || !sessionId) {
    eventLogPath = null;
    return;
  }
  eventLogPath = path.join(dir, `${sessionId}.jsonl`);
}

/**
 * Record a structured engine event.
 * @param {string} type
 * @param {object} payload
 */
export function recordEngineEvent(type, payload = {}) {
  const entry = {
    ts: new Date().toISOString(),
    type,
    ...payload,
  };
  if (eventLogPath) {
    try {
      fs.appendFileSync(eventLogPath, `${JSON.stringify(entry)}\n`);
    } catch {
      /* ignore */
    }
  }
  return entry;
}

/**
 * Wrap callLlm to record latency and call count.
 * @param {Function} callLlm
 */
export function wrapCallLlmWithMetrics(callLlm) {
  if (typeof callLlm !== "function") return callLlm;
  return async function measuredCallLlm(prompt, opts = {}) {
    const start = Date.now();
    const result = await callLlm(prompt, opts);
    const elapsed = Date.now() - start;
    llmMetrics.calls += 1;
    llmMetrics.totalMs += elapsed;
    llmMetrics.tokensEstimate += Math.ceil(String(prompt || "").length / 4);
    recordEngineEvent("llm_call", {
      elapsedMs: elapsed,
      hasVision: Boolean(opts.imageBase64),
      promptChars: String(prompt || "").length,
    });
    return result;
  };
}

/**
 * Optionally persist a screenshot for debugging.
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {string} [sessionId]
 */
export async function captureDebugScreenshot(page, label, sessionId = "") {
  if (!getSettings().debug_screenshots_enabled) return null;
  const dir = ensureLogDir();
  if (!dir) return null;
  const safe = String(label || "step").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40);
  const file = path.join(dir, `${sessionId || "session"}_${safe}_${Date.now()}.jpg`);
  try {
    await page.screenshot({ path: file, type: "jpeg", quality: 55, fullPage: false });
    recordEngineEvent("screenshot", { path: file, label });
    return file;
  } catch {
    return null;
  }
}

/** @returns {{ calls: number, totalMs: number, tokensEstimate: number, avgMs: number }} */
export function getLlmMetrics() {
  return {
    ...llmMetrics,
    avgMs: llmMetrics.calls ? Math.round(llmMetrics.totalMs / llmMetrics.calls) : 0,
  };
}

export function resetLlmMetrics() {
  llmMetrics.calls = 0;
  llmMetrics.totalMs = 0;
  llmMetrics.tokensEstimate = 0;
}
