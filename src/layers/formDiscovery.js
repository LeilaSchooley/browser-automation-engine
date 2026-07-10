/**
 * Dynamic DOM inspection — walks light DOM + shadow roots, scores interactive
 * elements, returns click targets. No site-specific selectors in this layer.
 */

const APPLY_TEXT = /\b(apply|interested|easy apply|quick apply|start application|submit application)\b/i;
/** Strict — avoid matching "Next.js" in job descriptions via bare \bnext\b */
const CONTINUE_TEXT = /\b(continue|proceed|save and continue|sign up with email|continue with email|next step)\b/i;
const MODAL_STEP_TEXT =
  /\b(I have a resume|I need a resume|upload resume|use my resume|select file|choose file|sign up with email|continue with email|get started)\b/i;
const SUBMIT_TEXT = /\b(submit|send application|apply now|complete application)\b/i;
const COOKIE_TEXT =
  /\b(accept all cookies|accept cookies|accept all|allow all|allow cookies|agree|got it)\b/i;

const INTERACTIVE_SEL =
  "button, a[href], [role='button'], [role='link'], input[type='submit'], [data-testid], [data-test], [class*='cursor-pointer' i]";

function emptySnap(page, error = "") {
  return {
    url: page.url?.() || "",
    title: "",
    hostname: "",
    fieldCount: 0,
    fields: [],
    hasForm: false,
    pageKind: "unknown",
    cookieBanner: false,
    cookieCandidates: [],
    entryCount: 0,
    entryCandidates: [],
    continueCount: 0,
    continueCandidates: [],
    submitCount: 0,
    submitCandidates: [],
    fileInputCount: 0,
    fileInputCandidates: [],
    modalCount: 0,
    hasApplyModal: false,
    applyModalTitle: "",
    modalCandidates: [],
    modalStepCount: 0,
    bodyTextLength: 0,
    error,
  };
}

/** Score apply-entry controls — higher = more likely primary CTA on a job listing. */
export function scoreEntryCandidate(meta) {
  let score = 0;
  const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();

  if (/interested/i.test(blob)) score += 95;
  if (/easy apply|quick apply|1-click apply/i.test(blob)) score += 88;
  if (/apply now|start application|submit application/i.test(blob)) score += 82;
  if (/\bapply\b/i.test(meta.text)) score += 55;
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

  return score;
}

function scoreCookieCandidate(meta) {
  let score = 0;
  const blob = `${meta.text} ${meta.aria} ${meta.testId}`.toLowerCase();
  if (!COOKIE_TEXT.test(blob) && !/#onetrust|cookie|consent/i.test(meta.testId || "")) return 0;
  if (COOKIE_TEXT.test(blob)) score += 80;
  if (/accept all|allow all/i.test(blob)) score += 70;
  if (meta.inCookieDialog) score += 30;
  if (meta.tag === "button") score += 15;
  if (meta.inApplyModal) score -= 100;
  return score;
}

function scoreActionCandidate(meta, pattern) {
  let score = 0;
  const blob = `${meta.text} ${meta.testId} ${meta.aria}`;
  if (pattern.test(blob)) score += 60;
  if (pattern.test(meta.testId || "")) score += 30;
  if (meta.tag === "button") score += 10;
  return score;
}

function buildSelector(meta) {
  if (meta.testId) return `[data-testid="${meta.testId.replace(/"/g, '\\"')}"]`;
  if (meta.id && meta.idUnique) return `#${meta.id.replace(/ /g, "\\ ")}`;
  return "";
}

function mergeCandidates(list, minScore = 25) {
  const seen = new Set();
  const out = [];
  for (const c of list || []) {
    if ((c.score || 0) < minScore) continue;
    const key = `${c.testId || ""}:${(c.text || "").slice(0, 50)}:${c.selector || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 10);
}

function recomputePageKind(snap) {
  if ((snap.fieldCount || 0) >= 2) snap.pageKind = "form";
  else if (snap.hasApplyModal || (snap.modalStepCount || 0) > 0) snap.pageKind = "modal";
  else if ((snap.entryCount || 0) > 0) snap.pageKind = "listing";
  else if (snap.cookieBanner) snap.pageKind = "consent";
  else if ((snap.bodyTextLength || 0) > 400) snap.pageKind = "content";
  else if (!snap.pageKind) snap.pageKind = "unknown";
  return snap;
}

async function scanDom(page) {
  return page.evaluate(
    ({
      applyPatternSource,
      continuePatternSource,
      modalStepPatternSource,
      submitPatternSource,
      cookiePatternSource,
      interactiveSel,
    }) => {
      const applyPattern = new RegExp(applyPatternSource, "i");
      const continuePattern = new RegExp(continuePatternSource, "i");
      const modalStepPattern = new RegExp(modalStepPatternSource, "i");
      const submitPattern = new RegExp(submitPatternSource, "i");
      const cookiePattern = new RegExp(cookiePatternSource, "i");

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
          /* invalid selector in some roots */
        }
        root.querySelectorAll("*").forEach((host) => {
          if (host.shadowRoot) out.push(...queryDeep(selector, host.shadowRoot));
        });
        return out;
      }

      function elementMeta(el) {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || el.value || "").replace(/\s+/g, " ").trim();
        const testId = el.getAttribute("data-testid") || el.getAttribute("data-test") || "";
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
        return {
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role") || "",
          text: text.slice(0, 100),
          testId: testId.slice(0, 80),
          aria: aria.slice(0, 80),
          href: (el.getAttribute("href") || "").slice(0, 120),
          id,
          idUnique,
          inNav: !!el.closest("header, nav, [role='navigation']"),
          inFooter: !!el.closest("footer, [role='contentinfo']"),
          inMainContent: !!el.closest("main, [role='main'], article, [class*='job' i], [id*='job' i]"),
          inJobContext: !!el.closest(
            "[class*='job' i], [id*='job' i], [data-testid*='job' i], [class*='listing' i], [class*='preview' i]",
          ),
          inDialog: !!el.closest("[role='dialog'], [aria-modal='true'], .modal, [class*='cookie' i], [id*='cookie' i]"),
          inCookieDialog: !!el.closest(
            "#onetrust-banner-sdk, #onetrust-consent-sdk, [id*='cookie' i][role='dialog'], [class*='cookie' i][role='dialog']",
          ),
          inApplyModal: false,
          clickable: el.tagName === "BUTTON" || el.getAttribute("role") === "button" || /cursor-pointer/i.test(el.className || ""),
          area: Math.round(r.width * r.height),
          top: Math.round(r.top),
        };
      }

      function getApplyModalRoots() {
        const roots = queryDeep(
          "[role='dialog'][aria-modal='true'], .ui-modal, [data-testid*='modal' i], [data-testid^='umja-'], [data-testid*='option-upload' i]",
        ).filter((el) => {
          if (!isVisibleEl(el)) return false;
          const t = (el.innerText || el.textContent || "").slice(0, 700).toLowerCase();
          const testId = (el.getAttribute("data-testid") || "").toLowerCase();
          if (/onetrust|cookie consent|accept all cookies/i.test(t) && !/application|resume/i.test(t)) {
            return false;
          }
          if (/umja-|option-upload|upload-resume/i.test(testId)) return true;
          return /application|resume|upload|sign up|get started|interested|apply|start your/i.test(t);
        });
        // Prefer outer dialog containers over inner option cards
        return roots.filter((el) => !roots.some((other) => other !== el && other.contains(el)));
      }

      function markApplyModalElements(applyModals) {
        for (const modal of applyModals) {
          modal.querySelectorAll("*").forEach((el) => {
            if (!el.__inApplyModal) el.__inApplyModal = true;
          });
          if (modal.shadowRoot) {
            modal.shadowRoot.querySelectorAll("*").forEach((el) => {
              el.__inApplyModal = true;
            });
          }
        }
      }

      function elementMetaWithModal(el, applyModals) {
        const meta = elementMeta(el);
        meta.inApplyModal = !!el.__inApplyModal || applyModals.some((m) => m.contains(el));
        return meta;
      }

      function isJobDescriptionNoise(meta, blob) {
        if ((meta.text || "").length > 90) return true;
        if (/qualification|benefit|description|summary|responsibilit|requirement|about the job|experience with/i.test(blob)) {
          return true;
        }
        if (/job-card-|description|content-block|qualification|benefit|summary/i.test(meta.testId || "")) return true;
        return false;
      }

      function isContinueAction(meta, blob) {
        if (isJobDescriptionNoise(meta, blob)) return false;
        if (meta.inApplyModal) return false;
        const text = (meta.text || "").trim();
        if (/^next$/i.test(text) || /^continue$/i.test(text) || /^proceed$/i.test(text)) return true;
        if (continuePattern.test(text)) return true;
        if (/continue|next-step|proceed/i.test(meta.testId || "")) return true;
        return false;
      }

      function scoreModalStep(meta, blob, hasFileUploadInModal) {
        if (!meta.inApplyModal) return 0;
        const text = (meta.text || "").trim();
        if (
          hasFileUploadInModal &&
          meta.tag === "button" &&
          /\b(upload|choose file|select file|browse)\b/i.test(text)
        ) {
          return 0;
        }
        let score = 0;
        if (/I have a resume|option-upload/i.test(blob)) score += 130;
        if (/sign up with email|continue with email/i.test(blob)) score += 100;
        if (/I need a resume|create resume/i.test(blob)) score += 55;
        if (modalStepPattern.test(blob)) score += 70;
        if (meta.clickable || meta.tag === "button" || meta.role === "button") score += 20;
        if ((meta.text || "").length > 90) score -= 50;
        if (/close dialog|^x$/i.test(meta.aria || meta.text)) score -= 80;
        return score;
      }

      function scoreContinueAction(meta, blob) {
        if (!isContinueAction(meta, blob)) return 0;
        let score = 40;
        if (/^continue$/i.test((meta.text || "").trim())) score += 50;
        if (/^next$/i.test((meta.text || "").trim())) score += 45;
        if (/sign up with email|continue with email/i.test(blob)) score += 60;
        if (meta.tag === "button" || meta.role === "button") score += 15;
        if (meta.inApplyModal) score += 40;
        return score;
      }

      function buildSelector(meta) {
        if (meta.testId) return `[data-testid="${meta.testId.replace(/"/g, '\\"')}"]`;
        if (meta.id && meta.idUnique) return `#${meta.id.replace(/ /g, "\\ ")}`;
        return "";
      }

      function scoreEntry(meta) {
        let score = 0;
        const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();
        if (/interested/i.test(blob)) score += 95;
        if (/easy apply|quick apply|1-click apply/i.test(blob)) score += 88;
        if (/apply now|start application|submit application/i.test(blob)) score += 82;
        if (/\bapply\b/i.test(meta.text)) score += 55;
        if (/apply|interested/i.test(meta.testId || "")) score += 45;
        if (meta.inMainContent) score += 25;
        if (meta.inJobContext) score += 20;
        if (meta.inNav) score -= 50;
        if (meta.inFooter) score -= 15;
        if (meta.tag === "button" || meta.role === "button") score += 18;
        if (meta.tag === "a" && /apply|interested/i.test(blob)) score += 10;
        if (meta.area < 800) score -= 25;
        if (/sign in|log in|register|search jobs|save job|share/i.test(blob)) score -= 60;
        return score;
      }

      function scoreCookie(meta) {
        let score = 0;
        const blob = `${meta.text} ${meta.aria} ${meta.testId}`.toLowerCase();
        if (!cookiePattern.test(blob) && !/#onetrust|cookie|consent/i.test(meta.testId || "")) return 0;
        if (cookiePattern.test(blob)) score += 80;
        if (/accept all|allow all/i.test(blob)) score += 70;
        if (meta.inCookieDialog) score += 30;
        if (meta.tag === "button") score += 15;
        if (meta.inApplyModal) score -= 100;
        return score;
      }

      function toCandidate(el, score, kind, metaOverride = null) {
        const meta = metaOverride || elementMeta(el);
        return {
          kind,
          tag: meta.tag,
          text: meta.text.slice(0, 80) || meta.testId || meta.aria,
          testId: meta.testId,
          aria: meta.aria,
          selector: buildSelector(meta),
          score,
          inApplyModal: !!meta.inApplyModal,
          source: "dom",
        };
      }

      const applyModals = getApplyModalRoots();
      markApplyModalElements(applyModals);
      const applyModalTitle =
        applyModals[0]?.querySelector("h1, h2, h3, [id*='modal-title' i], [class*='title' i]")?.innerText?.trim()?.slice(0, 80) ||
        applyModals[0]?.getAttribute("aria-label")?.slice(0, 80) ||
        "";

      const fileInputEls = queryDeep('input[type="file"]').filter((el) => !el.disabled);
      const hasFileUploadInModal =
        fileInputEls.some((el) => applyModals.some((m) => m.contains(el) || el.__inApplyModal)) ||
        (applyModals.length > 0 && fileInputEls.length > 0);
      const fileInputCandidates = fileInputEls.slice(0, 6).map((el) => {
        const meta = elementMetaWithModal(el, applyModals);
        return {
          testId: meta.testId,
          aria: meta.aria,
          selector: meta.testId ? `[data-testid="${meta.testId}"]` : 'input[type="file"]',
          inApplyModal: meta.inApplyModal,
          score: meta.inApplyModal ? 120 : 60,
        };
      });

      const fieldEls = queryDeep(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
      ).filter(isVisibleEl);

      const fields = fieldEls.slice(0, 16).map((el) => {
        const meta = elementMetaWithModal(el, applyModals);
        return {
          type: el.type || el.tagName.toLowerCase(),
          label: (
            el.labels?.[0]?.innerText?.trim() ||
            el.getAttribute("aria-label") ||
            el.placeholder ||
            meta.text
          ).slice(0, 60),
          name: el.name || "",
          id: el.id || "",
        };
      });

      const interactive = queryDeep(interactiveSel).filter(isVisibleEl);
      const entryRaw = [];
      const cookieRaw = [];
      const continueRaw = [];
      const submitRaw = [];
      const modalRaw = [];

      for (const el of interactive) {
        const meta = elementMetaWithModal(el, applyModals);
        const blob = `${meta.text} ${meta.testId} ${meta.aria}`;

        if (meta.inApplyModal) {
          const modalScore = scoreModalStep(meta, blob, hasFileUploadInModal);
          if (modalScore >= 50) modalRaw.push(toCandidate(el, modalScore, "modal", meta));
          const contScore = scoreContinueAction(meta, blob);
          if (contScore >= 40) continueRaw.push(toCandidate(el, contScore, "continue", meta));
          continue;
        }

        const entryScore = scoreEntry(meta);
        const matchesApply = applyPattern.test(blob) || /apply|interested/i.test(meta.testId || "");
        if (matchesApply && entryScore >= 20 && !applyModals.length) {
          entryRaw.push(toCandidate(el, entryScore, "entry", meta));
        } else if (matchesApply && entryScore >= 20 && !meta.inNav) {
          entryRaw.push(toCandidate(el, entryScore - 30, "entry", meta));
        }

        const cookieScore = scoreCookie(meta);
        if (cookieScore >= 55) cookieRaw.push(toCandidate(el, cookieScore, "cookie", meta));

        const contScore = scoreContinueAction(meta, blob);
        if (contScore >= 40) continueRaw.push(toCandidate(el, contScore, "continue", meta));

        if (submitPattern.test(blob) || submitPattern.test(meta.testId || "")) {
          if (!isJobDescriptionNoise(meta, blob)) {
            submitRaw.push(toCandidate(el, scoreEntry(meta) + 20, "submit", meta));
          }
        }
      }

      function dedupeSort(raw, minScore) {
        const seen = new Set();
        const out = [];
        for (const c of raw.sort((a, b) => b.score - a.score)) {
          const key = `${c.testId}:${c.text.slice(0, 40)}`;
          if (seen.has(key) || c.score < minScore) continue;
          seen.add(key);
          out.push(c);
          if (out.length >= 8) break;
        }
        return out;
      }

      const modalCandidates = dedupeSort(modalRaw, 50);
      const entryCandidates = dedupeSort(entryRaw, 25);
      const cookieCandidates = dedupeSort(cookieRaw, 55);
      const continueCandidates = dedupeSort(continueRaw, 40);
      const submitCandidates = dedupeSort(submitRaw, 30);

      const cookieBanner =
        queryDeep(
          "#onetrust-banner-sdk, [id*='cookie' i][role='dialog'], [class*='cookie' i][role='dialog']",
        ).some(isVisibleEl) || cookieCandidates.some((c) => c.score >= 60);

      const modalCount = queryDeep("[role='dialog'], .modal, [aria-modal='true']").filter(isVisibleEl).length;
      const hasApplyModal = applyModals.length > 0 || modalCandidates.length > 0;

      const fileInputCount = fileInputEls.length;
      const bodyTextLength = (document.body?.innerText || "").replace(/\s+/g, " ").trim().length;

      let pageKind = "unknown";
      if (fieldEls.length >= 2) pageKind = "form";
      else if (hasApplyModal) pageKind = "modal";
      else if (entryCandidates.length > 0) pageKind = "listing";
      else if (cookieBanner) pageKind = "consent";
      else if (bodyTextLength > 400) pageKind = "content";

      return {
        url: location.href,
        title: document.title?.slice(0, 120) || "",
        hostname: location.hostname,
        fieldCount: fieldEls.length,
        fields,
        hasForm: fieldEls.length > 0,
        pageKind,
        cookieBanner: cookieBanner && !hasApplyModal,
        cookieCandidates,
        entryCount: entryCandidates.length,
        entryCandidates,
        continueCount: continueCandidates.length,
        continueCandidates,
        submitCount: submitCandidates.length,
        submitCandidates,
        fileInputCount,
        fileInputCandidates,
        modalCount,
        hasApplyModal,
        applyModalTitle,
        modalCandidates,
        modalStepCount: modalCandidates.length,
        bodyTextLength,
      };
    },
    {
      applyPatternSource: APPLY_TEXT.source,
      continuePatternSource: CONTINUE_TEXT.source,
      modalStepPatternSource: MODAL_STEP_TEXT.source,
      submitPatternSource: SUBMIT_TEXT.source,
      cookiePatternSource: COOKIE_TEXT.source,
      interactiveSel: INTERACTIVE_SEL,
    },
  );
}

/** Playwright enrichment when CDP/evaluate lag — still driven by discovered metadata. */
async function enrichFileInputs(page, snap) {
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

async function enrichModalSteps(page, snap) {
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

async function enrichViaPlaywright(page, snap) {
  const pwTitle = ((await page.title().catch(() => "")) || "").slice(0, 120);
  if (!snap.title?.trim() && pwTitle) snap.title = pwTitle;
  if (!snap.url) snap.url = page.url?.() || "";

  if (!snap.cookieBanner) {
    snap.cookieBanner = await page
      .locator("[role='dialog'], #onetrust-banner-sdk, [class*='cookie' i], [id*='cookie' i]")
      .first()
      .isVisible({ timeout: 300 })
      .catch(() => false);
  }

  await enrichFileInputs(page, snap);
  await enrichModalSteps(page, snap);

  if ((snap.entryCount || 0) === 0) {
    for (const pattern of [/interested/i, /apply now/i, /easy apply/i, /\bapply\b/i]) {
      for (const role of ["button", "link"]) {
        try {
          const loc = page.getByRole(role, { name: pattern }).first();
          if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) continue;
          const testId = ((await loc.getAttribute("data-testid").catch(() => "")) || "").trim();
          const text = ((await loc.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
          const meta = {
            tag: role,
            text,
            testId,
            aria: "",
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

export async function inspectPage(page) {
  let snap;
  try {
    snap = await scanDom(page);
  } catch (exc) {
    snap = emptySnap(page, exc.message);
  }
  return enrichViaPlaywright(page, snap);
}

export { applyAffordances } from "./applyStep.js";

export function logPageSnapshot(log, snap, layer = "inspect", classification = null) {
  const stepInfo = classification
    ? ` step=${classification.step} conf=${classification.confidence}`
    : "";
  log.layer(layer, `url=${snap.url}`);
  log.layer(
    layer,
    `title="${snap.title}" fields=${snap.fieldCount} kind=${snap.pageKind || "?"} body=${snap.bodyTextLength || 0}ch${stepInfo}`,
  );
  if (snap.inspectVia) log.layer(layer, `  inspect: ${snap.inspectVia} enrichment`, "info");
  if (snap.error) log.layer(layer, `  scan error: ${snap.error}`, "warn");
  if (snap.cookieBanner) log.layer(layer, "  cookie banner visible", "info");
  if (snap.cookieCandidates?.length) {
    for (const c of snap.cookieCandidates.slice(0, 3)) {
      log.layer(layer, `  cookie: "${c.text}" score=${c.score}`, "info");
    }
  }
  if (snap.entryCount) {
    for (const e of snap.entryCandidates || []) {
      const tid = e.testId ? ` testid=${e.testId}` : "";
      log.layer(layer, `  entry: <${e.tag}> "${e.text}" score=${e.score}${tid}`, "info");
    }
  }
  if (snap.hasApplyModal) {
    log.layer(layer, `  apply modal: "${snap.applyModalTitle || "open"}" (${snap.modalStepCount || 0} step(s))`, "info");
    for (const m of snap.modalCandidates || []) {
      log.layer(layer, `  modal: "${m.text}" score=${m.score}${m.testId ? ` testid=${m.testId}` : ""}`, "info");
    }
  }
  if (snap.modalCount && !snap.hasApplyModal) log.layer(layer, `  modals/overlays: ${snap.modalCount}`, "info");
  if (snap.continueCount) {
    for (const b of snap.continueCandidates || []) {
      log.layer(layer, `  continue: "${b.text}" score=${b.score}`, "info");
    }
  }
  if (snap.fileInputCount) {
    for (const f of snap.fileInputCandidates || []) {
      log.layer(layer, `  file input: ${f.selector}${f.testId ? ` testid=${f.testId}` : ""} score=${f.score}`, "info");
    }
  }
  for (const f of snap.fields || []) {
    log.layer(layer, `  field: ${f.type} "${f.label || f.name || f.id || "?"}"`);
  }
}

export function pageFingerprint(snap) {
  return [
    snap.pageKind,
    snap.fieldCount,
    snap.entryCount,
    snap.modalStepCount || 0,
    snap.fileInputCount || 0,
    snap.continueCount,
    snap.cookieBanner ? 1 : 0,
    snap.modalCandidates?.[0]?.text?.slice(0, 20) || "",
    snap.url?.split("?")[0]?.slice(-40),
  ].join("|");
}

export function progressScore(snap, fillResult) {
  const filled = fillResult?.filled?.length || 0;
  let score = filled * 10 + (snap.fieldCount || 0) * 2;
  if (snap.pageKind === "form") score += 15;
  if (snap.pageKind === "modal") score += 8;
  if (snap.fileInputCount) score += 5;
  if (snap.pageKind === "listing") score += 3;
  if (snap.entryCount) score += snap.entryCandidates[0]?.score || 0;
  return score;
}

export function looksLikeApplyForm(snap, minFields = 2) {
  return (snap.fieldCount || 0) >= minFields;
}

export function topEntryCandidate(snap) {
  return snap?.entryCandidates?.[0] || null;
}

export function topCookieCandidate(snap) {
  return snap?.cookieCandidates?.[0] || null;
}
