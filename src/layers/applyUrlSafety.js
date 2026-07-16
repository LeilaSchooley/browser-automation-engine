import { normalizeHost } from "../host.js";
import { looksLikeClosedJobListing } from "../heuristics.js";
import { CLOSED_JOB_URL_RE, JOB_BOARD_HOST_RE, SEO_AGGREGATOR_HOST_RE } from "../patterns/listing.js";
import { looksLikeScrapedMirrorUrl } from "./applyUrlHealth.js";

/** Employer / ATS application hosts — never prune these tabs under a tab-cap. */
export const EMPLOYER_ATS_HOST_RE =
  /(^|\.)(jobs\.)?lever\.co$|(^|\.)(boards|job-boards)\.greenhouse\.io$|(^|\.)jobs\.ashbyhq\.com$|(^|\.)(.*\.)?myworkdayjobs\.com$|(^|\.)(.*\.)?wd\d+\.myworkdayjobs\.com$|(^|\.)jobs\.workable\.com$|(^|\.)apply\.workable\.com$|(^|\.)(.*\.)?greenhouse\.io$|(^|\.)(.*\.)?ashbyhq\.com$|(^|\.)(.*\.)?smartrecruiters\.com$|(^|\.)(.*\.)?jobvite\.com$|(^|\.)(.*\.)?icims\.com$|(^|\.)(.*\.)?bamboohr\.com$|(^|\.)(.*\.)?recruitee\.com$|(^|\.)(.*\.)?personio\.(de|com)$|(^|\.)(.*\.)?ultipro\.com$/i;

export function isEmployerAtsHost(hostOrUrl = "") {
  const raw = String(hostOrUrl || "").trim();
  if (!raw) return false;
  let host = raw;
  try {
    if (/^https?:/i.test(raw) || raw.includes("/")) {
      host = new URL(raw, "https://example.com").hostname;
    }
  } catch {
    host = raw;
  }
  host = normalizeHost(host);
  if (!host) return false;
  if (EMPLOYER_ATS_HOST_RE.test(host)) return true;
  if (JOB_BOARD_HOST_RE.test(host)) return true;
  return false;
}

export function isEmployerAtsUrl(url = "") {
  return isEmployerAtsHost(url);
}

/** Board membership / product onboard URLs — safe to close when under tab pressure. */
export function isBoardOnboardUrl(url = "") {
  return /\/onboard(?:ing)?(?:-v\d+)?(?:\/|\?|$)/i.test(String(url || ""));
}

/** SEO job mirrors that chain outbound “apply” links instead of hosting forms. */
export const AGGREGATOR_HOST_RE =
  /thetodayupdate|victorytuitions|remotezest|liveblog365|frontendnode|remote-target|job-listing|fast-job|superio-child/i;

/** Scraped job boards that show listings but often have no real apply flow (alert signup only). */
export const SEO_JOB_BOARD_HOST_RE = /devitjobs\./i;

/** Free / throwaway hosts that rarely host real ATS apply flows. */
export const SUSPICIOUS_APPLY_HOST_RE =
  /liveblog365|000webhost|blogspot\.|wixsite\.com|weebly\.com|godaddysites\.com|strikingly\.com|tiiny\.site|free\.nf|rf\.gd/i;

/**
 * Third-party identity hosts opened by "Continue with Apple/Google/…" — never apply targets.
 * Keep the job-site auth tab; close these popups.
 */
export function isOauthProviderHost(hostOrUrl = "") {
  const raw = String(hostOrUrl || "").trim();
  if (!raw) return false;
  let host = raw;
  let path = "";
  try {
    if (/^https?:/i.test(raw) || raw.includes("/")) {
      const u = new URL(raw, "https://example.com");
      host = u.hostname;
      path = `${u.pathname || ""}${u.search || ""}`;
    }
  } catch {
    host = raw;
  }
  host = normalizeHost(host);
  if (!host) return false;

  if (/(?:^|\.)(?:appleid\.apple|idmsa\.apple|account\.apple)\.com$/i.test(host)) return true;
  if (/(?:^|\.)(?:accounts\.google|myaccount\.google)\.com$/i.test(host)) return true;
  if (/(?:^|\.)(?:login\.microsoftonline|login\.live)\.com$/i.test(host)) return true;
  // Facebook / GitHub only when the path is clearly OAuth/login, not careers.
  if (/(?:^|\.)(?:facebook|fb)\.com$/i.test(host) && /\/(login|dialog|v\d+\.\d+\/dialog)/i.test(path)) {
    return true;
  }
  if (/(?:^|\.)github\.com$/i.test(host) && /\/(login\/oauth|session)/i.test(path)) return true;
  return false;
}

/** CTAs that start Facebook/Apple/Google/Microsoft SSO instead of email Continue. */
export const SOCIAL_SSO_CTA_RE =
  /\b((continue|sign|log)\s+(in\s+)?with\s+(apple|google|facebook|github|microsoft|linkedin|x|twitter)|(sign|log)\s+up\s+with\s+(apple|google|facebook|github|microsoft))\b/i;

export function isSocialSsoCta(text = "") {
  return SOCIAL_SSO_CTA_RE.test(String(text || "").trim());
}

export function isChromeErrorPage(url = "", _title = "") {
  const u = String(url || "");
  if (/^chrome-error:/i.test(u) || /chromewebdata/i.test(u)) return true;
  if (/^about:neterror/i.test(u)) return true;
  return false;
}

export function isBrowserUnreachablePage(snap) {
  const url = snap?.url || "";
  const title = (snap?.title || "").trim();
  const blob = `${title} ${snap?.pageText || ""} ${snap?.headings || ""}`.toLowerCase();
  if (isChromeErrorPage(url, title)) return true;
  if (/^server not found$/i.test(title)) return true;
  if (/can't connect to the server|unable to connect|dns_probe_finished|server not found/i.test(blob)) {
    return true;
  }
  if (/\.liveblog365\.com$/i.test(title) && (snap?.fieldCount || 0) < 2) return true;
  return false;
}

export function isAggregatorHost(host = "") {
  const h = normalizeHost(host);
  return Boolean(h && AGGREGATOR_HOST_RE.test(h));
}

export function isSeoJobBoardHost(host = "") {
  const h = normalizeHost(host);
  return Boolean(h && SEO_JOB_BOARD_HOST_RE.test(h));
}

export function isSuspiciousApplyHost(host = "") {
  const h = normalizeHost(host);
  return Boolean(h && SUSPICIOUS_APPLY_HOST_RE.test(h));
}

export function looksLikeDeadApplyDestination(snap) {
  const url = snap?.url || "";
  const title = (snap?.title || "").trim();
  if (isBrowserUnreachablePage(snap)) {
    const label = title || normalizeHost(url) || url.replace(/^chrome-error:\/\//, "");
    return { dead: true, reason: `unreachable apply destination (${label})` };
  }
  const host = snap?.hostname || normalizeHost(url);
  if (
    isSuspiciousApplyHost(host) &&
    (snap?.pageKind === "unknown" || snap?.pageKind === "content") &&
    (snap?.fieldCount || 0) < 2 &&
    (snap?.entryCount || 0) === 0
  ) {
    return { dead: true, reason: `suspicious apply host with no form (${host})` };
  }
  const closed = looksLikeClosedJobListing(snap);
  if (closed.closed) return { dead: true, reason: closed.reason };
  return { dead: false, reason: "" };
}

export function shouldBlockApplyNavigation(href = "", pageUrl = "") {
  if (!href || /^(javascript:|#|mailto:)/i.test(href)) {
    return { block: false, reason: "" };
  }
  try {
    const resolved = new URL(href, pageUrl || "https://example.com").href;
    const host = normalizeHost(resolved);
    if (isSuspiciousApplyHost(host)) {
      return { block: true, reason: `blocked suspicious apply host: ${host}` };
    }
  } catch {
    /* ignore */
  }
  return { block: false, reason: "" };
}

/** Drop apply CTAs that only route to dead mirror / free-host destinations. */
export function filterSafeEntryCandidates(candidates = [], pageUrl = "") {
  const safe = [];
  for (const c of candidates || []) {
    const block = shouldBlockApplyNavigation(c.href || "", pageUrl);
    if (block.block) continue;
    safe.push(c);
  }
  return safe;
}

export function looksLikeAggregatorTrap(snap, history = []) {
  const host = normalizeHost(snap?.hostname || snap?.url);
  if (!isAggregatorHost(host)) return { trapped: false, reason: "" };

  const stalledApplyClicks = (history || []).filter(
    (h) => h.action === "click_apply" && !h.progress,
  ).length;
  const candidates = snap?.entryCandidates || [];
  const safeEntries = filterSafeEntryCandidates(candidates, snap?.url || "");
  if (candidates.length > 0 && safeEntries.length === 0) {
    return { trapped: true, reason: "aggregator mirror — apply links only point to dead third-party hosts" };
  }
  const onlyMirrorEntries = candidates.every((c) => {
    if (!c.href) return true;
    const block = shouldBlockApplyNavigation(c.href, snap?.url || "");
    return block.block || isAggregatorHost(normalizeHost(c.href));
  });
  if (stalledApplyClicks >= 2 && onlyMirrorEntries) {
    return { trapped: true, reason: "aggregator mirror — apply links only chain to other mirrors" };
  }
  if (stalledApplyClicks >= 1 && onlyMirrorEntries && isAggregatorHost(host)) {
    return { trapped: true, reason: "aggregator chain with no apply form" };
  }
  return { trapped: false, reason: "" };
}

export function entryHrefScoreDelta(meta = {}, pageHost = "", { hasNativeApplyButton = false } = {}) {
  let delta = 0;
  const cls = String(meta.className || "").toLowerCase();
  const href = meta.href || "";

  if (/custom-button/.test(cls)) delta -= 70;
  if (/btn-apply/.test(cls)) delta += 45;
  if (hasNativeApplyButton && /custom-button/.test(cls)) delta -= 100;

  if (href && pageHost) {
    try {
      const linkHost = normalizeHost(new URL(href, `https://${pageHost}`).hostname);
      const host = normalizeHost(pageHost);
      if (linkHost && linkHost !== host) {
        delta -= 40;
        if (isAggregatorHost(linkHost)) delta -= 80;
        if (isSuspiciousApplyHost(linkHost)) delta -= 200;
      }
    } catch {
      /* ignore */
    }
  }
  return delta;
}

/**
 * SEO aggregator apply URLs (Jooble /jdp, closed search, away redirects) — not employer ATS.
 */
export function classifyAggregatorApplyUrl(url = "") {
  const trimmed = String(url || "").trim();
  if (!trimmed || !/^https?:\/\//i.test(trimmed)) {
    return { aggregator: false, reason: "" };
  }
  try {
    const u = new URL(trimmed);
    const host = normalizeHost(u.hostname);
    const path = u.pathname.toLowerCase();
    const search = u.search.toLowerCase();

    if (CLOSED_JOB_URL_RE.test(search)) {
      return { aggregator: true, reason: "closed job redirect URL — similar jobs only" };
    }

    if (/jooble\.org$/i.test(host)) {
      if (/\/jdp\//i.test(path)) {
        return {
          aggregator: true,
          reason: "jooble SEO listing (/jdp) — aggregator mirror, not employer apply",
        };
      }
      if (/\/searchresult/i.test(path)) {
        return {
          aggregator: true,
          reason: "jooble search results page — not a direct apply URL",
        };
      }
      if (/\/away\//i.test(path)) {
        return {
          aggregator: true,
          reason: "jooble outbound redirect wrapper — not employer apply",
        };
      }
    }

    if (SEO_AGGREGATOR_HOST_RE.test(host)) {
      if (/\/jobs?\//i.test(path) || /\/jdp\//i.test(path) || /\/job\//i.test(path)) {
        return {
          aggregator: true,
          reason: `SEO job aggregator listing: ${host}`,
        };
      }
    }
  } catch {
    return { aggregator: false, reason: "" };
  }
  return { aggregator: false, reason: "" };
}

/** Whether a job apply URL should enter search/apply queues (not a mirror/dead host). */
export function isQueueableApplyUrl(url = "") {
  const trimmed = String(url || "").trim();
  if (!trimmed) return { queueable: false, reason: "missing apply URL" };
  if (!/^https?:\/\//i.test(trimmed)) return { queueable: false, reason: "invalid apply URL scheme" };
  const host = normalizeHost(trimmed);
  if (!host) return { queueable: false, reason: "invalid apply URL host" };

  const aggregatorApply = classifyAggregatorApplyUrl(trimmed);
  if (aggregatorApply.aggregator) {
    return { queueable: false, reason: aggregatorApply.reason };
  }

  const mirror = looksLikeScrapedMirrorUrl(trimmed);
  if (mirror.mirror) {
    return { queueable: false, reason: mirror.reason };
  }
  if (isSuspiciousApplyHost(host)) {
    return { queueable: false, reason: `suspicious apply host: ${host}` };
  }
  if (isAggregatorHost(host)) {
    return { queueable: false, reason: `job aggregator mirror: ${host}` };
  }
  return { queueable: true, reason: "" };
}
