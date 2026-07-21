/** Listing / marketing / board-surface heuristics. */

import { normalizeHost } from "../../host.js";
import { isSeoJobBoardHost } from "../applyUrlSafety.js";
import {
  APPLICATION_FIELD_RE,
  JOB_ALERT_FIELD_RE,
  JOB_ALERT_SIGNUP_BODY,
  JOB_BOARD_FILTER_FIELD_RE,
  JOB_BOARD_HOST_RE,
  JOB_BOARD_JOB_PATH_RE,
  JOB_BOARD_PAGE_BODY,
  CLOSED_JOB_BODY,
  CLOSED_JOB_URL_RE,
} from "../../patterns/listing.js";
import { APPLY_SIGNUP_GATE_TEXT } from "../../patterns/auth.js";
import {
  blobFromCandidate,
  hasApplicationSurfaceFields,
  snapSuggestsFileUpload,
} from "./common.js";

export const MARKETING_JOB_ALERT_BODY =
  /receive the latest jobs|be the first to know|setemail alert|job alert|time for a new job|candidates have already subscribed|get new relevant jobs|subscribe and receive new vacancies|new vacancies|jdJbeAlertPopUp|phlexPopup/i;

/** Google vignette / survey interstitial (often #google_vignette + AdChoices). */
export const GOOGLE_VIGNETTE_BODY =
  /\b(choose your job type|tap to see results|continue to see results|adchoices|full-time.*part-time|part-time.*full-time)\b/i;

/**
 * Google Ads vignette blocking the page (#google_vignette, adsbygoogle vignette iframe).
 * Not an apply form — must dismiss / Escape before any fill or Apply click.
 */
export function looksLikeGoogleVignetteAd(snap) {
  if (!snap) return false;
  const url = String(snap.url || "");
  if (/#google_vignette\b/i.test(url) || /[?&]google_vignette=/i.test(url)) return true;
  const hints = snap.overlayHints || [];
  if (hints.some((h) => /google-vignette|vignette-ad|adsbygoogle-vignette/i.test(h))) return true;
  const blob = [
    snap.pageText,
    snap.applyModalTitle,
    snap.headings,
    ...(snap.interactives || []).map((i) => `${i.text || ""} ${i.aria || ""}`),
    ...(snap.dismissCandidates || []).map((c) => c.text),
  ]
    .filter(Boolean)
    .join(" ");
  if (!GOOGLE_VIGNETTE_BODY.test(blob)) return false;
  // Survey + Close/AdChoices typical of vignette — not a real job preferences gate
  return (
    snap.hasBlockingOverlay ||
    (snap.modalCount || 0) > 0 ||
    /close|adchoices/i.test(blob)
  );
}

/** @deprecated alias */
const JOB_ALERT_POPUP_BODY = MARKETING_JOB_ALERT_BODY;

function marketingJobAlertBlob(snap) {
  return [
    snap?.pageText,
    snap?.title,
    snap?.applyModalTitle,
    snap?.headings,
    ...(snap?.overlayHints || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasMarketingYesNoControls(snap) {
  const pool = [
    ...(snap?.interactives || []),
    ...(snap?.modalCandidates || []),
    ...(snap?.dismissCandidates || []),
  ];
  let hasYes = false;
  let hasNo = false;
  let hasClose = false;
  for (const c of pool) {
    const t = String(c.text || c.aria || "").trim();
    if (/^yes$/i.test(t)) hasYes = true;
    if (/^no$/i.test(t) || /^no[, ]?thanks$/i.test(t)) hasNo = true;
    if (/^(close|×|✕|x|dismiss|decline)$/i.test(t)) hasClose = true;
  }
  return (hasYes && hasNo) || hasClose;
}

/**
 * Jooble-style marketing modal: Yes/No job-alert upsell with no application fields.
 */
export function looksLikeMarketingYesNoModal(snap) {
  if (!snap) return false;
  const hasModal =
    (snap.modalCount || 0) > 0 || snap.hasBlockingOverlay || snap.hasApplyModal;
  if (!hasModal) return false;
  if (!MARKETING_JOB_ALERT_BODY.test(marketingJobAlertBlob(snap))) return false;
  if (hasApplicationSurfaceFields(snap)) return false;
  return hasMarketingYesNoControls(snap);
}

/** WhatJobs / Phlex job-alert signup overlay — not an apply form or cookie consent. */
export function isJobAlertInterstitial(snap) {
  if (!snap) return false;
  if (looksLikeMarketingYesNoModal(snap)) return true;
  if (looksLikeJobAlertSignupForm(snap) && ((snap.modalCount || 0) > 0 || snap.hasBlockingOverlay)) {
    return true;
  }
  const fieldLabels = (snap.fields || [])
    .map((f) => `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`)
    .join(" ");
  const blob = [
    snap.pageText,
    snap.title,
    fieldLabels,
    ...(snap.overlayHints || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  if (!JOB_ALERT_POPUP_BODY.test(blob)) return false;
  return (snap.fieldCount || 0) >= 2 || (snap.modalCount || 0) > 0 || snap.hasBlockingOverlay;
}

/**
 * Job-board "Sign up to apply" modal — platform account gate, not the employer ATS form.
 * Often shows email first; password may appear on the same step or after Continue.
 */
export function looksLikeApplySignupGate(snap) {
  if (!snap) return false;

  const blob = [
    snap.title,
    snap.applyModalTitle,
    snap.pageText,
    snap.headings,
    ...(snap.submitCandidates || []).map((c) => c.text),
    ...(snap.signUpCandidates || []).map((c) => c.text),
    ...(snap.modalCandidates || []).map((c) => c.text),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (APPLY_SIGNUP_GATE_TEXT.test(blob)) return true;

  const fieldBlob = (snap.fields || [])
    .map((f) => `${f.id || ""} ${f.name || ""} ${f.selector || ""} ${f.label || ""}`)
    .join(" ")
    .toLowerCase();
  if (/sign[-_]?up[_-]?(email|password)|#sign-up/.test(fieldBlob)) return true;

  const host = normalizeHost(snap.hostname || snap.url || "");
  if (/jobright\.ai$/i.test(host) && snap.hasApplyModal && /sign[- ]?up/.test(blob)) {
    return true;
  }

  return false;
}

/** Inline job-alert / newsletter signup form — not a real application. */
export function looksLikeJobAlertSignupForm(snap) {
  if (!snap || (snap.fieldCount || 0) < 1) return false;

  const fields = snap.fields || [];
  const fieldBlob = fields
    .map((f) => `${f.name || ""} ${f.label || ""} ${f.placeholder || ""} ${f.type || ""}`)
    .join(" ")
    .toLowerCase();

  if (APPLICATION_FIELD_RE.test(fieldBlob)) return false;
  if ((snap.fileInputCount || 0) > 0) return false;

  const pageBlob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  const hasAlertCopy =
    JOB_ALERT_SIGNUP_BODY.test(pageBlob) ||
    JOB_ALERT_SIGNUP_BODY.test(fieldBlob) ||
    MARKETING_JOB_ALERT_BODY.test(pageBlob);

  const hasEmail = /\b(email|personemail|your email)\b/i.test(fieldBlob) ||
    fields.some((f) => f.type === "email");
  const hasName = /\b(name|personname|your name|full name)\b/i.test(fieldBlob);

  if (hasEmail && hasAlertCopy && !hasName && (snap.fieldCount || 0) <= 2) {
    return true;
  }

  if ((snap.fieldCount || 0) < 2) return false;
  if (!hasName || !hasEmail) return false;

  const categorySelect = fields.some(
    (f) =>
      f.type === "select-one" &&
      /c\+\+|devops|java|javascript|php|python|ruby|tech|mobile|blockchain/i.test(f.label || ""),
  );

  return (
    JOB_ALERT_FIELD_RE.test(fieldBlob) ||
    hasAlertCopy ||
    (categorySelect && (snap.fieldCount || 0) <= 4)
  );
}

/**
 * Aggregator mirror where the original posting is closed/unavailable.
 * Jooble: orange "requires local presence" + similar jobs, or SearchResult?closedJob=True.
 * Jobright: "This job has closed." banner (don't pivot to Recommended).
 */
export function looksLikeClosedJobListing(snap) {
  if (!snap) return { closed: false, reason: "" };

  const url = String(snap.url || "");
  if (CLOSED_JOB_URL_RE.test(url)) {
    return {
      closed: true,
      reason: "job listing closed — redirected to similar jobs search",
    };
  }

  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  if (!CLOSED_JOB_BODY.test(blob)) return { closed: false, reason: "" };

  const hostBlob = `${snap.hostname || ""} ${url}`;
  const onAggregator =
    /jooble\.org|indeed\.com|ziprecruiter|talent\.com|simplyhired|jobright\.ai|whatjobs\.|neuvoo|devitjobs/i.test(
      hostBlob,
    );

  // Explicit closed banner — stop even if Recommended jobs remain.
  if (/this job has closed|job has closed|this (job|position|role) has closed/i.test(blob)) {
    return {
      closed: true,
      reason: onAggregator
        ? "original job closed on aggregator — do not apply to recommended substitutes"
        : "original job has closed — skip apply",
    };
  }

  const similarJobsRail =
    /similar jobs that could be interesting|view similar jobs below|based on the .+ vacancy/i.test(blob);

  if (similarJobsRail || /requires local presence|no longer available|view similar jobs/i.test(blob)) {
    return {
      closed: true,
      reason: onAggregator
        ? "original job unavailable on aggregator — similar jobs only"
        : "original job unavailable — similar jobs suggested instead",
    };
  }

  return { closed: false, reason: "" };
}

/** Whether the page exposes a real apply path (CTA, modal, or non-alert submit). */
export function hasRealApplyAffordance(snap) {
  if (!snap) return false;
  if ((snap.entryCount || 0) > 0) return true;
  if (snap.hasApplyModal) return true;
  if ((snap.modalStepCount || 0) > 0 && snapSuggestsFileUpload(snap)) return true;

  for (const c of snap.submitCandidates || []) {
    const blob = blobFromCandidate(c).toLowerCase();
    if (blob && !/alert|subscribe|notify|newsletter/i.test(blob)) return true;
  }
  return false;
}

function fieldsNameBlob(snap) {
  return (snap?.fields || []).map((f) => f.name || "").join(" ").toLowerCase();
}

/**
 * Scraped job-board trap: listing page with no apply button, often only alert signup.
 * Typically reached after click_apply redirects to an SEO mirror (devitjobs, etc.).
 */
export function looksLikeFakeJobListing(snap, history = []) {
  if (!snap) return { fake: false, reason: "" };

  const closed = looksLikeClosedJobListing(snap);
  if (closed.closed) {
    return { fake: true, reason: closed.reason };
  }

  const clickedApply = (history || []).some((h) => h.action === "click_apply" && h.ok);
  if (!clickedApply) return { fake: false, reason: "" };

  if (looksLikeJobAlertSignupForm(snap)) {
    return {
      fake: true,
      reason: "job board alert signup only — no real application form",
    };
  }

  const host = normalizeHost(snap.hostname || snap.url);
  const listingBlob = `${snap.title || ""} ${snap.pageText || ""}`.toLowerCase();
  const looksLikeListing =
    /\bjob in\b|\bjobs in\b|salary|full-time|part-time|£|\$[\d,]+/i.test(listingBlob);
  const noApply = !hasRealApplyAffordance(snap);

  if (noApply && looksLikeListing && (snap.fieldCount || 0) <= 3) {
    if (isSeoJobBoardHost(host)) {
      return {
        fake: true,
        reason: `scraped job listing on ${host} — no apply button`,
      };
    }
    if (JOB_ALERT_FIELD_RE.test(fieldsNameBlob(snap))) {
      return {
        fake: true,
        reason: "scraped job listing — no apply button",
      };
    }
  }

  return { fake: false, reason: "" };
}

/**
 * Company job-board index (Ashby / Greenhouse / Lever filters, "Open Positions") —
 * pick a role, do not fill filters as applicant preferences.
 */
export function looksLikeJobBoardIndex(snap) {
  if (!snap) return false;

  const fields = snap.fields || [];
  const fieldBlob = fields
    .map((f) => `${f.name || ""} ${f.label || ""} ${f.placeholder || ""}`)
    .join(" ");

  const url = String(snap.url || "");
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    host = String(snap.hostname || "").toLowerCase();
  }
  const pathAndQuery = (() => {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}`;
    } catch {
      return url;
    }
  })();

  const pageBlob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""} ${url}`.toLowerCase();

  const selectFields = fields.filter((f) => /select/i.test(String(f.type || "")));
  const allSelects = fields.length >= 2 && selectFields.length === fields.length;
  const filterFields = JOB_BOARD_FILTER_FIELD_RE.test(fieldBlob);
  const openPositions = JOB_BOARD_PAGE_BODY.test(pageBlob);
  const atsBoardHost = JOB_BOARD_HOST_RE.test(host);
  const pathParts = (() => {
    try {
      return new URL(url).pathname.split("/").filter(Boolean);
    } catch {
      return String(pathAndQuery || "")
        .split(/[?#]/)[0]
        .split("/")
        .filter(Boolean);
    }
  })();
  // ATS company roots are 1 segment; job pages are 2+ (Ashby/Lever/Greenhouse).
  const deepJobPath =
    JOB_BOARD_JOB_PATH_RE.test(pathAndQuery) || (atsBoardHost && pathParts.length >= 2);

  const hasApplyFields =
    fields.some((f) => {
      const blob = `${f.name || ""} ${f.label || ""}`.toLowerCase();
      return /email|first.?name|last.?name|resume|phone|cover/i.test(blob);
    }) || APPLICATION_FIELD_RE.test(fieldBlob);

  const noFileInput = (snap.fileInputCount || 0) === 0;
  const noPassword = (snap.passwordFieldCount || 0) === 0;

  if (hasApplyFields || !noPassword) return false;
  if ((snap.fileInputCount || 0) > 0) return false;

  // Known ATS board hosts at company root (no deep job/application path).
  if (atsBoardHost && !deepJobPath && noFileInput) {
    if (allSelects || filterFields || openPositions || fields.length === 0) return true;
    // Greenhouse/Lever boards often expose 2–4 filter selects with Location/Department labels.
    if (selectFields.length >= 2 && fields.length <= 8) return true;
  }

  if (filterFields && fields.length >= 2 && noFileInput) return true;
  if (openPositions && allSelects && fields.length >= 2 && noFileInput) return true;
  if (openPositions && selectFields.length >= 2 && noFileInput && !hasApplyFields) return true;

  return false;
}

/**
 * Job detail / deep application URL — not a company board index.
 * Used to stop soft board-ish signals (nav "All jobs") from hijacking Stagehand on JDs.
 */
export function pathLooksLikeJobDetail(snapOrUrl) {
  const url = typeof snapOrUrl === "string" ? snapOrUrl : String(snapOrUrl?.url || "");
  if (!url) return false;
  let host = "";
  let pathname = "";
  let pathAndQuery = "";
  try {
    const u = new URL(url);
    host = u.hostname.toLowerCase();
    pathname = u.pathname || "/";
    pathAndQuery = `${u.pathname}${u.search}`;
  } catch {
    pathAndQuery = url;
    pathname = url.split(/[?#]/)[0] || "";
  }
  if (JOB_BOARD_JOB_PATH_RE.test(pathAndQuery)) return true;
  const parts = pathname.split("/").filter(Boolean);
  if (JOB_BOARD_HOST_RE.test(host) && parts.length >= 2) return true;
  // Aggregator / niche boards: /id/slug or /company/role-slug (2+ segments).
  if (parts.length >= 2) return true;
  return false;
}

/** Inline apply form (Ashby Application tab) — fields on page, not a modal wizard. */
export function looksLikeInlineApplicationForm(snap) {
  if (!snap) return false;
  const stack = snap.dialogStack || [];
  const inRealDialog = stack.some((d) => d.inApplyModal) && (snap.modalCount || 0) > 0;
  if (inRealDialog && (snap.modalStepCount || 0) > 1) return false;

  const fields = snap.fields || [];
  const hasTextFields = fields.some((f) =>
    /text|email|tel|textarea/i.test(String(f.type || "")),
  );
  const hasFile = (snap.fileInputCount || 0) > 0;
  const onApplicationUrl = /\/application\b/i.test(String(snap.url || ""));

  return hasTextFields && hasFile && (onApplicationUrl || (snap.fieldCount || 0) >= 3);
}

/** Unfilled identity / application text fields on the current surface. */
export function hasUnfilledApplicationFields(snap, fillResult = null) {
  if (!snap) return false;
  const unfilledCustom = (snap.customControls || []).filter(
    (c) => !c.filled && ["yesno", "radio"].includes(c.widgetType),
  );
  if (unfilledCustom.length >= 1) return true;

  const fields = snap.fields || [];
  // Combobox/contenteditable are tracked on customControls — counting them here
  // double-flags location typeaheads as unfilled after a successful Places pick.
  const textLike = fields.filter(
    (f) => !/select|file|hidden|checkbox|radio|combobox|contenteditable/i.test(String(f.type || "")),
  );
  const unfilled = textLike.filter((f) => !f.filled);
  if (unfilled.length >= 1) return true;
  const filledCount = fillResult?.filled?.length || 0;
  const hasRealTextFields = textLike.length >= 2;
  return hasRealTextFields && (snap.fieldCount || 0) >= 2 && filledCount === 0;
}
