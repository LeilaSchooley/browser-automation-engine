/**
 * Detect and dismiss blocking ad overlays (GPT sticky units, interstitials, sponsored modals).
 * Complements cookie consent — runs when the page is locked behind non-consent overlays.
 */
import { humanPause } from "../human.js";
import {
  EXPERT_REVIEW_GATE_TEXT,
  INTERSTITIAL_DISMISS_PATTERNS,
  INTERSTITIAL_UPSELL_BODY,
  SKIP_AND_CONTINUE_PATTERN,
  SKIP_FREE_EXPERT_REVIEW_PATTERN,
  isResumeReviewUpsell,
  looksLikeGoogleVignetteAd,
} from "../heuristics.js";

/** Known close controls — tried before DOM scan candidates. */
const STRUCTURAL_DISMISS_SELECTORS = [
  ".phlexPopup .close",
  ".phlexPopup [class*='close' i]",
  ".jdJbeAlertPopUp .close",
  ".ajPopUpFrame .close",
  ".bb-sticky-close",
  ".bb-sticky-container .bb-sticky-close",
  "[class*='sticky-close' i]",
  "[class*='ad-close' i]",
  "[class*='ad_close' i]",
  "[data-ad-close]",
  "[aria-label='Close ad' i]",
  "[aria-label='Close advertisement' i]",
  "button[aria-label='Close' i][class*='ad' i]",
];

const AD_CONTEXT =
  /\b(sponsored|advertisement|adchoices|for employers|promoted|google_ads|div-gpt-ad|gpt-ad|indeed\.com)\b/i;

/**
 * Scan page for blocking overlays and scored dismiss targets.
 */
export async function scanBlockingOverlays(page) {
  try {
    return await page.evaluate(() => {
      function isVisibleEl(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      }

      function queryDeep(selector, root = document) {
        const out = [];
        try {
          out.push(...root.querySelectorAll(selector));
        } catch {
          /* invalid selector */
        }
        root.querySelectorAll("*").forEach((host) => {
          if (host.shadowRoot) out.push(...queryDeep(selector, host.shadowRoot));
        });
        return out;
      }

      function elementMeta(el) {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
        const testId = el.getAttribute("data-testid") || "";
        const aria = el.getAttribute("aria-label") || "";
        const id = el.id || "";
        let idUnique = false;
        if (id) {
          try {
            idUnique = document.querySelectorAll(`#${CSS.escape(id)}`).length === 1;
          } catch {
            idUnique = false;
          }
        }
        const style = window.getComputedStyle(el);
        const pos = style.position;
        const z = parseInt(style.zIndex, 10) || 0;
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          text: text.slice(0, 80),
          testId: testId.slice(0, 80),
          aria: aria.slice(0, 80),
          id,
          idUnique,
          className: (el.className || "").toString().slice(0, 120),
          selector: idUnique && id ? `#${id}` : "",
          inCookieDialog: !!el.closest(
            "#onetrust-banner-sdk, #onetrust-consent-sdk, [id*='cookie' i][role='dialog'], [class*='cookie' i][role='dialog']",
          ),
          inStickyAd: !!el.closest(".bb-sticky-container, .bb-sticky-box, [class*='sticky-ad' i], [id*='gpt-ad' i]"),
          inAdFrame: !!el.closest("[id^='div-gpt-ad'], [id*='google_ads'], [aria-label='Advertisement']"),
          fixed: pos === "fixed" || pos === "sticky",
          zIndex: z,
          area: Math.round(r.width * r.height),
        };
      }

      const body = document.body;
      const bodyLocked = body?.getAttribute("aria-hidden") === "true";
      const overlayHints = [];

      const fullscreenFixed = queryDeep("*").filter((el) => {
        if (!isVisibleEl(el)) return false;
        const style = window.getComputedStyle(el);
        if (style.position !== "fixed" && style.position !== "absolute") return false;
        const r = el.getBoundingClientRect();
        const covers =
          r.width >= window.innerWidth * 0.55 &&
          r.height >= window.innerHeight * 0.45 &&
          r.top <= 40;
        if (!covers) return false;
        const bg = style.backgroundColor || "";
        const opacity = parseFloat(style.opacity) || 1;
        const dimmed =
          /rgba?\([^)]*,\s*0\.[3-9]/.test(bg) ||
          (opacity > 0.2 && opacity < 0.95 && el.children.length === 0);
        const classBlob = `${el.className} ${el.id}`.toLowerCase();
        const looksOverlay =
          dimmed ||
          /overlay|backdrop|modal|interstitial|lightbox|dimmer/i.test(classBlob) ||
          (bodyLocked && covers);
        return looksOverlay;
      });

      if (bodyLocked) overlayHints.push("body[aria-hidden=true]");
      if (fullscreenFixed.length) overlayHints.push(`fullscreen-fixed:${fullscreenFixed.length}`);

      const gptAds = queryDeep("[id^='div-gpt-ad'], iframe[title*='ad' i], iframe[aria-label='Advertisement']").filter(
        isVisibleEl,
      );
      if (gptAds.length) overlayHints.push(`gpt-ads:${gptAds.length}`);

      const stickyContainers = queryDeep(".bb-sticky-container, .bb-sticky-box").filter(isVisibleEl);
      if (stickyContainers.length) overlayHints.push(`sticky-ad:${stickyContainers.length}`);

      // Google vignette (#google_vignette / adsbygoogle with data-vignette-loaded)
      const vignetteHash = /#google_vignette\b/i.test(location.href || "");
      const vignetteIns = queryDeep(
        "ins.adsbygoogle[data-vignette-loaded='true'], ins.adsbygoogle[data-ad-status='filled'], iframe[id^='aswift_'][aria-label='Advertisement'], iframe[title='Advertisement']",
      ).filter(isVisibleEl);
      const vignetteLarge = vignetteIns.some((el) => {
        const r = el.getBoundingClientRect();
        return r.width >= window.innerWidth * 0.4 && r.height >= window.innerHeight * 0.35;
      });
      if (vignetteHash || vignetteLarge) {
        overlayHints.push(vignetteHash ? "google-vignette:hash" : "google-vignette:iframe");
      }

      const interactiveSel =
        "button, a[href], [role='button'], [role='link'], input[type='button'], input[type='submit'], [class*='close' i]";

      const dismissRaw = [];
      for (const el of queryDeep(interactiveSel)) {
        if (!isVisibleEl(el)) continue;
        const meta = elementMeta(el);
        if (meta.inCookieDialog) continue;

        const blob = `${meta.text} ${meta.aria} ${meta.className} ${meta.testId}`.toLowerCase();
        let score = 0;

        if (/bb-sticky-close|sticky-close|ad-close|ad_close/i.test(meta.className)) score += 120;
        if (meta.inStickyAd) score += 80;
        if (el.closest(".phlexPopup, .jdJbeAlertPopUp, [class*='phlexPopup' i]")) {
          if (/^close$|^[×✕x]$/i.test(meta.text.trim()) || /close/i.test(meta.className)) score += 150;
        }
        if (/^close$/i.test(meta.text.trim()) || /^[×✕x]$/i.test(meta.text.trim())) score += 70;
        if (/close/i.test(meta.aria)) score += 65;
        if (/close/i.test(meta.className) && meta.area < 12000) score += 50;
        if (meta.fixed && score > 0) score += 25;
        if (meta.zIndex >= 1000 && score > 0) score += 20;
        // Vignette Close sits above the ad chrome
        if ((vignetteHash || vignetteLarge) && /^close$/i.test(meta.text.trim())) score += 160;
        if ((vignetteHash || vignetteLarge) && /^[×✕x]$/i.test(meta.text.trim())) score += 140;

        const parentDialog = el.closest(
          "[role='dialog'], [aria-modal='true'], .modal, [class*='ui-modal' i], [class*='interstitial' i], .bb-sticky-box, .phlexPopup, .jdJbeAlertPopUp",
        );
        const parentText = (parentDialog?.innerText || "").slice(0, 600).toLowerCase().replace(/[\u2018\u2019]/g, "'");
        const adNearby = AD_CONTEXT.test(parentText) || AD_CONTEXT.test(blob) || meta.inAdFrame || meta.inStickyAd;
        if (adNearby && score > 0) score += 40;

        // Generic interstitial: dialog with upsell/paywall copy + Skip / No thanks / etc.
        const dismissLabel = /^(skip|skip to (application|apply)|no[, ]?thanks|not now|maybe later|continue without( documents)?|dismiss|no,? pass|i'?ll pass|skip (for )?now)$/i.test(
            meta.text.trim(),
          );
        const upsellBody =
          /auto-?rejected|won'?t reach a human|fix my resume|ats software will filter|quick wins|get more replies|increase your chances|tailor your resume|upgrade|go premium|paywall|successful candidates score/i.test(
            parentText,
          );
        if (parentDialog && dismissLabel && upsellBody) score += 200;
        else if (parentDialog && dismissLabel && /modal-open|aria-modal/i.test(document.body?.className || "")) {
          score += 120;
        } else if (parentDialog && dismissLabel) {
          score += 90;
        }

        if (bodyLocked && /^close$/i.test(meta.text.trim()) && meta.fixed) score += 50;

        if (bodyLocked && meta.tag === "a" && /^close$/i.test(meta.text.trim()) && !meta.inCookieDialog) {
          score += 90;
        }

        if (/apply|submit|accept all|agree|cookie|consent|sign in|log in|fix my resume/i.test(blob) && !meta.inStickyAd && !dismissLabel) {
          score -= 80;
        }

        if (score >= 55) {
          dismissRaw.push({
            ...meta,
            score,
            kind: "dismiss",
            source: parentDialog && dismissLabel ? "interstitial-dismiss" : "dom-scan",
          });
        }
      }

      dismissRaw.sort((a, b) => b.score - a.score);
      const seen = new Set();
      const dismissCandidates = [];
      for (const c of dismissRaw) {
        const key = `${c.selector}:${c.text}:${c.className.slice(0, 30)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dismissCandidates.push(c);
        if (dismissCandidates.length >= 8) break;
      }

      const phlexOverlays = queryDeep(".phlexOverlay, [class*='phlexOverlay' i]").filter(isVisibleEl);
      if (phlexOverlays.length) overlayHints.push(`phlex-overlay:${phlexOverlays.length}`);

      const hasBlockingOverlay =
        bodyLocked ||
        stickyContainers.length > 0 ||
        phlexOverlays.length > 0 ||
        vignetteHash ||
        vignetteLarge ||
        (fullscreenFixed.length > 0 && dismissCandidates.length > 0) ||
        dismissCandidates.some((c) => c.score >= 100) ||
        dismissCandidates.some((c) => c.source === "interstitial-dismiss");

      if (dismissCandidates.some((c) => c.source === "interstitial-dismiss")) {
        overlayHints.push("interstitial-dismiss");
      }

      return {
        hasBlockingOverlay,
        bodyLocked,
        dismissCount: dismissCandidates.length,
        dismissCandidates,
        overlayHints,
      };
    });
  } catch {
    return {
      hasBlockingOverlay: false,
      bodyLocked: false,
      dismissCount: 0,
      dismissCandidates: [],
      overlayHints: [],
    };
  }
}

export function mergeOverlaySnap(snap, overlay) {
  if (!snap || !overlay) return snap;
  snap.hasBlockingOverlay = !!overlay.hasBlockingOverlay;
  snap.bodyLocked = !!overlay.bodyLocked;
  snap.dismissCount = overlay.dismissCount || 0;
  snap.dismissCandidates = overlay.dismissCandidates || [];
  snap.overlayHints = overlay.overlayHints || [];
  if (snap.hasBlockingOverlay && snap.pageKind !== "form") {
    snap.pageKind = "overlay";
  }
  return snap;
}

async function clickStructuralDismiss(page, log, layer) {
  for (const sel of STRUCTURAL_DISMISS_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.isVisible({ timeout: 600 }).catch(() => false))) continue;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 6000 });
      log?.layer(layer, `dismiss: structural \`${sel}\``, "info");
      await humanPause(500, 1000);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

async function clickDismissCandidate(page, candidate, log, layer) {
  const attempts = [];
  const isUpsellSkip =
    candidate.source === "resume-review-upsell" ||
    candidate.source === "interstitial-dismiss" ||
    /resume-review-upsell|interstitial-dismiss/i.test(candidate.testId || "") ||
    /^(skip|skip and continue|skip & continue)$/i.test((candidate.text || "").trim()) ||
    SKIP_AND_CONTINUE_PATTERN.test(candidate.text || "");

  if (isUpsellSkip) {
    attempts.push(async () => {
      const modal = page.locator(
        '[role="dialog"][aria-modal="true"], [role="dialog"], .modal, [aria-modal="true"]',
      );
      for (const role of ["button", "link"]) {
        const scoped = modal.getByRole(role).filter({ hasText: SKIP_AND_CONTINUE_PATTERN }).first();
        if (await scoped.isVisible({ timeout: 800 }).catch(() => false)) {
          await scoped.click({ timeout: 6000 });
          log?.layer(layer, `dismiss: expert review — skip "${(await scoped.innerText().catch(() => "Skip and continue")).trim()}"`, "info");
          return true;
        }
      }
      for (const pattern of INTERSTITIAL_DISMISS_PATTERNS) {
        const scoped = modal.getByRole("button", { name: pattern }).first();
        if (await scoped.isVisible({ timeout: 800 }).catch(() => false)) {
          await scoped.click({ timeout: 6000 });
          log?.layer(layer, `dismiss: interstitial — "${pattern.source}"`, "info");
          return true;
        }
      }
      // Design-system div buttons (e.g. ds-button)
      if (await clickDismissByTextInDialog(modal.first(), log, layer)) return true;
      const anySkip = page.getByRole("button", { name: /^Skip$/i }).first();
      if (await anySkip.isVisible({ timeout: 800 }).catch(() => false)) {
        await anySkip.click({ timeout: 6000 });
        log?.layer(layer, 'dismiss: Skip button', "info");
        return true;
      }
      return false;
    });
  }

  if (candidate.selector && !/ds-button/i.test(candidate.selector)) {
    attempts.push(async () => {
      const loc = page.locator(candidate.selector).first();
      if (!(await loc.isVisible({ timeout: 800 }).catch(() => false))) return false;
      await loc.click({ timeout: 6000 });
      log?.layer(layer, `dismiss: \`${candidate.selector}\` "${candidate.text}"`, "info");
      return true;
    });
  }

  if (candidate.className && /bb-sticky-close|sticky-close/i.test(candidate.className)) {
    attempts.push(async () => {
      const loc = page.locator(".bb-sticky-close, [class*='sticky-close' i]").first();
      if (!(await loc.isVisible({ timeout: 800 }).catch(() => false))) return false;
      await loc.click({ timeout: 6000 });
      log?.layer(layer, `dismiss: sticky close "${candidate.text}"`, "info");
      return true;
    });
  }

  const text = (candidate.text || "").trim();
  if (/^(close|×|✕|x)$/i.test(text)) {
    attempts.push(async () => {
      const loc = page.getByRole("link", { name: /^close$/i }).first();
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        await loc.click({ timeout: 6000 });
        log?.layer(layer, "dismiss: Close link", "info");
        return true;
      }
      const btn = page.getByRole("button", { name: /^close$/i }).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ timeout: 6000 });
        log?.layer(layer, "dismiss: Close button", "info");
        return true;
      }
      return false;
    });
  }

  if (candidate.aria && /close/i.test(candidate.aria)) {
    attempts.push(async () => {
      const loc = page.getByLabel(new RegExp(candidate.aria.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).first();
      if (!(await loc.isVisible({ timeout: 800 }).catch(() => false))) return false;
      await loc.click({ timeout: 6000 });
      log?.layer(layer, `dismiss: aria "${candidate.aria}"`, "info");
      return true;
    });
  }

  // Generic text dismiss (Skip, No thanks, Not now, etc.)
  if (text && text.length < 40 && !/^(close|×|✕|x)$/i.test(text)) {
    attempts.push(async () => {
      const re = new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");
      const btn = page.getByRole("button", { name: re }).first();
      if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
        await btn.click({ timeout: 6000 });
        log?.layer(layer, `dismiss: button "${text}"`, "info");
        return true;
      }
      const link = page.getByRole("link", { name: re }).first();
      if (await link.isVisible({ timeout: 800 }).catch(() => false)) {
        await link.click({ timeout: 6000 });
        log?.layer(layer, `dismiss: link "${text}"`, "info");
        return true;
      }
      return false;
    });
  }

  for (const tryClick of attempts) {
    try {
      if (await tryClick()) {
        await humanPause(700, 1400);
        return true;
      }
    } catch (exc) {
      log?.layer(layer, `dismiss: click failed (${exc.message})`, "debug");
    }
  }
  return false;
}

async function removeStickyAdContainers(page, log, layer) {
  try {
    const removed = await page.evaluate(() => {
      let n = 0;
      document.querySelectorAll(".bb-sticky-container, .bb-sticky-box").forEach((el) => {
        el.remove();
        n += 1;
      });
      const body = document.body;
      if (body?.getAttribute("aria-hidden") === "true") {
        body.removeAttribute("aria-hidden");
        body.style.top = "";
        n += 1;
      }
      return n;
    });
    if (removed > 0) {
      log?.layer(layer, `dismiss: removed ${removed} sticky/lock element(s) via DOM`, "info");
      await humanPause(400, 800);
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * WhatJobs Phlex job-alert popup — close X, not role=dialog.
 */
export async function dismissPhlexPopup(page, log, layer = "page_prep") {
  try {
    const popup = page.locator(".phlexPopup, .jdJbeAlertPopUp, [class*='phlexPopup' i]").first();
    if (!(await popup.isVisible({ timeout: 400 }).catch(() => false))) return false;

    for (const sel of [
      ".close",
      "[class*='close' i]",
      "a[title='Close']",
      "button[aria-label='Close' i]",
    ]) {
      const close = popup.locator(sel).first();
      if (!(await close.isVisible({ timeout: 250 }).catch(() => false))) continue;
      await close.click({ timeout: 6000, force: true });
      await humanPause(600, 1100);
      log?.layer(layer, `dismiss: phlex job-alert popup — clicked ${sel}`, "info");
      return true;
    }

    const overlay = page.locator(".phlexOverlay, [class*='phlexOverlay' i]").first();
    if (await overlay.isVisible({ timeout: 250 }).catch(() => false)) {
      await overlay.click({ timeout: 4000, force: true, position: { x: 5, y: 5 } });
      await humanPause(600, 1100);
      log?.layer(layer, "dismiss: phlex overlay — backdrop click", "info");
      return true;
    }
  } catch (exc) {
    log?.layer(layer, `dismiss: phlex popup failed (${exc.message})`, "debug");
  }
  return false;
}

/**
 * Dismiss a blocking interstitial/upsell dialog by its secondary action
 * (Skip, No thanks, Not now, …) — works on any site from dialog text, not CSS ids.
 *
 * JobLeads-style UIs often render CTAs as <div class="ds-button"> rather than
 * <button>, so role-based queries miss "Skip and continue" even when it's visible.
 */
export async function dismissInterstitialDialog(page, log, layer = "page_prep") {
  const unmatchedDialogs = [];
  try {
    const dialogs = page.locator(
      '[role="dialog"][aria-modal="true"], [aria-modal="true"], [role="dialog"], [class*="ui-modal"], [class*="modal" i]',
    );
    const n = Math.min(await dialogs.count().catch(() => 0), 6);
    const locked = await page
      .evaluate(
        () =>
          document.body?.classList?.contains("modal-open") ||
          document.body?.getAttribute("aria-hidden") === "true",
      )
      .catch(() => false);

    for (let i = 0; i < n; i += 1) {
      const dialog = dialogs.nth(i);
      if (!(await dialog.isVisible({ timeout: 300 }).catch(() => false))) continue;
      const bodyRaw = ((await dialog.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      const body = bodyRaw.replace(/[\u2018\u2019']/g, "'").toLowerCase();
      const looksUpsell =
        INTERSTITIAL_UPSELL_BODY.test(body) || EXPERT_REVIEW_GATE_TEXT.test(body);
      if (!looksUpsell && !locked) continue;

      // 1) Accessible roles first
      for (const role of ["button", "link"]) {
        const skipContinue = dialog.getByRole(role).filter({ hasText: SKIP_AND_CONTINUE_PATTERN }).first();
        if (!(await skipContinue.isVisible({ timeout: 250 }).catch(() => false))) continue;
        const label = ((await skipContinue.innerText().catch(() => "")) || "Skip and continue")
          .replace(/\s+/g, " ")
          .trim();
        await skipContinue.click({ timeout: 6000 });
        await humanPause(700, 1400);
        log?.layer(layer, `dismiss: interstitial — clicked "${label}" (skip-and-continue)`, "info");
        return true;
      }

      for (const pattern of INTERSTITIAL_DISMISS_PATTERNS) {
        for (const role of ["button", "link"]) {
          const btn = dialog.getByRole(role, { name: pattern }).first();
          if (!(await btn.isVisible({ timeout: 250 }).catch(() => false))) continue;
          const label = ((await btn.innerText().catch(() => "")) || pattern.source).replace(/\s+/g, " ").trim();
          await btn.click({ timeout: 6000 });
          await humanPause(700, 1400);
          log?.layer(layer, `dismiss: interstitial — clicked "${label}" (${pattern.source})`, "info");
          return true;
        }
      }

      // 2) Div/span "buttons" (ds-button, cursor-pointer) — common on design systems
      const clickedFake = await clickDismissByTextInDialog(dialog, log, layer);
      if (clickedFake) return true;

      // 3) Corner close (Jobright "Boost Your Resume" etc.)
      for (const sel of [
        'button[aria-label="Close" i]',
        '[aria-label="Close" i]',
        'button[aria-label="Dismiss" i]',
        '[class*="Modal"][class*="close" i]',
        '[class*="modal"][class*="close" i]',
        '[class*="dialog"][class*="close" i]',
        'button[class*="close" i]',
        '[class*="close" i][role="button"]',
        '[class*="CloseButton" i]',
        '[data-testid*="close" i]',
        'button:has-text("×")',
        'button:has-text("✕")',
      ]) {
        const closeBtn = dialog.locator(sel).first();
        if (!(await closeBtn.isVisible({ timeout: 250 }).catch(() => false))) continue;
        await closeBtn.click({ timeout: 6000 });
        await humanPause(700, 1400);
        log?.layer(layer, `dismiss: interstitial — close control \`${sel}\``, "info");
        return true;
      }

      // 4) Icon-only close: top-right clickable in dialog (no accessible name)
      const iconClose = await clickIconCloseInDialog(dialog, log, layer);
      if (iconClose) return true;

      unmatchedDialogs.push(bodyRaw.slice(0, 100));
    }

    if (unmatchedDialogs.length) {
      log?.layer(
        layer,
        `dismiss: interstitial — ${unmatchedDialogs.length} upsell dialog(s), no dismiss button matched: ${unmatchedDialogs.map((t) => `"${t}"`).join("; ")}`,
        "info",
      );
      // Escape often closes Jobright boost / LinkedIn-paste modals with only an icon X.
      try {
        await page.keyboard.press("Escape");
        await humanPause(500, 900);
        const still = await page
          .locator('[role="dialog"], [aria-modal="true"]')
          .filter({ hasText: /boost your resume|paste any linkedin|linkedin profile url/i })
          .first()
          .isVisible({ timeout: 600 })
          .catch(() => false);
        if (!still) {
          log?.layer(layer, "dismiss: interstitial — Escape cleared upsell dialog", "info");
          return true;
        }
      } catch {
        /* ignore */
      }
    }
  } catch (exc) {
    log?.layer(layer, `dismiss: interstitial failed (${exc.message})`, "info");
  }
  return false;
}

/** Click a nameless top-right icon close inside an upsell dialog. */
async function clickIconCloseInDialog(dialog, log, layer) {
  try {
    const hit = await dialog.evaluate((root) => {
      const box = root.getBoundingClientRect();
      if (box.width < 80 || box.height < 80) return null;
      const nodes = root.querySelectorAll("button, a, [role='button'], svg, span, div");
      let best = null;
      let bestScore = -1;
      for (const el of nodes) {
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10 || r.width > 56 || r.height > 56) continue;
        // Prefer top-right quadrant of the dialog
        const nearRight = r.right > box.right - 72;
        const nearTop = r.top < box.top + 72;
        if (!nearRight || !nearTop) continue;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length > 2 && !/^[×✕xX]$/.test(text)) continue;
        const score = (nearRight ? 40 : 0) + (nearTop ? 40 : 0) + (el.tagName === "BUTTON" || el.getAttribute("role") === "button" ? 20 : 0);
        if (score > bestScore) {
          bestScore = score;
          best = el;
        }
      }
      if (!best) return null;
      // Prefer clickable ancestor button if svg/span was chosen
      let target = best;
      if (best.tagName === "SVG" || best.tagName === "SPAN" || best.tagName === "DIV") {
        const btn = best.closest("button, a, [role='button']");
        if (btn && root.contains(btn)) target = btn;
      }
      target.click();
      return { tag: target.tagName, cls: (target.className || "").toString().slice(0, 80) };
    });
    if (hit) {
      await humanPause(700, 1400);
      log?.layer(layer, `dismiss: interstitial — icon close <${hit.tag}> ${hit.cls}`, "info");
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/** Click Skip / No thanks even when rendered as a non-button element. */
async function clickDismissByTextInDialog(dialog, log, layer) {
  const patterns = [
    SKIP_FREE_EXPERT_REVIEW_PATTERN,
    SKIP_AND_CONTINUE_PATTERN,
    /skip\s+to\s+(application|apply)/i,
    /^skip$/i,
    /^skip for now$/i,
    /^no[, ]?thanks$/i,
    /^not now$/i,
    /^maybe later$/i,
    /^close$/i,
    /^do it later$/i,
  ];

  for (const pattern of patterns) {
    // Prefer compact clickable hosts over the whole dialog text node
    const hosts = dialog.locator(
      'button, a, [role="button"], [class*="button" i], [class*="btn" i], [class*="ds-button" i], [class*="cursor-pointer" i], span, div, p',
    );
    const n = Math.min(await hosts.count().catch(() => 0), 40);
    let best = null;
    let bestLen = Infinity;
    for (let i = 0; i < n; i += 1) {
      const el = hosts.nth(i);
      if (!(await el.isVisible({ timeout: 100 }).catch(() => false))) continue;
      const text = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      if (!text || text.length > 80) continue;
      if (!pattern.test(text)) continue;
      // Exact-ish match preferred (avoid clicking a giant container that merely contains the words)
      if (text.length < bestLen) {
        best = el;
        bestLen = text.length;
      }
    }
    if (best) {
      const label = ((await best.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
      await best.click({ timeout: 6000 });
      await humanPause(700, 1400);
      log?.layer(layer, `dismiss: interstitial — clicked "${label}" (text fallback)`, "info");
      return true;
    }

    // Last resort: getByText on the dialog
    const byText = dialog.getByText(pattern).first();
    if (await byText.isVisible({ timeout: 250 }).catch(() => false)) {
      const label = ((await byText.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim().slice(0, 60);
      await byText.click({ timeout: 6000 });
      await humanPause(700, 1400);
      log?.layer(layer, `dismiss: interstitial — clicked "${label}" (getByText)`, "info");
      return true;
    }
  }
  return false;
}

/** @deprecated alias */
export async function dismissResumeReviewUpsell(page, log, layer = "page_prep") {
  return dismissInterstitialDialog(page, log, layer);
}

/**
 * Google vignette ads (#google_vignette / adsbygoogle) block clicks with cross-origin iframes.
 * Prefer Close / Escape; fall back to removing vignette nodes so Apply can proceed.
 */
export async function dismissGoogleVignette(page, log, layer = "page_prep") {
  try {
    const url = page.url?.() || "";
    const hasHash = /#google_vignette\b/i.test(url);
    const hasIns = await page
      .locator("ins.adsbygoogle[data-vignette-loaded='true'], iframe[id^='aswift_'][aria-label='Advertisement']")
      .first()
      .isVisible({ timeout: 400 })
      .catch(() => false);
    if (!hasHash && !hasIns) return false;

    // 1) Visible Close above the ad (parent page control)
    for (const pattern of [/^Close$/i, /^[×✕]$/]) {
      const btn = page.getByRole("button", { name: pattern }).first();
      if (await btn.isVisible({ timeout: 350 }).catch(() => false)) {
        await btn.click({ timeout: 4000, force: true }).catch(() => null);
        await humanPause(500, 900);
        log?.layer(layer, `dismiss: google vignette — clicked Close (${pattern})`, "info");
        if (!/#google_vignette\b/i.test(page.url())) return true;
      }
      const link = page.getByRole("link", { name: pattern }).first();
      if (await link.isVisible({ timeout: 250 }).catch(() => false)) {
        await link.click({ timeout: 4000, force: true }).catch(() => null);
        await humanPause(500, 900);
        log?.layer(layer, "dismiss: google vignette — clicked Close link", "info");
        if (!/#google_vignette\b/i.test(page.url())) return true;
      }
    }

    // 2) Escape
    await page.keyboard.press("Escape");
    await humanPause(400, 700);

    // 3) Strip vignette hash + remove ad nodes (SEO mirrors only path that unblocks reliably)
    const removed = await page.evaluate(() => {
      let n = 0;
      if (/#google_vignette\b/i.test(location.hash || "")) {
        history.replaceState(null, "", location.pathname + location.search);
        n += 1;
      }
      document
        .querySelectorAll(
          "ins.adsbygoogle[data-vignette-loaded='true'], ins.adsbygoogle.adsbygoogle-noablate, iframe[id^='aswift_'][aria-label='Advertisement']",
        )
        .forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 80 && r.height < 80) return;
          el.remove();
          n += 1;
        });
      document.body?.style && (document.body.style.overflow = "");
      document.documentElement?.style && (document.documentElement.style.overflow = "");
      return n;
    });

    if (removed > 0) {
      log?.layer(layer, `dismiss: google vignette — cleared overlay (${removed} change(s))`, "info");
      await humanPause(500, 900);
      return true;
    }
  } catch (exc) {
    log?.layer(layer, `dismiss: google vignette failed (${exc.message})`, "debug");
  }
  return false;
}

/** Dismiss blocking ad overlays. Returns true if any dismiss action succeeded. */
export async function dismissBlockingOverlays(page, log, layer = "page_prep", snap = null) {
  if (await dismissGoogleVignette(page, log, layer)) return true;
  if (snap && looksLikeGoogleVignetteAd(snap) && (await dismissGoogleVignette(page, log, layer))) return true;
  if (await dismissPhlexPopup(page, log, layer)) return true;

  // Chained upsells (e.g. Skip → Skip to application) — dismiss until none left.
  let anyDismissed = false;
  for (let chain = 0; chain < 3; chain += 1) {
    if (!(await dismissInterstitialDialog(page, log, layer))) break;
    anyDismissed = true;
    await humanPause(500, 900);
  }
  if (anyDismissed) return true;

  const overlay =
    snap?.dismissCandidates != null
      ? {
          hasBlockingOverlay: snap.hasBlockingOverlay,
          dismissCandidates: snap.dismissCandidates,
          overlayHints: snap.overlayHints,
        }
      : await scanBlockingOverlays(page);

  if (!overlay.hasBlockingOverlay && !(overlay.dismissCandidates || []).length) {
    if (await clickStructuralDismiss(page, log, layer)) return true;
    // Resume boost modals often lack Skip text + hasBlockingOverlay — still try Escape.
    if (snap && (isResumeReviewUpsell(snap) || INTERSTITIAL_UPSELL_BODY.test(String(snap.applyModalTitle || snap.pageText || "")))) {
      try {
        await page.keyboard.press("Escape");
        await humanPause(400, 800);
        log?.layer(layer, "dismiss: Escape after unmatched resume upsell", "info");
        return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  if (overlay.overlayHints?.length) {
    log?.layer(layer, `overlay: ${overlay.overlayHints.join(", ")}`, "info");
  }

  if (await clickStructuralDismiss(page, log, layer)) return true;

  for (const c of overlay.dismissCandidates || []) {
    if (await clickDismissCandidate(page, c, log, layer)) return true;
  }

  try {
    await page.keyboard.press("Escape");
    await humanPause(300, 600);
    const afterEsc = await scanBlockingOverlays(page);
    if (!afterEsc.hasBlockingOverlay) {
      log?.layer(layer, "dismiss: Escape cleared overlay", "info");
      return true;
    }
  } catch {
    /* ignore */
  }

  if (await removeStickyAdContainers(page, log, layer)) return true;

  log?.layer(layer, "dismiss: overlay detected but no close control worked", "info");
  return false;
}
