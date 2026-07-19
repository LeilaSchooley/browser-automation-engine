/**
 * Single source of truth for entry / listing / sign-in / sign-up candidate scores.
 * Node scorers live here; serializeCandidateScoringForPage() injects matching
 * in-page helpers into formDiscovery's page.evaluate.
 */
import {
  LISTING_ENTRY_TEXT,
  SUBMIT_PATH_RE,
  JOB_BOARD_HOST_RE,
} from "../../patterns/listing.js";
import { SIGN_IN_TEXT, SIGNUP_TEXT, OAUTH_PROVIDER_TEXT } from "../../patterns/auth.js";
import {
  entryHrefScoreDelta,
  EMPLOYER_ATS_HOST_RE,
  AGGREGATOR_HOST_RE,
  SUSPICIOUS_APPLY_HOST_RE,
} from "../applyUrlSafety.js";

/** Score directory-listing entry controls (Submit, Add listing, etc.). */
export function scoreListingEntryCandidate(meta, pageHost = "") {
  let score = 0;
  const text = (meta.text || "").trim();
  const blob = `${text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();
  const href = (meta.href || "").toLowerCase();

  if (/^submit$/i.test(text)) score += 130;
  if (LISTING_ENTRY_TEXT.test(blob)) score += 90;
  if (SUBMIT_PATH_RE.test(href)) score += 85;
  if ((meta.inNav || meta.inTopBar) && /submit|add|suggest|list/i.test(blob)) score += 70;
  if (meta.inFooter || meta.inBottomChrome) score -= 90;

  if (pageHost && href) {
    try {
      const linkHost = new URL(href, `https://${pageHost}`).hostname.replace(/^www\./, "");
      const host = pageHost.replace(/^www\./, "");
      if (linkHost && linkHost !== host) score -= 120;
    } catch {
      /* ignore */
    }
  }

  if (/apply (for|to) (fall|winter|spring|summer|yc|y combinator|the .* batch)\b/i.test(blob)) score -= 140;
  if (/\bapply to (this )?role\b|\bapply for (this|the) (role|job|position)\b/i.test(blob)) score += 90;
  if (/\bapply\b/i.test(text) && !/^submit$/i.test(text) && !/\bapply to (this )?role\b/i.test(blob)) score -= 25;
  if (meta.tag === "a" || meta.role === "link") score += 15;
  if (meta.inMainContent) score += 10;
  if (/sign in|log in|login|comments|discuss|\bpast\b|\bnews\b/i.test(blob) && !/submit/i.test(blob)) {
    score -= 40;
  }
  return score;
}

/**
 * Score apply-entry controls — higher = more likely primary CTA on a job listing.
 * Uses entryHrefScoreDelta (className + cross-host ATS/aggregator rules).
 */
export function scoreEntryCandidate(meta) {
  let score = 0;
  const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href} ${meta.value || ""}`.toLowerCase();
  const inputType = String(meta.type || meta.inputType || "").toLowerCase();

  // mailto:/tel: "email"/"call" links are never apply CTAs.
  if (/^\s*(mailto:|tel:)/i.test(meta.href || "")) return -300;

  if (/interested/i.test(blob)) score += 95;
  if (/apply with autofill|autofill/i.test(blob)) {
    // Jobright Autofill depends on their Chrome extension — usually a dead end over CDP.
    score += 35;
  } else if (/easy apply|quick apply|1-click apply/i.test(blob)) {
    score += 98;
  } else if (/apply to role|apply for (the|this) job|apply to (the|this) job|i'?m interested|apply here|apply today|start application/i.test(blob)) {
    score += 90;
  } else if (/apply now/i.test(blob)) {
    score += 82;
  } else if (/\bapply\b/i.test(meta.text || meta.value || "")) {
    score += 55;
  }
  // Y Combinator batch/accelerator apply is not the job application.
  if (/apply (for|to) (fall|winter|spring|summer|yc|y combinator|the .* batch)/i.test(blob)) {
    score -= 140;
  }
  if (/submit application/i.test(blob)) score -= 90;
  if (/apply|interested/i.test(meta.testId || "")) score += 45;

  if (meta.inMainContent) score += 25;
  if (meta.inJobContext) score += 20;
  if (meta.inNav) score -= 50;
  if (meta.inFooter) score -= 15;

  const tag = (meta.tag || "").toLowerCase();
  if (tag === "button" || meta.role === "button") score += 18;
  if (tag === "a" && /apply|interested/i.test(blob)) score += 10;

  if (meta.area < 800) score -= 25;
  if (meta.area > 4000 && meta.area < 80000) score += 8;

  if (/sign in|log in|register|search jobs|save job|share/i.test(blob)) score -= 60;

  // Submit inputs labeled Apply are real CTAs (findwork.dev) — mild penalty only so
  // genuine <button> Apply still wins when both exist, but sole submit CTAs clear threshold.
  if (tag === "input" && !meta.href) {
    if (inputType === "submit" || /\bapply\b/i.test(blob)) {
      score -= 20;
    } else {
      score -= 85;
    }
  }

  score += entryHrefScoreDelta(meta, meta.pageHost || "", {
    hasNativeApplyButton: !!meta.hasNativeApplyButton,
  });

  return score;
}

/** Score sign-in / login entry controls. */
export function scoreSignInCandidate(meta) {
  const blob = `${meta.text} ${meta.testId} ${meta.aria}`.toLowerCase();
  if (
    !SIGN_IN_TEXT.test(blob) &&
    !/\bsign in\b|\blog in\b|^login$|already a member|sign in now|submit startup/i.test(blob)
  ) {
    return 0;
  }
  // Magic-link / OTP login is a trap when we need Create an account (YC passwordless wall).
  if (/magic link|email me a (code|link)|send (me )?(a )?code/i.test(blob)) return 0;
  if (OAUTH_PROVIDER_TEXT.test(blob) && !/email/.test(blob)) return 0;
  if (/\/(auth|oauth)\/(linkedin|google|apple|facebook|github|microsoft|twitter)\b/.test(blob)) return 0;
  let score = 50;
  if (/sign in with email|log in with email/.test(blob) && !/magic link/.test(blob)) score += 80;
  if (/sign in now|already a member|already have an account/.test(blob)) score += 55;
  if (meta.tag === "button" || meta.role === "button" || meta.tag === "input" || meta.tag === "a") {
    score += 20;
  }
  return score;
}

/** Score sign-up / register entry controls. */
export function scoreSignUpCandidate(meta) {
  const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();
  if (!SIGNUP_TEXT.test(blob) && !/\b(signup|sign-up|register|join|get started|create account)\b/.test(blob)) {
    return 0;
  }
  if (OAUTH_PROVIDER_TEXT.test(blob) && !/email/.test(blob)) return 0;
  if (
    /\/(auth|oauth)\/(linkedin|google|apple|facebook|github|microsoft|twitter)\b/.test(blob) &&
    !/email/.test(blob)
  ) {
    return 0;
  }
  let score = 55;
  if (/sign up with email|create account/.test(blob)) score += 75;
  if (/^sign up$|create account|^register$/i.test((meta.text || "").trim())) score += 45;
  if (meta.tag === "a" && /signup|register|join/.test(meta.href || "")) score += 55;
  if (meta.tag === "button" || meta.role === "button" || meta.tag === "input") score += 20;
  if (/\bsign in\b|\blog in\b/.test(blob) && !/sign up/.test(blob)) score -= 40;
  return score;
}

/**
 * JS string defining in-page scorers for page.evaluate.
 * Expects closure vars: listingPattern, submitPathPattern, listingMode,
 * pageHost, hasNativeApplyButton (eval after those are bound).
 */
export function serializeCandidateScoringForPage() {
  const signInSrc = SIGN_IN_TEXT.source;
  const signUpSrc = SIGNUP_TEXT.source;
  const oauthSrc = OAUTH_PROVIDER_TEXT.source;
  const employerAtsSrc = EMPLOYER_ATS_HOST_RE.source;
  const jobBoardSrc = JOB_BOARD_HOST_RE.source;
  const aggregatorSrc = AGGREGATOR_HOST_RE.source;
  const suspiciousSrc = SUSPICIOUS_APPLY_HOST_RE.source;

  const helperJs = `
function __scoreNormalizeHost(h) {
  return String(h || "").toLowerCase().replace(/^www\\./, "");
}
function __entryHrefScoreDelta(meta, host, nativeApply) {
  var delta = 0;
  var cls = String(meta.className || "").toLowerCase();
  var href = meta.href || "";
  if (/^\\s*(mailto:|tel:)/i.test(href)) return delta - 300;
  if (/custom-button/.test(cls)) delta -= 70;
  if (/btn-apply/.test(cls)) delta += 45;
  if (nativeApply && /custom-button/.test(cls)) delta -= 100;
  if (href && host) {
    try {
      var linkUrl = new URL(href, "https://" + host);
      var linkHost = __scoreNormalizeHost(linkUrl.hostname);
      var pageH = __scoreNormalizeHost(host);
      if (/(^|\\.)ycombinator\\.com$/i.test(linkHost) && /^\\/apply\\/?$/i.test(linkUrl.pathname)) {
        delta -= 140;
      }
      if (linkHost && linkHost !== pageH) {
        var atsRe = new RegExp(${JSON.stringify(employerAtsSrc)}, "i");
        var boardRe = new RegExp(${JSON.stringify(jobBoardSrc)}, "i");
        if (atsRe.test(linkHost) || boardRe.test(linkHost)) {
          delta += 20;
        } else {
          delta -= 40;
          if (new RegExp(${JSON.stringify(aggregatorSrc)}, "i").test(linkHost)) delta -= 80;
          if (new RegExp(${JSON.stringify(suspiciousSrc)}, "i").test(linkHost)) delta -= 200;
        }
      }
    } catch (e) { /* ignore */ }
  }
  return delta;
}
function scoreSignInButton(meta) {
  var blob = (meta.text + " " + meta.testId + " " + meta.aria).toLowerCase();
  var signInRe = new RegExp(${JSON.stringify(signInSrc)}, "i");
  var oauthRe = new RegExp(${JSON.stringify(oauthSrc)}, "i");
  if (!signInRe.test(blob) && !/\\bsign in\\b|\\blog in\\b|^login$|already a member|sign in now|submit startup/i.test(blob)) {
    return 0;
  }
  if (/magic link|email me a (code|link)|send (me )?(a )?code/i.test(blob)) return 0;
  if (oauthRe.test(blob) && !/email/.test(blob)) return 0;
  if (/\\/(auth|oauth)\\/(linkedin|google|apple|facebook|github|microsoft|twitter)\\b/.test(blob)) return 0;
  var score = 50;
  if (/sign in with email|log in with email/.test(blob) && !/magic link/.test(blob)) score += 80;
  if (/sign in now|already a member|already have an account/.test(blob)) score += 55;
  if (meta.tag === "button" || meta.role === "button" || meta.tag === "input" || meta.tag === "a") score += 20;
  return score;
}
function scoreSignUpButton(meta) {
  var blob = (meta.text + " " + meta.testId + " " + meta.aria + " " + meta.href).toLowerCase();
  var signUpRe = new RegExp(${JSON.stringify(signUpSrc)}, "i");
  var oauthRe = new RegExp(${JSON.stringify(oauthSrc)}, "i");
  if (!signUpRe.test(blob) && !/\\b(signup|sign-up|register|join|get started|create account)\\b/.test(blob)) return 0;
  if (oauthRe.test(blob) && !/email/.test(blob)) return 0;
  if (/\\/(auth|oauth)\\/(linkedin|google|apple|facebook|github|microsoft|twitter)\\b/.test(blob) && !/email/.test(blob)) return 0;
  var score = 55;
  if (/sign up with email|create account/.test(blob)) score += 75;
  if (/^sign up$|create account|^register$/i.test((meta.text || "").trim())) score += 45;
  if (meta.tag === "a" && /signup|register|join/.test(meta.href || "")) score += 55;
  if (meta.tag === "button" || meta.role === "button" || meta.tag === "input") score += 20;
  if (/\\bsign in\\b|\\blog in\\b/.test(blob) && !/sign up/.test(blob)) score -= 40;
  return score;
}
function scoreListingEntry(meta) {
  var score = 0;
  var text = (meta.text || "").trim();
  var blob = (text + " " + meta.testId + " " + meta.aria + " " + meta.href).toLowerCase();
  var href = (meta.href || "").toLowerCase();
  var host = (typeof pageHost !== "undefined" && pageHost) || (location.hostname || "").replace(/^www\\./, "");
  if (/^submit$/i.test(text)) score += 130;
  if (typeof listingPattern !== "undefined" && listingPattern.test(blob)) score += 90;
  if (typeof submitPathPattern !== "undefined" && submitPathPattern.test(href)) score += 85;
  if ((meta.inNav || meta.inTopBar) && /submit|add|suggest|list/i.test(blob)) score += 70;
  if (meta.inFooter || meta.inBottomChrome) score -= 90;
  if (href && host) {
    try {
      var linkHost = new URL(href, "https://" + host).hostname.replace(/^www\\./, "");
      if (linkHost && linkHost !== host) score -= 120;
    } catch (e) { /* ignore */ }
  }
  if (/apply (for|to) (fall|winter|spring|summer|yc|y combinator|the .* batch)\\b/i.test(blob)) score -= 140;
  if (/\\bapply to (this )?role\\b|\\bapply for (this|the) (role|job|position)\\b/i.test(blob)) score += 90;
  if (/\\bapply\\b/i.test(text) && !/^submit$/i.test(text) && !/\\bapply to (this )?role\\b/i.test(blob)) score -= 25;
  if (meta.tag === "a" || meta.role === "link") score += 15;
  if (meta.inMainContent) score += 10;
  if (/sign in|log in|login|comments|discuss|\\bpast\\b|\\bnews\\b/i.test(blob) && !/submit/i.test(blob)) score -= 40;
  return score;
}
function scoreEntry(meta) {
  if (typeof listingMode !== "undefined" && listingMode) return scoreListingEntry(meta);
  var score = 0;
  var blob = (meta.text + " " + meta.testId + " " + meta.aria + " " + meta.href + " " + (meta.value || "")).toLowerCase();
  var inputType = String(meta.type || "").toLowerCase();
  if (/^\\s*(mailto:|tel:)/i.test(meta.href || "")) return -300;
  if (/interested/i.test(blob)) score += 95;
  if (/apply with autofill|autofill/i.test(blob)) {
    score += 35;
  } else if (/easy apply|quick apply|1-click apply/i.test(blob)) {
    score += 98;
  } else if (/apply to role|apply for (the|this) job|apply to (the|this) job|i'?m interested|apply here|apply today|start application/i.test(blob)) {
    score += 90;
  } else if (/apply now/i.test(blob)) {
    score += 82;
  } else if (/\\bapply\\b/i.test(meta.text || meta.value || "")) {
    score += 55;
  }
  if (/apply (for|to) (fall|winter|spring|summer|yc|y combinator|the .* batch)/i.test(blob)) score -= 140;
  if (/submit application/i.test(blob)) score -= 90;
  if (/apply|interested/i.test(meta.testId || "")) score += 45;
  if (meta.inMainContent) score += 25;
  if (meta.inJobContext) score += 20;
  if (meta.inNav) score -= 50;
  if (meta.inFooter) score -= 15;
  if (meta.tag === "button" || meta.role === "button") score += 18;
  if (meta.tag === "a" && /apply|interested/i.test(blob)) score += 10;
  if (meta.tag === "input" && !meta.href) {
    if (inputType === "submit" || /\\bapply\\b/i.test(blob)) score -= 20;
    else score -= 85;
  }
  if (meta.area < 800) score -= 25;
  if (meta.area > 4000 && meta.area < 80000) score += 8;
  if (/sign in|log in|register|search jobs|save job|share/i.test(blob)) score -= 60;
  var host = typeof pageHost !== "undefined" ? pageHost : "";
  var nativeApply = typeof hasNativeApplyButton !== "undefined" && hasNativeApplyButton;
  meta.pageHost = host;
  meta.hasNativeApplyButton = !!nativeApply;
  score += __entryHrefScoreDelta(meta, host, nativeApply);
  return score;
}
`.trim();

  return { helperJs };
}
