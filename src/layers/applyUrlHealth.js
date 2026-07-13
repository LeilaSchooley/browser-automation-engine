import { normalizeHost } from "../host.js";
import { isAggregatorHost, isSuspiciousApplyHost } from "./applyUrlSafety.js";
import { CLOSED_JOB_URL_RE } from "../patterns/listing.js";
import { looksLikeClosedJobListing } from "../heuristics.js";

/** Google for Jobs mirror / aggregator funnel query params. */
export const GOOGLE_JOBS_MIRROR_PARAM_RE =
  /[?&]utm_(campaign|source|medium)=google_jobs_apply/i;

/** Path shapes common on SEO mirror apply pages (not real ATS). */
export const MIRROR_JOB_PATH_RE = /\/job\/\d{5,}(?:[/?#]|$)/i;

/**
 * Heuristic for scraped mirror listings (often dead free-host apply destinations).
 * Does not perform network I/O.
 */
export function looksLikeScrapedMirrorUrl(url = "") {
  const trimmed = String(url || "").trim();
  if (!trimmed) return { mirror: false, reason: "" };

  let host = "";
  try {
    host = normalizeHost(new URL(trimmed).hostname);
  } catch {
    return { mirror: false, reason: "" };
  }

  if (GOOGLE_JOBS_MIRROR_PARAM_RE.test(trimmed) && (isSuspiciousApplyHost(host) || isAggregatorHost(host))) {
    return { mirror: true, reason: "google jobs mirror funnel on non-employer host" };
  }

  if (isSuspiciousApplyHost(host) && MIRROR_JOB_PATH_RE.test(trimmed)) {
    return { mirror: true, reason: `mirror job path on free-host apply domain (${host})` };
  }

  if (/careersprint\./i.test(host) && /\.liveblog365\.com$/i.test(host)) {
    return { mirror: true, reason: `known dead mirror host (${host})` };
  }

  return { mirror: false, reason: "" };
}

function unreachableReason(err) {
  const msg = String(err?.cause?.code || err?.cause?.message || err?.message || err || "");
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|UND_ERR|aborted|fetch failed|getaddrinfo/i.test(msg)) {
    return `unreachable (${msg})`;
  }
  return msg || "request failed";
}

/**
 * Lightweight HTTP/DNS reachability probe (no third-party "is it down" API).
 * Uses HEAD then GET fallback; treats 4xx/5xx as reachable but unhealthy.
 */
export async function probeApplyUrlReachability(url = "", { timeoutMs = 8000, fetchImpl = fetch } = {}) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return { reachable: false, reason: "missing apply URL", status: 0 };
  if (!/^https?:\/\//i.test(trimmed)) {
    return { reachable: false, reason: "invalid apply URL scheme", status: 0 };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const headers = {
    "User-Agent": "Mozilla/5.0 (compatible; JobApplyAI/1.0; +apply-url-health)",
    Accept: "text/html,application/xhtml+xml",
  };

  async function tryFetch(method) {
    return fetchImpl(trimmed, { method, redirect: "follow", signal, headers });
  }

  try {
    let res = await tryFetch("HEAD");
    if (res.status === 405 || res.status === 501) {
      res = await tryFetch("GET");
    }
    if (res.status >= 500) {
      return { reachable: false, reason: `server error HTTP ${res.status}`, status: res.status };
    }
    return { reachable: true, reason: "", status: res.status };
  } catch (err) {
    return { reachable: false, reason: unreachableReason(err), status: 0 };
  }
}

function stripHtmlToText(html = "") {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Precheck whether an apply URL looks closed without a full browser apply.
 * Catches closedJob=True URLs and SSR/HTML copy like "This job has closed."
 */
export async function probeClosedJobListing(url = "", { timeoutMs = 10000, fetchImpl = fetch } = {}) {
  const trimmed = String(url || "").trim();
  if (!trimmed) return { closed: false, reason: "", source: "empty" };

  if (CLOSED_JOB_URL_RE.test(trimmed)) {
    return {
      closed: true,
      reason: "job listing closed — redirected to similar jobs search",
      source: "url",
    };
  }

  let hostname = "";
  try {
    hostname = normalizeHost(new URL(trimmed).hostname);
  } catch {
    return { closed: false, reason: "", source: "parse" };
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
  };

  try {
    const res = await fetchImpl(trimmed, { method: "GET", redirect: "follow", signal, headers });
    const finalUrl = String(res.url || trimmed);
    if (CLOSED_JOB_URL_RE.test(finalUrl)) {
      return {
        closed: true,
        reason: "job listing closed — redirected to similar jobs search",
        source: "redirect-url",
        status: res.status,
      };
    }

    const html = await res.text().catch(() => "");
    const pageText = stripHtmlToText(html).slice(0, 20000);
    const snap = {
      url: finalUrl,
      hostname,
      title: "",
      pageText: pageText || html.slice(0, 20000),
      headings: "",
    };
    const hit = looksLikeClosedJobListing(snap);
    if (hit.closed) {
      return { closed: true, reason: hit.reason, source: "page-text", status: res.status };
    }
    return { closed: false, reason: "", source: "probe-ok", status: res.status };
  } catch (err) {
    return { closed: false, reason: unreachableReason(err), source: "probe-error" };
  }
}

/** Sync + optional async reachability classification for queue / preflight. */
export async function classifyApplyUrlHealth(url = "", { probe = false, fetchImpl = fetch } = {}) {
  const mirror = looksLikeScrapedMirrorUrl(url);
  if (mirror.mirror) {
    return { ok: false, reason: mirror.reason, source: "mirror-heuristic" };
  }

  let host = "";
  try {
    host = normalizeHost(new URL(String(url || "").trim()).hostname);
  } catch {
    return { ok: false, reason: "invalid apply URL", source: "parse" };
  }

  if (isSuspiciousApplyHost(host)) {
    return { ok: false, reason: `suspicious apply host: ${host}`, source: "host-blocklist" };
  }
  if (isAggregatorHost(host)) {
    return { ok: false, reason: `job aggregator mirror: ${host}`, source: "host-blocklist" };
  }

  if (!probe) return { ok: true, reason: "", source: "host-ok" };

  const reach = await probeApplyUrlReachability(url, { fetchImpl });
  if (!reach.reachable) {
    return { ok: false, reason: reach.reason, source: "probe", status: reach.status };
  }
  return { ok: true, reason: "", source: "probe-ok", status: reach.status };
}
