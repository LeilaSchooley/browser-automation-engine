/**
 * Playwright post-scan enrichers for form discovery snapshots.
 */
import { INTERSTITIAL_DISMISS_PATTERNS } from "../../heuristics.js";
import { STRUCTURAL_COOKIE_SELECTORS } from "../../patterns/index.js";
import { safeRoleLocator } from "../../primitives/safeLocator.js";
import { isNonCookiePopup } from "../../consentDetection.js";
import { scoreEntryCandidate } from "./candidateScoring.js";
import { mergeCandidates, recomputePageKind } from "./scanDom.js";

/** Playwright enrichment when CDP/evaluate lag — still driven by discovered metadata. */
export async function enrichFileInputs(page, snap) {
  const shouldScan =
    (snap.fileInputCount || 0) === 0 ||
    snap.hasApplyModal ||
    (snap.modalStepCount || 0) > 0;

  if (!shouldScan) return;

  try {
    const fileLoc = page.locator('input[type="file"]');
    const pwCount = await fileLoc.count();
    if (pwCount > 0) {
      const candidates = [];
      for (let i = 0; i < Math.min(pwCount, 8); i += 1) {
        const loc = fileLoc.nth(i);
        const testId = ((await loc.getAttribute("data-testid").catch(() => "")) || "").trim();
        const aria = ((await loc.getAttribute("aria-label").catch(() => "")) || "").trim();
        const id = ((await loc.getAttribute("id").catch(() => "")) || "").trim();
        let selector = 'input[type="file"]';
        if (testId) selector = `[data-testid="${testId}"]`;
        else if (id) selector = `#${id}`;
        candidates.push({
          testId,
          aria,
          selector,
          inApplyModal: snap.hasApplyModal,
          score: snap.hasApplyModal ? 120 : 60,
          source: "playwright-file",
        });
      }
      snap.fileInputCandidates = mergeCandidates([...(snap.fileInputCandidates || []), ...candidates], 0);
      snap.fileInputCount = snap.fileInputCandidates.length;
      snap.inspectVia = snap.inspectVia || "playwright-file";
    }
  } catch {
    /* ignore */
  }
}

export async function enrichModalSteps(page, snap) {
  if ((snap.modalStepCount || 0) > 0 && snap.hasApplyModal) return;

  try {
    const found = await page.evaluate(() => {
      function isVisibleEl(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      }

      const out = [];
      const wizardText =
        /have a resume|upload|get started|continue with email|sign up with email|use my resume|attach/i;
      const skipText = /need a resume|create resume|resume builder|close dialog/i;

      const dialogs = document.querySelectorAll("[role='dialog'], .ui-modal, [aria-modal='true']");
      const roots = dialogs.length ? [...dialogs] : [document.body];

      for (const root of roots) {
        const sel =
          '[data-testid*="option-upload" i], [data-testid*="upload-resume" i], [class*="cursor-pointer" i], button, [role="button"]';
        for (const el of root.querySelectorAll(sel)) {
          if (!isVisibleEl(el)) continue;
          const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
          if (text.length > 80) continue;
          const testId = el.getAttribute("data-testid") || "";
          const blob = `${text} ${testId}`.toLowerCase();
          if (!wizardText.test(blob)) continue;
          if (skipText.test(blob) && !/have a resume/i.test(blob)) continue;
          let score = 120;
          if (/have a resume|option-upload/i.test(blob)) score = 140;
          if (/continue with email|sign up with email|get started/i.test(blob)) score += 20;
          out.push({
            kind: "modal",
            tag: el.tagName.toLowerCase(),
            text: text.slice(0, 80) || testId,
            testId: testId.slice(0, 80),
            aria: (el.getAttribute("aria-label") || "").slice(0, 80),
            selector: testId ? `[data-testid="${testId.replace(/"/g, '\\"')}"]` : "",
            score,
            inApplyModal: true,
            source: "playwright-modal",
          });
        }
      }
      return out;
    });

    if (found?.length) {
      snap.modalCandidates = mergeCandidates([...(snap.modalCandidates || []), ...found], 50);
      snap.modalStepCount = snap.modalCandidates.length;
      snap.hasApplyModal = true;
      if (!snap.applyModalTitle) snap.applyModalTitle = "Start your application";
      snap.pageKind = snap.fieldCount >= 2 ? "form" : "modal";
      snap.inspectVia = snap.inspectVia || "playwright-modal";
    }
  } catch {
    /* ignore */
  }
}

export async function enrichResumeReviewUpsell(page, snap) {
  try {
    const hit = await page.evaluate(() => {
      function isVisibleEl(el) {
        if (!el) return false;
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      }

      function normalizeText(s) {
        return String(s || "")
          .replace(/[\u2018\u2019]/g, "'")
          .replace(/\s+/g, " ")
          .trim();
      }

      function queryDeep(selector, root = document) {
        const out = [];
        try {
          out.push(...root.querySelectorAll(selector));
        } catch {
          /* invalid selector */
        }
        let hosts;
        try {
          hosts = root.querySelectorAll("*");
        } catch {
          return out;
        }
        for (const host of hosts) {
          if (host.shadowRoot) out.push(...queryDeep(selector, host.shadowRoot));
          if (host.tagName === "IFRAME" || host.tagName === "FRAME") {
            try {
              const doc = host.contentDocument;
              if (doc) out.push(...queryDeep(selector, doc));
            } catch {
              /* cross-origin */
            }
          }
        }
        return out;
      }

      const dismissPatterns = [
        /^skip free expert review$/i,
        /skip\s+free\s+expert(\s+review)?/i,
        /^skip and continue$/i,
        /^skip & continue$/i,
        /skip\s*(and|&)\s*continue/i,
        /^skip to application$/i,
        /^skip to apply$/i,
        /^skip$/i,
        /^no[, ]?thanks$/i,
        /^not now$/i,
        /^maybe later$/i,
      ];

      function matchesDismiss(text) {
        const t = normalizeText(text);
        return dismissPatterns.some((p) => p.test(t));
      }

      const upsellPattern =
        /auto-?rejected|won'?t reach a human|ats software will filter|fix my resume|quick wins|successful candidates score|increase your chances|tailor your resume|get more replies|expert review|free expert review|resume score|not recommended|resume is not ready yet|not ready yet|upgrade|paywall/i;

      const visibleDialogs = queryDeep("[role='dialog'], .ui-modal, [aria-modal='true']").filter(isVisibleEl);
      const bodyHasExpertReview = visibleDialogs.some((el) =>
        /expert review|not ready yet|free expert/i.test(normalizeText(el.innerText || el.textContent || "")),
      );

      // Active apply wizard — not a marketing upsell (unless expert review gate is on top).
      const wizardRoot = visibleDialogs.find((el) => {
        const t = normalizeText(el.innerText || el.textContent || "");
        return /\bi have a resume\b|\bupload resume\b|\bcontinue with email\b|\bsign up with email\b/i.test(t);
      });
      if (wizardRoot && !bodyHasExpertReview) return null;

      const roots = [
        ...queryDeep("[role='dialog'], .modal, [aria-modal='true']"),
      ];
      const seen = new Set();

      for (const root of roots) {
        if (!root || seen.has(root) || !isVisibleEl(root)) continue;
        seen.add(root);

        const testId = (root.getAttribute("data-testid") || "").toLowerCase();
        const klass = (root.getAttribute("class") || "").toLowerCase();
        const body = normalizeText(root.innerText || root.textContent || "");
        const isKnownModal =
          /resume-builder|expert review|not ready yet|free expert|auto-?rejected|fix my resume/i.test(
            `${testId} ${klass} ${body}`,
          );
        if (!isKnownModal && !upsellPattern.test(body)) continue;

        const buttons = [
          ...root.querySelectorAll(
            "button, a, [role='button'], [class*='ds-button' i], [class*='cursor-pointer' i]",
          ),
        ].filter(isVisibleEl);
        let skipEl = buttons.find((el) => matchesDismiss(el.innerText || el.textContent));
        if (!skipEl) {
          skipEl = [...root.querySelectorAll("button, a, [role='button'], span, p, div")]
            .filter(isVisibleEl)
            .find((el) => matchesDismiss(el.innerText || el.textContent));
        }
        if (!skipEl) continue;

        const label = normalizeText(skipEl.innerText || skipEl.textContent || "Skip");
        return {
          skip: {
            kind: "dismiss",
            tag: skipEl.tagName.toLowerCase(),
            text: label,
            testId: "interstitial-dismiss",
            aria: (skipEl.getAttribute("aria-label") || "").slice(0, 80),
            selector: "",
            score: label.toLowerCase().includes("skip free expert")
              ? 320
              : label.toLowerCase().includes("skip and continue") || label.toLowerCase().includes("skip & continue")
              ? 310
              : label.toLowerCase().includes("skip to")
                ? 300
                : 280,
            source: "interstitial-dismiss",
          },
        };
      }
      return null;
    });

    let skip = hit?.skip || null;
    if (!skip) {
      const modal = page.locator('[role="dialog"][aria-modal="true"], [role="dialog"], .modal, [aria-modal="true"]');
      const modalCount = Math.min(await modal.count().catch(() => 0), 4);
      for (let i = 0; i < modalCount; i += 1) {
        const m = modal.nth(i);
        if (!(await m.isVisible({ timeout: 300 }).catch(() => false))) continue;
        for (const pattern of INTERSTITIAL_DISMISS_PATTERNS) {
          const skipBtn = m.getByRole("button", { name: pattern }).first();
          if (!(await skipBtn.isVisible({ timeout: 300 }).catch(() => false))) continue;
          const label = ((await skipBtn.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim() || "Skip";
          skip = {
            kind: "dismiss",
            tag: "button",
            text: label,
            testId: "interstitial-dismiss",
            aria: "",
            selector: "",
            score: 280,
            source: "interstitial-dismiss",
          };
          break;
        }
        if (skip) break;
      }
    }

    if (!skip) return;

    snap.hasBlockingOverlay = true;
    snap.cookieBanner = false;
    snap.overlayHints = [...new Set([...(snap.overlayHints || []), "interstitial-dismiss"])];
    snap.dismissCandidates = mergeCandidates([...(snap.dismissCandidates || []), skip], 20);
    if (!snap.modalCandidates?.some((c) => /option-upload|upload-resume|have a resume|ui-uploader|file.?input/i.test(`${c.testId || ""} ${c.text || ""}`))) {
      snap.hasApplyModal = false;
      snap.modalStepCount = 0;
      snap.applyModalTitle = "";
      snap.modalCandidates = (snap.modalCandidates || []).filter(
        (c) => !/resume-builder|auto-reject/i.test(`${c.testId || ""} ${c.text || ""}`),
      );
      if ((snap.fieldCount || 0) < 2 && (snap.entryCount || 0) > 0) snap.pageKind = "listing";
    }
  } catch {
    /* ignore */
  }
}

/** Infer real widget types for custom controls discovered as combobox-only. */
export async function enrichCustomControlWidgetTypes(page, snap) {
  if (!snap?.customControls?.length) return;
  for (const ctrl of snap.customControls) {
    if (!ctrl.selector) continue;
    try {
      const loc = page.locator(ctrl.selector).first();
      if (!(await loc.count())) continue;
      const tag = await loc.evaluate((el) => el.tagName?.toLowerCase() || "").catch(() => "");
      const role = await loc.getAttribute("role").catch(() => "");
      const autocomplete = await loc.getAttribute("aria-autocomplete").catch(() => "");
      const type = await loc.getAttribute("type").catch(() => "");
      if (tag === "select") ctrl.widgetType = "select";
      else if (type === "date" || type === "datetime-local") ctrl.widgetType = "date";
      else if (role === "radiogroup" || type === "radio") ctrl.widgetType = "radio";
      else if (autocomplete || role === "combobox") ctrl.widgetType = autocomplete ? "typeahead" : "combobox";
      else if (ctrl.mappedTo === "salary") {
        ctrl.widgetType = "combobox";
        ctrl.requiresConfirm = true;
      }
    } catch {
      /* ignore */
    }
  }
}

export async function enrichViaPlaywright(page, snap) {
  const pwTitle = ((await page.title().catch(() => "")) || "").slice(0, 120);
  if (!snap.title?.trim() && pwTitle) snap.title = pwTitle;
  if (!snap.url) snap.url = page.url?.() || "";

  if (!snap.cookieBanner) {
    snap.structuralCookieBanner = await page
      .locator(STRUCTURAL_COOKIE_SELECTORS)
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
    snap.cookieBanner = snap.structuralCookieBanner;
  } else if (snap.structuralCookieBanner === undefined) {
    snap.structuralCookieBanner = false;
  }

  if (isNonCookiePopup(snap)) {
    snap.cookieBanner = false;
    snap.structuralCookieBanner = false;
  }

  await enrichFileInputs(page, snap);
  await enrichModalSteps(page, snap);
  await enrichResumeReviewUpsell(page, snap);
  await enrichCustomControlWidgetTypes(page, snap);

  if ((snap.entryCount || 0) === 0) {
    // Anchored only — bare /\bapply\b/ was matching "Apply with Indeed" / "Apply with Apple" randomly.
    for (const pattern of [
      /^interested$/i,
      /^i'?m interested$/i,
      /^apply now$/i,
      /^easy apply$/i,
      /^quick apply$/i,
      /^apply$/i,
      /^apply for the job$/i,
      /^apply for this job$/i,
      /^apply to this job$/i,
      /^start application$/i,
      /^apply here$/i,
      /^apply today$/i,
    ]) {
      for (const role of ["button", "link"]) {
        try {
          const loc = safeRoleLocator(page, role, pattern).first();
          if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) continue;
          const testId = ((await loc.getAttribute("data-testid").catch(() => "")) || "").trim();
          const text = ((await loc.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
          const href = ((await loc.getAttribute("href").catch(() => "")) || "").trim();
          const meta = {
            tag: role,
            text,
            testId,
            aria: "",
            href: href.slice(0, 120),
            inNav: false,
            inJobContext: true,
            inMainContent: true,
          };
          snap.entryCandidates = mergeCandidates([
            ...(snap.entryCandidates || []),
            {
              kind: "entry",
              tag: role,
              text: text.slice(0, 80),
              testId,
              href: href.slice(0, 120),
              selector: testId ? `[data-testid="${testId}"]` : "",
              score: scoreEntryCandidate(meta),
              source: "playwright-role",
            },
          ]);
          snap.entryCount = snap.entryCandidates.length;
          snap.inspectVia = "playwright-role";
          break;
        } catch {
          /* next */
        }
      }
      if (snap.entryCount) break;
    }
  }

  return recomputePageKind(snap);
}
