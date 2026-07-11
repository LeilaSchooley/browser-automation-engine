/**
 * Detect and dismiss blocking ad overlays (GPT sticky units, interstitials, sponsored modals).
 * Complements cookie consent — runs when the page is locked behind non-consent overlays.
 */
import { humanPause } from "../human.js";

/** Known close controls — tried before DOM scan candidates. */
const STRUCTURAL_DISMISS_SELECTORS = [
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
        if (/^close$/i.test(meta.text.trim()) || /^[×✕x]$/i.test(meta.text.trim())) score += 70;
        if (/close/i.test(meta.aria)) score += 65;
        if (/close/i.test(meta.className) && meta.area < 12000) score += 50;
        if (meta.fixed && score > 0) score += 25;
        if (meta.zIndex >= 1000 && score > 0) score += 20;

        const parentDialog = el.closest(
          "[role='dialog'], [aria-modal='true'], .modal, [class*='ui-modal' i], [class*='interstitial' i], .bb-sticky-box",
        );
        const parentText = (parentDialog?.innerText || "").slice(0, 600).toLowerCase().replace(/[\u2018\u2019]/g, "'");
        const adNearby = AD_CONTEXT.test(parentText) || AD_CONTEXT.test(blob) || meta.inAdFrame || meta.inStickyAd;
        if (adNearby && score > 0) score += 40;

        // Generic interstitial: dialog with upsell/paywall copy + Skip / No thanks / etc.
        const dismissLabel =
          /^(skip|no[, ]?thanks|not now|maybe later|continue without|dismiss|no,? pass|i'?ll pass|skip (for )?now)$/i.test(
            meta.text.trim(),
          );
        const upsellBody =
          /auto-?rejected|won'?t reach a human|fix my resume|ats software will filter|quick wins|get more replies|upgrade|go premium|paywall|successful candidates score/i.test(
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

      const hasBlockingOverlay =
        bodyLocked ||
        stickyContainers.length > 0 ||
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
    /resume-review-upsell/i.test(candidate.testId || "") ||
    /^skip$/i.test((candidate.text || "").trim());

  if (isUpsellSkip) {
    attempts.push(async () => {
      const modal = page.locator(
        '[data-testid="ui-modal-resume-builder-check"], .ui-modal--resume-builder-check, [role="dialog"][aria-modal="true"]',
      );
      const scoped = modal.getByRole("button", { name: /^Skip$/i }).first();
      if (await scoped.isVisible({ timeout: 800 }).catch(() => false)) {
        await scoped.click({ timeout: 6000 });
        log?.layer(layer, 'dismiss: resume review upsell — skip "Skip"', "info");
        return true;
      }
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
 * Dismiss a blocking interstitial/upsell dialog by its secondary action
 * (Skip, No thanks, Not now, …) — works on any site from dialog text, not CSS ids.
 */
export async function dismissInterstitialDialog(page, log, layer = "page_prep") {
  try {
    const dialogs = page.locator(
      '[role="dialog"][aria-modal="true"], [aria-modal="true"], [class*="ui-modal"]',
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
      const body = ((await dialog.innerText().catch(() => "")) || "")
        .replace(/[\u2018\u2019']/g, "'")
        .toLowerCase();
      const looksUpsell =
        /auto-?rejected|won't reach a human|fix my resume|ats software will filter|quick wins|get more replies|upgrade|premium|paywall|successful candidates score/i.test(
          body,
        );
      if (!looksUpsell && !locked) continue;

      const patterns = [/^Skip$/i, /^No[, ]?thanks$/i, /^Not now$/i, /^Maybe later$/i, /^Dismiss$/i];
      for (const pattern of patterns) {
        const btn = dialog.getByRole("button", { name: pattern }).first();
        if (!(await btn.isVisible({ timeout: 250 }).catch(() => false))) continue;
        await btn.click({ timeout: 6000 });
        await humanPause(700, 1400);
        log?.layer(layer, `dismiss: interstitial — "${pattern.source}"`, "info");
        return true;
      }
    }
  } catch (exc) {
    log?.layer(layer, `dismiss: interstitial failed (${exc.message})`, "debug");
  }
  return false;
}

/** @deprecated alias */
export async function dismissResumeReviewUpsell(page, log, layer = "page_prep") {
  return dismissInterstitialDialog(page, log, layer);
}

/** Dismiss blocking ad overlays. Returns true if any dismiss action succeeded. */
export async function dismissBlockingOverlays(page, log, layer = "page_prep", snap = null) {
  if (await dismissInterstitialDialog(page, log, layer)) return true;

  const overlay =
    snap?.dismissCandidates != null
      ? {
          hasBlockingOverlay: snap.hasBlockingOverlay,
          dismissCandidates: snap.dismissCandidates,
          overlayHints: snap.overlayHints,
        }
      : await scanBlockingOverlays(page);

  if (!overlay.hasBlockingOverlay && !(overlay.dismissCandidates || []).length) {
    return clickStructuralDismiss(page, log, layer);
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

  log?.layer(layer, "dismiss: overlay detected but no close control worked", "debug");
  return false;
}
