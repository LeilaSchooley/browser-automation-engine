/**
 * Read page text + URL to judge whether we're on a directory-submission surface.
 */
import {
  allowsHostHop,
  normalizeHost,
  targetHostFromContext,
} from "../host.js";
import {
  COMMON_SUBMIT_PATHS,
  NEWS_FEED_TEXT,
  SUBMIT_PAGE_TEXT,
  WRONG_PAGE_TEXT,
} from "../patterns/index.js";
import { looksLikeBoardSignupOnboarding } from "../platformOnboarding.js";

export { normalizeHost, targetHostFromContext, COMMON_SUBMIT_PATHS };

export function buildPageTextBlob(snap) {
  if (!snap) return "";
  const parts = [
    snap.title,
    snap.applyModalTitle,
    snap.pageText,
    snap.headings,
    snap.url,
    ...(snap.fields || []).map((f) => f.label),
  ];
  return parts.filter(Boolean).join(" ").replace(/\s+/g, " ").toLowerCase();
}

/**
 * @returns {{ score: number, signals: string[], wrongPage: boolean, wrongReason: string, targetHost: string, currentHost: string }}
 */
export function analyzePageIntent(snap, context = {}) {
  const targetHost = targetHostFromContext(context, snap?.url);
  const currentHost = normalizeHost(snap?.hostname || snap?.url);
  const text = buildPageTextBlob(snap);
  const signals = [];
  let score = 0;
  let wrongPage = false;
  let wrongReason = "";

  if ((snap?.fieldCount || 0) >= 2) {
    score += 45;
    signals.push("form_fields");
  } else if ((snap?.fieldCount || 0) === 1) {
    score += 15;
    signals.push("single_field");
  }

  if (snap?.authForm || snap?.signupForm) {
    score += 20;
    signals.push("auth_surface");
  }

  if (SUBMIT_PAGE_TEXT.test(text)) {
    score += 35;
    signals.push("submit_language");
  }

  if (/\/(submit|add|post|suggest|list|launch)/i.test(snap?.url || "")) {
    score += 30;
    signals.push("submit_path");
  }

  if (snap?.pageKind === "form") {
    score += 25;
    signals.push("form_kind");
  }

  const hostHopOk = allowsHostHop(context);

  if (targetHost && currentHost && targetHost !== currentHost) {
    const blank =
      !currentHost ||
      currentHost === "blank" ||
      /^(about:blank|data:)/i.test(snap?.url || "");
    if (!blank) {
      if (hostHopOk) {
        signals.push("host_hop");
      } else {
        wrongPage = true;
        wrongReason = `left target site (${currentHost} ≠ ${targetHost})`;
        score -= 100;
        signals.push("off_domain");
      }
    }
  }

  if (!hostHopOk && WRONG_PAGE_TEXT.test(text)) {
    wrongPage = true;
    wrongReason = wrongReason || "page looks like job/accelerator apply, not directory listing";
    score -= 75;
    signals.push("wrong_apply_context");
  }

  if (looksLikeBoardSignupOnboarding(snap)) {
    wrongPage = true;
    wrongReason = wrongReason || "board signup onboarding — not job application";
    score -= 100;
    signals.push("board_signup_onboarding");
  }

  const onHomepage =
    (snap?.pageKind === "listing" || snap?.pageKind === "content") &&
    (snap?.fieldCount || 0) < 2 &&
    !/\/(submit|add|post|suggest)/i.test(snap?.url || "");

  if (
    onHomepage &&
    NEWS_FEED_TEXT.test(text) &&
    (snap?.entryCount || 0) > 0 &&
    !SUBMIT_PAGE_TEXT.test(text)
  ) {
    score -= 15;
    signals.push("feed_not_submit");
  }

  const avoid = context?.avoidEntryKeys || context?.avoidHrefs || [];
  if (avoid.length && snap?.entryCandidates?.length) {
    signals.push("has_avoid_list");
  }

  return {
    score,
    signals,
    wrongPage,
    wrongReason,
    targetHost,
    currentHost,
    textSample: text.slice(0, 240),
    onSubmitSurface: score >= 40 && !wrongPage,
  };
}

export function entryCandidateKey(candidate) {
  if (!candidate) return "";
  return `${candidate.text || ""}|${candidate.testId || ""}|${candidate.selector || ""}`.toLowerCase();
}

export function rankEntryCandidates(candidates, context = {}) {
  const learnings = context?.siteLearnings || {};
  const preferredText = (learnings.entryText || "").toLowerCase();
  const preferredHref = (learnings.entryHref || "").toLowerCase();
  const avoid = new Set((context.avoidEntryKeys || []).map((k) => k.toLowerCase()));
  const targetHost = normalizeHost(context.targetHost);

  return [...(candidates || [])]
    .map((c) => {
      let bonus = 0;
      const key = entryCandidateKey(c);
      const blob = `${c.text || ""} ${c.testId || ""}`.toLowerCase();
      const href = (c.href || "").toLowerCase();
      if (avoid.has(key)) bonus -= 200;
      // Permanent negative priors (mailto / YC batch apply) even before learnings land.
      if (/^\s*(mailto:|tel:)/i.test(c.href || "")) bonus -= 300;
      if (/ycombinator\.com\/apply\/?$/i.test(href) || /apply (for|to) (fall|winter|spring|summer|yc)\b/i.test(blob)) {
        bonus -= 140;
      }
      if (preferredText && blob.includes(preferredText)) bonus += 60;
      if (preferredHref && href.includes(preferredHref)) bonus += 80;
      if (targetHost && href && !allowsHostHop(context)) {
        try {
          const linkHost = normalizeHost(new URL(href, `https://${targetHost}`).hostname);
          if (linkHost && linkHost !== targetHost) bonus -= 150;
        } catch {
          /* ignore */
        }
      }
      if (/apply to\b/i.test(blob)) bonus -= 90;
      return { ...c, score: (c.score || 0) + bonus, entryKey: key };
    })
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}
