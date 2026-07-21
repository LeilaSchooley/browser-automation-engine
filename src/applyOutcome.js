/** Apply pipeline outcome classification. */

import { isStuck } from "./layers/signals/historyLoops.js";

function slugCode(text = "") {
  return (
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 64) || "unknown"
  );
}

/**
 * Structured termination for host UI / bulk results.
 * @returns {{ kind: string, code: string, reason: string, missing: string[] }}
 */
export function buildTermination({
  pipeline = null,
  outcome = null,
  stopped = false,
  error = null,
  readyMessage = "",
} = {}) {
  const history = pipeline?.agentHistory || pipeline?.history || [];
  const last =
    [...history]
      .reverse()
      .find((h) => h?.reason || h?.handoff || h?.stuck || h?.applyStep === "blocked") || {};
  const missing = [
    ...(Array.isArray(last.missing) ? last.missing : []),
    ...(Array.isArray(pipeline?.fillResult?.missing) ? pipeline.fillResult.missing : []),
  ]
    .map(String)
    .filter(Boolean);

  let kind = "partial";
  let code = outcome ? slugCode(outcome) : "partial";
  let reason = readyMessage || last.reason || error || outcome || "";

  if (stopped) {
    kind = "stopped";
    code = "user_stop";
    reason = reason || "Apply stopped";
  } else if (error) {
    kind = "error";
    code = "pipeline_error";
    reason = String(error);
  } else if (last.handoff || /handoff/i.test(String(last.reason || readyMessage || ""))) {
    kind = "handoff";
    code = slugCode(last.reason || readyMessage || "handoff");
  } else if (last.stuck || outcome === "stuck" || /stuck/i.test(String(last.reason || ""))) {
    kind = "stuck";
    code = slugCode(last.reason || "stuck");
  } else if (outcome === "ready") {
    kind = "ready";
    code = "ready_for_review";
  } else if (outcome === "skipped" || /closed|unavailable|job.?gone/i.test(String(readyMessage || ""))) {
    kind = "skipped";
    code = slugCode(readyMessage || "skipped");
  } else if (outcome === "error") {
    kind = "error";
    code = "apply_error";
  }

  return {
    kind,
    code,
    reason: String(reason || "").slice(0, 400),
    missing: [...new Set(missing)].slice(0, 24),
  };
}

export function computeApplyOutcome({ pipeline, error = null, stopped = false }) {
  const filled = pipeline?.fillResult?.filled?.length || 0;
  const resumeUploaded = (pipeline?.agentHistory || []).some((h) => h.action === "upload_resume" && h.ok);
  const fieldCount = pipeline?.snap?.fieldCount || 0;
  const pageKind = pipeline?.snap?.pageKind || "unknown";
  const hostname = (() => {
    try {
      return new URL(pipeline?.snap?.url || "").hostname;
    } catch {
      return "";
    }
  })();

  if (stopped) {
    return { outcome: "stopped", filled, resume_uploaded: resumeUploaded, field_count: fieldCount, page_kind: pageKind, hostname };
  }
  if (error) {
    return { outcome: "error", filled, resume_uploaded: resumeUploaded, field_count: fieldCount, page_kind: pageKind, hostname, error };
  }

  const reachedForm = filled >= 2 || (fieldCount >= 2 && filled > 0);
  const reachedSurface = pageKind === "form" || pageKind === "modal" || fieldCount > 0 || resumeUploaded;

  if (reachedForm || (filled > 0 && resumeUploaded)) {
    return { outcome: "ready", filled, resume_uploaded: resumeUploaded, field_count: fieldCount, page_kind: pageKind, hostname };
  }
  if (reachedSurface || filled > 0) {
    return { outcome: "partial", filled, resume_uploaded: resumeUploaded, field_count: fieldCount, page_kind: pageKind, hostname };
  }

  const stuck = isStuck(pipeline?.agentHistory || [], pipeline?.snap);
  return {
    outcome: stuck ? "stuck" : "partial",
    filled,
    resume_uploaded: resumeUploaded,
    field_count: fieldCount,
    page_kind: pageKind,
    hostname,
  };
}

export function outcomeJobStatus(outcome) {
  if (outcome === "ready" || outcome === "partial") return "browser_ready";
  return null;
}
