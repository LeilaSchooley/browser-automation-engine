/**
 * CAPTCHA / challenge detection — patterns aligned with botlord-monorepo
 * (`CAPTCHA_SELECTORS` + URL / body scans in captcha-service / search-serp).
 * Waits for manual solve (AdsPower window) instead of thrashing clicks.
 */
import { getRuntime, getSettings } from "./runtime.js";
import { CAPTCHA_TEXT } from "./patterns/blocked.js";

/** Ordered like @botlord/constants CAPTCHA_SELECTORS, plus common bot defenses. */
export const CAPTCHA_SELECTORS = [
  "div[role='captcha']",
  "#recaptcha-token",
  "#recaptcha",
  "div.g-recaptcha",
  "iframe[src*='google.com/recaptcha']",
  "iframe[src*='recaptcha.net']",
  "iframe[title*='reCAPTCHA' i]",
  "iframe[title*='recaptcha challenge' i]",
  "iframe[src*='recaptcha/api2/bframe']",
  "iframe[src*='hcaptcha.com']",
  "iframe[title*='hCaptcha' i]",
  "#captcha-form",
  "form#captcha-form",
  "#challenge-form",
  "#cf-challenge-running",
  "#cf-please-wait",
  ".cf-turnstile",
  "iframe[src*='challenges.cloudflare.com']",
  "iframe[src*='arkoselabs']",
  "iframe[src*='funcaptcha']",
  "iframe[src*='perimeterx']",
  "iframe[src*='humansecurity']",
  "iframe[src*='datadome']",
  "#px-captcha",
  "[id*='px-captcha' i]",
  "[class*='px-captcha' i]",
  "[data-testid*='captcha' i]",
];

/** Challenge frames that may not report isVisible() but still block interaction. */
const CHALLENGE_FRAME_SELECTORS = [
  "iframe[src*='recaptcha/api2/bframe']",
  "iframe[title*='recaptcha challenge' i]",
  "iframe[src*='hcaptcha.com'][src*='frame=challenge']",
  "iframe[src*='challenges.cloudflare.com']",
  "iframe[src*='arkoselabs']",
  "iframe[src*='funcaptcha']",
];

const URL_MARKERS = [
  "sorry",
  "/recaptcha",
  "recaptcha.net",
  "challenges.cloudflare.com",
  "/sorry/index",
  "arkoselabs",
  "funcaptcha",
  "hcaptcha.com",
  "perimeterx",
  "datadome",
];

const BODY_PHRASES = [
  "unusual traffic",
  "our systems have detected unusual traffic",
  "automated queries",
  "please solve this captcha",
  "verify you are human",
  "before you continue to google",
  "this page checks to see if it's really you",
  "are you a robot",
  "press and hold",
  "complete the security check",
  "confirm you are a human",
];

export function looksLikeCaptchaReason(reason = "") {
  return /\b(captcha|recaptcha|hcaptcha|turnstile|human verification|security check|challenge)\b/i.test(
    String(reason || ""),
  );
}

/** Playwright click failures when a challenge iframe swallows pointer events. */
export function looksLikeCaptchaClickError(err) {
  const msg = String(err?.message || err || "");
  return (
    /recaptcha|hcaptcha|turnstile|funcaptcha|arkose|bframe|captcha challenge/i.test(msg) ||
    (/intercepts pointer events/i.test(msg) &&
      /iframe|recaptcha|challenge|captcha/i.test(msg))
  );
}

/**
 * Probe after a failed (or suspiciously “ok”) click — used by recovery paths.
 * @returns {Promise<{ detected: boolean, reason: string, source: string }>}
 */
export async function probeCaptchaAfterAction(page, { snap = null, error = null } = {}) {
  if (looksLikeCaptchaClickError(error)) {
    return {
      detected: true,
      reason: "CAPTCHA challenge intercepted click",
      source: "click_error",
    };
  }
  return detectCaptcha(page, { snap, suspectPointerBlock: true });
}

/** Fast snap-only signal (no Playwright). Used by classify / hard-gate heuristics. */
export function looksLikeCaptchaInSnap(snap) {
  if (!snap) return false;
  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""} ${snap.url || ""}`.toLowerCase();
  if (CAPTCHA_TEXT.test(blob)) return true;
  if (URL_MARKERS.some((m) => blob.includes(m))) return true;
  return BODY_PHRASES.some((p) => blob.includes(p));
}

function urlLooksBlocked(url = "") {
  const u = String(url || "").toLowerCase();
  return URL_MARKERS.some((m) => u.includes(m));
}

/**
 * Detect a challenge that blocks interaction.
 * @param {import('playwright').Page} page
 * @param {{ snap?: object, suspectPointerBlock?: boolean }} [opts]
 * @returns {Promise<{ detected: boolean, reason: string, source: string }>}
 */
export async function detectCaptcha(page, opts = {}) {
  const { snap = null, suspectPointerBlock = false } = opts;

  if (looksLikeCaptchaInSnap(snap)) {
    return { detected: true, reason: "CAPTCHA / human verification (page text)", source: "snap" };
  }

  let currentUrl = "";
  try {
    currentUrl = page.url() || "";
  } catch {
    return { detected: false, reason: "", source: "" };
  }

  if (urlLooksBlocked(currentUrl)) {
    return {
      detected: true,
      reason: `CAPTCHA / challenge URL (${currentUrl.slice(0, 100)})`,
      source: "url",
    };
  }

  for (const sel of CAPTCHA_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible({ timeout: 250 }).catch(() => false);
      if (visible) {
        return { detected: true, reason: `CAPTCHA widget (${sel})`, source: "dom" };
      }
    } catch {
      /* next selector */
    }
  }

  // Challenge frames (bframe etc.) — must be visible + sized; leftover DOM after solve is common.
  for (const sel of CHALLENGE_FRAME_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      const visible = await loc.isVisible({ timeout: 300 }).catch(() => false);
      if (!visible) continue;
      const box = await loc.boundingBox().catch(() => null);
      if (box && box.width >= 40 && box.height >= 40) {
        return { detected: true, reason: `CAPTCHA challenge frame (${sel})`, source: "dom" };
      }
    } catch {
      /* next */
    }
  }

  // Non-visible mounts that almost always mean an interstitial (not the inert recaptcha badge).
  const blockingOnly = [
    "#captcha-form",
    "form#captcha-form",
    "#challenge-form",
    "#cf-challenge-running",
    "#px-captcha",
    "[id*='px-captcha' i]",
  ];
  for (const sel of blockingOnly) {
    try {
      const count = await page.locator(sel).count().catch(() => 0);
      if (count > 0) {
        return { detected: true, reason: `CAPTCHA element in DOM (${sel})`, source: "dom" };
      }
    } catch {
      /* next */
    }
  }

  let bodyHit = false;
  try {
    bodyHit = await page.evaluate((phrases) => {
      const body = (document.body?.innerText || document.title || "").toLowerCase().slice(0, 8000);
      return phrases.some((p) => body.includes(p));
    }, BODY_PHRASES);
  } catch {
    bodyHit = false;
  }
  if (bodyHit) {
    return { detected: true, reason: "CAPTCHA / blocking challenge text", source: "body" };
  }

  if (suspectPointerBlock) {
    const overlay = await detectPointerBlockingOverlay(page).catch(() => null);
    if (overlay?.blocked) {
      return {
        detected: true,
        reason: overlay.reason || "pointer-blocking challenge overlay",
        source: "overlay",
      };
    }
  }

  return { detected: false, reason: "", source: "" };
}

/**
 * Empty/full-bleed overlay at viewport center — common when Indeed/PX intercepts Continue.
 */
async function detectPointerBlockingOverlay(page) {
  return page.evaluate(() => {
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (vw < 100 || vh < 100) return { blocked: false };

    const hints =
      /captcha|challenge|px-|arkose|funcaptcha|hcaptcha|recaptcha|turnstile|datadome|human.?secur|bot.?detect/i;

    const walk = (el, depth = 0) => {
      const chain = [];
      let n = el;
      while (n && n !== document.documentElement && depth < 12) {
        const id = n.id || "";
        const cls = typeof n.className === "string" ? n.className : "";
        const testId = n.getAttribute?.("data-testid") || "";
        chain.push(`${n.tagName}#${id}.${cls}[${testId}]`);
        if (hints.test(`${id} ${cls} ${testId}`)) return { blocked: true, reason: `CAPTCHA overlay (${id || cls || testId})` };
        n = n.parentElement;
        depth += 1;
      }
      return { blocked: false, chain };
    };

    const sample = document.elementFromPoint(vw / 2, vh / 2);
    if (!sample) return { blocked: false };

    const tagged = walk(sample);
    if (tagged.blocked) return tagged;

    const style = window.getComputedStyle(sample);
    const r = sample.getBoundingClientRect();
    const covers = r.width >= vw * 0.45 && r.height >= vh * 0.35;
    const fixedOrSticky = style.position === "fixed" || style.position === "sticky";
    const z = parseInt(style.zIndex, 10);
    const highZ = Number.isFinite(z) && z >= 50;
    const text = (sample.innerText || "").trim();
    const emptyish =
      !text &&
      (sample.tagName === "DIV" || sample.tagName === "SECTION" || sample.tagName === "SPAN") &&
      sample.children.length <= 2;

    // Opaque or semi-opaque full-bleed layer that isn't normal page chrome
    const pe = style.pointerEvents;
    if (covers && emptyish && (fixedOrSticky || highZ) && pe !== "none") {
      return { blocked: true, reason: "CAPTCHA / challenge overlay intercepting clicks" };
    }

    return { blocked: false };
  });
}

/**
 * Poll until challenge clears or timeout. Surfaces needs_user_action for the dashboard.
 * @returns {Promise<boolean>} true if cleared
 */
export async function waitForCaptchaClear(page, sessionId = null, opts = {}) {
  const settings = getSettings();
  if (settings.captcha_wait_enabled === false) {
    return false;
  }

  const { onStatus } = getRuntime();
  const timeoutSec = Math.max(30, Number(opts.timeoutSec || settings.captcha_wait_timeout_sec || 300));
  const timeoutMs = timeoutSec * 1000;
  const pollMs = Math.max(1500, Number(opts.pollMs || 2500));
  const reason = opts.initial?.reason || "CAPTCHA / human verification";

  const update = (payload) => {
    if (sessionId) onStatus?.(sessionId, payload);
  };

  update({
    phase: "captcha",
    message: `${reason} — solve it in the browser window; agent will resume…`,
    needs_user_action: true,
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = await detectCaptcha(page, {
      suspectPointerBlock: Boolean(opts.initial?.source === "overlay" || opts.keepSuspectOverlay),
    });
    if (!hit.detected) {
      update({
        phase: "verified",
        message: "Challenge cleared — continuing…",
        needs_user_action: false,
      });
      return true;
    }
    await page.waitForTimeout(pollMs).catch(() => new Promise((r) => setTimeout(r, pollMs)));
  }

  update({
    phase: "captcha_timeout",
    message: "CAPTCHA wait timed out — finish the challenge in the browser, then re-run if needed.",
    needs_user_action: true,
  });
  return false;
}
