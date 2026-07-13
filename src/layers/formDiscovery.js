/**
 * Dynamic DOM inspection — walks light DOM + shadow roots, scores interactive
 * elements, returns click targets. No site-specific selectors in this layer.
 */
import { getSettings } from "../runtime.js";
import { INTERSTITIAL_DISMISS_PATTERNS, isActiveApplyWizard, isBlockingInterstitial, pageFingerprintFromSnap } from "../heuristics.js";
import {
  APPLY_TEXT,
  CONTINUE_TEXT,
  COOKIE_BANNER_SELECTORS,
  COOKIE_TEXT,
  NON_COOKIE_POPUP_BODY,
  STRUCTURAL_COOKIE_SELECTORS,
  INTERACTIVE_SEL,
  LISTING_ENTRY_TEXT,
  LOGIN_WALL_TEXT,
  MODAL_STEP_TEXT,
  SIGNUP_FORM_TEXT,
  SUBMIT_PATH_RE,
  SUBMIT_TEXT,
  CONFIRM_TEXT,
  CONFIRM_TEXT_STRICT,
  USERNAME_FIELD_PATTERN_SOURCE,
} from "../patterns/index.js";
import { mergeOverlaySnap, scanBlockingOverlays } from "./adDismiss.js";
import { isNonCookiePopup } from "../consentDetection.js";
import { pageStateSummary } from "./pageState.js";
import { entryHrefScoreDelta } from "./applyUrlSafety.js";
import { browserPatternArgs } from "../primitives/browserControlPatterns.js";

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
    structuralCookieBanner: false,
    cookieCandidates: [],
    entryCount: 0,
    entryCandidates: [],
    continueCount: 0,
    continueCandidates: [],
    submitCount: 0,
    submitCandidates: [],
    fileInputCount: 0,
    fileInputCandidates: [],
    interactives: [],
    modalCount: 0,
    hasApplyModal: false,
    applyModalTitle: "",
    modalCandidates: [],
    modalStepCount: 0,
    bodyTextLength: 0,
    headings: "",
    pageText: "",
    passwordFieldCount: 0,
    emailFieldCount: 0,
    usernameFieldCount: 0,
    authForm: false,
    signupForm: false,
    signInCount: 0,
    signInCandidates: [],
    signUpCount: 0,
    signUpCandidates: [],
    confirmPasswordFieldCount: 0,
    newPasswordFieldCount: 0,
    customControls: [],
    customControlCount: 0,
    controlCount: 0,
    dialogStack: [],
    activeDialogIndex: -1,
    pickerOpen: false,
    confirmCount: 0,
    confirmCandidates: [],
    hasBlockingOverlay: false,
    bodyLocked: false,
    dismissCount: 0,
    dismissCandidates: [],
    overlayHints: [],
    error,
  };
}

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

  if (/apply to\b/i.test(blob)) score -= 100;
  if (/\bapply\b/i.test(text) && !/^submit$/i.test(text)) score -= 25;
  if (meta.tag === "a" || meta.role === "link") score += 15;
  if (meta.inMainContent) score += 10;
  if (/sign in|log in|login|comments|discuss|\bpast\b|\bnews\b/i.test(blob) && !/submit/i.test(blob)) {
    score -= 40;
  }
  return score;
}

/** Score apply-entry controls — higher = more likely primary CTA on a job listing. */
export function scoreEntryCandidate(meta) {
  let score = 0;
  const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();

  if (/interested/i.test(blob)) score += 95;
  if (/apply with autofill|autofill/i.test(blob)) {
    // Jobright Autofill depends on their Chrome extension — usually a dead end over CDP.
    score += 35;
  } else if (/easy apply|quick apply|1-click apply/i.test(blob)) {
    score += 98;
  }
  if (/apply now|start application/i.test(blob)) score += 82;
  if (/submit application/i.test(blob)) score -= 90;
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

  if (meta.tag === "input" && !meta.href) score -= 85;
  if (meta.tag === "input" && /apply for the job/i.test(blob)) score -= 60;

  score += entryHrefScoreDelta(meta, meta.pageHost || "", {
    hasNativeApplyButton: !!meta.hasNativeApplyButton,
  });

  return score;
}

function scoreCookieCandidate(meta, pageBlob = "") {
  let score = 0;
  const blob = `${meta.text} ${meta.aria} ${meta.testId}`.toLowerCase();
  const textOnly = (meta.text || "").trim();
  if (NON_COOKIE_POPUP_BODY.test(pageBlob) || NON_COOKIE_POPUP_BODY.test(blob)) return 0;
  if (!COOKIE_TEXT.test(blob) && !/#onetrust|cookie|consent|fc-consent/i.test(meta.testId || "")) {
    if (!/^consent$/i.test(textOnly)) return 0;
  }
  if (COOKIE_TEXT.test(blob) || /^consent$/i.test(textOnly)) score += 80;
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
  const passwords = snap.passwordFieldCount || 0;
  const emails = snap.emailFieldCount || 0;
  const usernames = snap.usernameFieldCount || 0;
  snap.authForm = passwords > 0 && (emails > 0 || usernames > 0);
  const blob = `${snap.title || ""} ${snap.applyModalTitle || ""} ${snap.url || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  snap.signupForm =
    snap.authForm &&
    ((snap.confirmPasswordFieldCount || 0) > 0 ||
      (snap.newPasswordFieldCount || 0) > 0 ||
      SIGNUP_FORM_TEXT.test(blob) ||
      ((snap.signUpCount || 0) > 0 && (snap.signInCount || 0) === 0) ||
      (usernames > 0 && passwords >= 2) ||
      (usernames > 0 && passwords >= 1 && (SIGNUP_FORM_TEXT.test(blob) || LOGIN_WALL_TEXT.test(blob))));
  if (snap.signupForm) snap.pageKind = "auth";
  else if (snap.authForm) snap.pageKind = "auth";
  else if ((snap.fieldCount || 0) >= 2) snap.pageKind = "form";
  else if (snap.hasApplyModal || (snap.modalStepCount || 0) > 0) snap.pageKind = "modal";
  else if ((snap.entryCount || 0) > 0) snap.pageKind = "listing";
  else if (snap.cookieBanner) snap.pageKind = "consent";
  else if ((snap.bodyTextLength || 0) > 400) snap.pageKind = "content";
  else if (!snap.pageKind) snap.pageKind = "unknown";
  return snap;
}

async function scanDom(page, { listingMode = true } = {}) {
  return page.evaluate(
    ({
      applyPatternSource,
      listingPatternSource,
      continuePatternSource,
      modalStepPatternSource,
      submitPatternSource,
      confirmPatternSource,
      confirmStrictSource,
      cookiePatternSource,
      usernameFieldPatternSource,
      cookieBannerSel,
      structuralCookieSel,
      nonCookiePopupPatternSource,
      submitPathPatternSource,
      interactiveSel,
      listingMode,
      labelRules,
      applicationLabelRules,
      placeholderPatternSource,
      placeholderPatternFlags,
    }) => {
      const applyPattern = new RegExp(applyPatternSource, "i");
      const listingPattern = new RegExp(listingPatternSource, "i");
      const continuePattern = new RegExp(continuePatternSource, "i");
      const modalStepPattern = new RegExp(modalStepPatternSource, "i");
      const submitPattern = new RegExp(submitPatternSource, "i");
      const confirmPattern = new RegExp(confirmPatternSource, "i");
      const confirmStrict = new RegExp(confirmStrictSource, "i");
      const cookiePattern = new RegExp(cookiePatternSource, "i");
      const nonCookiePopupPattern = new RegExp(nonCookiePopupPatternSource, "i");
      const usernameFieldPattern = new RegExp(usernameFieldPatternSource, "i");
      const submitPathPattern = new RegExp(submitPathPatternSource, "i");
      const placeholderRe = new RegExp(placeholderPatternSource, placeholderPatternFlags || "i");

      function nearbyFieldLabel(el) {
        const prev = el.previousElementSibling;
        if (prev?.tagName === "LABEL") return (prev.textContent || "").trim();
        const lbl = el.closest("label");
        if (lbl) return (lbl.textContent || "").trim();
        const id = el.id;
        if (id) {
          const forLbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
          if (forLbl) return (forLbl.textContent || "").trim();
        }
        let sib = el.previousElementSibling;
        while (sib) {
          if (sib.tagName === "LABEL") return (sib.textContent || "").trim();
          sib = sib.previousElementSibling;
        }
        return "";
      }
      function mapComboboxLabel(label) {
        const blob = (label || "").toLowerCase();
        for (const rule of labelRules || []) {
          if (new RegExp(rule.pattern, rule.flags || "i").test(blob)) {
            return { mappedTo: rule.mappedTo, type: rule.type };
          }
        }
        return { mappedTo: "custom", type: "custom" };
      }
      function mapApplicationLabel(label) {
        const blob = (label || "").toLowerCase();
        for (const rule of applicationLabelRules || []) {
          if (new RegExp(rule.pattern, rule.flags || "i").test(blob)) {
            return { mappedTo: rule.mappedTo, type: rule.type };
          }
        }
        return null;
      }
      function buttonLooksSelected(btn) {
        if (btn.getAttribute("aria-pressed") === "true") return true;
        if (btn.getAttribute("aria-checked") === "true") return true;
        const cls = btn.className || "";
        return /selected|active|pressed|checked/i.test(cls);
      }
      function discoverApplicationControls() {
        const out = [];
        const visited = new Set();
        const roots = queryDeep(
          '[class*="ashby-application-form-field-entry"], fieldset, [class*="yesno" i], [data-field-id], [class*="application-form"] label, form',
        );
        for (const root of roots) {
          if (!isVisibleEl(root) || visited.has(root)) continue;
          const questionEl =
            root.querySelector('[class*="question-title"]') ||
            root.querySelector("legend") ||
            root.querySelector("label");
          let label = (questionEl?.textContent || "").replace(/\s+/g, " ").trim();
          const yesnoEl = root.matches('[class*="yesno" i]')
            ? root
            : root.querySelector('[class*="yesno" i]');
          if (!label && yesnoEl) {
            const parent = yesnoEl.closest('[class*="field-entry"], fieldset, form');
            const parentQ = parent?.querySelector('[class*="question-title"], legend, label');
            label = (parentQ?.textContent || "").replace(/\s+/g, " ").trim();
          }
          if (!label || label.length < 4) continue;

          const mapping = mapApplicationLabel(label);
          if (yesnoEl) {
            const buttons = [...yesnoEl.querySelectorAll("button, [role='button']")].filter(isVisibleEl);
            const texts = buttons.map((b) => (b.textContent || "").trim().toLowerCase());
            if (texts.includes("yes") && texts.includes("no")) {
              visited.add(root);
              const filled = buttons.some(buttonLooksSelected);
              const meta = elementMetaWithModal(yesnoEl, applyModals);
              out.push({
                label: label.slice(0, 120),
                mappedTo: mapping?.mappedTo || "visasponsorship",
                type: mapping?.type || "visasponsorship",
                widgetType: "yesno",
                text: "",
                selector: elementSelector(yesnoEl, meta),
                triggerSelector: elementSelector(yesnoEl, meta),
                questionLabel: label.slice(0, 120),
                top: meta.top,
                left: Math.round(yesnoEl.getBoundingClientRect().left),
                filled,
                inModal: meta.inApplyModal || meta.inDialog,
              });
              continue;
            }
          }

          const radios = [...root.querySelectorAll("input[type='radio'], [role='radio']")].filter(isVisibleEl);
          if (radios.length >= 2 && mapping) {
            visited.add(root);
            const filled = radios.some((r) => r.checked || r.getAttribute("aria-checked") === "true");
            const meta = elementMetaWithModal(root, applyModals);
            out.push({
              label: label.slice(0, 120),
              mappedTo: mapping.mappedTo,
              type: mapping.type,
              widgetType: "radio",
              text: "",
              selector: elementSelector(root, meta),
              triggerSelector: elementSelector(root, meta),
              questionLabel: label.slice(0, 120),
              top: meta.top,
              left: Math.round(root.getBoundingClientRect().left),
              filled,
              inModal: meta.inApplyModal || meta.inDialog,
            });
            continue;
          }

          // Greenhouse-style EEOC / compliance <select>s.
          const selects = [...root.querySelectorAll("select")].filter(isVisibleEl);
          for (const sel of selects) {
            if (visited.has(sel)) continue;
            const selLabel =
              label ||
              (sel.getAttribute("aria-label") || "").trim() ||
              nearbyFieldLabel(sel) ||
              "";
            const selMap = mapApplicationLabel(selLabel);
            if (!selMap) continue;
            const opts = [...sel.options].map((o) => (o.textContent || "").trim().toLowerCase());
            const looksCompliance =
              opts.some((o) => /decline|prefer not|do not wish|i do not want|n\/a|male|female|veteran|disabilit/.test(o)) ||
              ["eeocgender", "eeocrace", "eeocveteran", "eeocdisability"].includes(selMap.mappedTo);
            if (!looksCompliance && !["visasponsorship", "workauthorization"].includes(selMap.mappedTo)) continue;
            visited.add(sel);
            const meta = elementMetaWithModal(sel, applyModals);
            out.push({
              label: selLabel.slice(0, 120),
              mappedTo: selMap.mappedTo,
              type: selMap.type,
              widgetType: "select",
              text: "",
              selector: elementSelector(sel, meta),
              triggerSelector: elementSelector(sel, meta),
              questionLabel: selLabel.slice(0, 120),
              top: meta.top,
              left: Math.round(sel.getBoundingClientRect().left),
              filled: Boolean(sel.value && sel.value !== "" && sel.selectedIndex > 0),
              inModal: meta.inApplyModal || meta.inDialog,
            });
          }
        }

        // Also scan top-level selects with EEOC-ish options (Greenhouse bare forms).
        for (const sel of queryDeep("select")) {
          if (!isVisibleEl(sel) || visited.has(sel)) continue;
          const selLabel =
            (sel.getAttribute("aria-label") || "").trim() ||
            nearbyFieldLabel(sel) ||
            "";
          const selMap = mapApplicationLabel(selLabel);
          if (!selMap) continue;
          visited.add(sel);
          const meta = elementMetaWithModal(sel, applyModals);
          out.push({
            label: selLabel.slice(0, 120),
            mappedTo: selMap.mappedTo,
            type: selMap.type,
            widgetType: "select",
            text: "",
            selector: elementSelector(sel, meta),
            triggerSelector: elementSelector(sel, meta),
            questionLabel: selLabel.slice(0, 120),
            top: meta.top,
            left: Math.round(sel.getBoundingClientRect().left),
            filled: Boolean(sel.value && sel.value !== "" && sel.selectedIndex > 0),
            inModal: meta.inApplyModal || meta.inDialog,
          });
        }
        return out;
      }

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
          className: String(el.className || "").slice(0, 120),
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
          inCookieDialog: !!el.closest(cookieBannerSel),
          inApplyModal: false,
          clickable: el.tagName === "BUTTON" || el.getAttribute("role") === "button" || /cursor-pointer/i.test(el.className || ""),
          area: Math.round(r.width * r.height),
          top: Math.round(r.top),
          inTopBar: r.top >= 0 && r.top < 72,
          inBottomChrome: r.top > (window.innerHeight || 800) * 0.55,
        };
      }

      function getApplyModalRoots() {
        const roots = queryDeep(
          "[role='dialog'][aria-modal='true'], [role='dialog'], .modal, [aria-modal='true'], [data-testid*='modal' i], [data-testid*='option-upload' i], [data-testid*='upload-resume' i]",
        ).filter((el) => {
          if (!isVisibleEl(el)) return false;
          const t = (el.innerText || el.textContent || "").slice(0, 700).toLowerCase();
          const testId = (el.getAttribute("data-testid") || "").toLowerCase();
          if (/onetrust|cookie consent|accept all cookies/i.test(t) && !/application|resume/i.test(t)) {
            return false;
          }
          if (/resume-builder-check|auto-?rejected|won[\u2019']?t reach a human|fix my resume in minutes|expert review|not ready yet/i.test(`${t} ${testId}`)) {
            return false;
          }
          if (/option-upload|upload-resume|have.?a.?resume/i.test(`${testId} ${t}`)) return true;
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
        const text = (meta.text || "").trim();
        if (/confirm\s*&\s*see jobs|confirm and see jobs/i.test(text)) return true;
        if (meta.inApplyModal) {
          if (/^continue$/i.test(text) || /^next$/i.test(text) || /^proceed$/i.test(text)) return true;
          if (/sign up now|sign up for free|get started/i.test(blob)) return true;
          return false;
        }
        if (/^next$/i.test(text) || /^continue$/i.test(text) || /^proceed$/i.test(text)) return true;
        if (continuePattern.test(text)) return true;
        if (/continue|next-step|proceed/i.test(meta.testId || "")) return true;
        return false;
      }

      function scoreContinueAction(meta, blob) {
        if (!isContinueAction(meta, blob)) return 0;
        let score = 40;
        if (/confirm\s*&\s*see jobs|confirm and see jobs/i.test((meta.text || "").trim())) score += 80;
        if (/^continue$/i.test((meta.text || "").trim())) score += 50;
        if (/^next$/i.test((meta.text || "").trim())) score += 45;
        if (/sign up with email|continue with email/i.test(blob)) score += 60;
        if (meta.tag === "button" || meta.role === "button") score += 15;
        if (meta.inApplyModal || meta.inDialog) score += 40;
        return score;
      }

      function scoreConfirmAction(meta, blob) {
        if (!meta.inDialog && !meta.inApplyModal) return 0;
        const text = (meta.text || "").trim();
        if (!confirmPattern.test(blob) && !confirmPattern.test(text)) return 0;
        if (confirmStrict.test(text)) return 90;
        if (meta.tag === "button" || meta.role === "button") return 70;
        if (meta.clickable) return 65;
        return 50;
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

      function scoreSignInButton(meta) {
        const blob = `${meta.text} ${meta.testId} ${meta.aria}`.toLowerCase();
        if (
          !/\b(sign in with email|log in with email|sign in|log in|login|submit startup|already a member)\b/i.test(
            blob,
          ) &&
          !/\bsign in\b|\blog in\b/.test(blob)
        ) {
          return 0;
        }
        if (/\bsign in with (x|twitter|google|github)\b/.test(blob)) return 0;
        let score = 50;
        if (/sign in with email|log in with email/.test(blob)) score += 80;
        if (/sign in now|already a member/.test(blob)) score += 55;
        if (meta.tag === "button" || meta.role === "button" || meta.tag === "a") score += 20;
        if (/magic link/.test(blob)) score -= 30;
        return score;
      }

      function scoreSignUpButton(meta) {
        const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();
        if (!/\b(sign up|signup|create account|register|get started|join)\b/.test(blob)) return 0;
        if (/\bsign up with (x|twitter|google|github)\b/.test(blob) && !/email/.test(blob)) return 0;
        let score = 55;
        if (/sign up with email|create account/.test(blob)) score += 75;
        if (/^sign up$|create account|^register$/i.test((meta.text || "").trim())) score += 45;
        if (meta.tag === "a" && /signup|register|join/.test(meta.href || "")) score += 55;
        if (meta.tag === "button" || meta.role === "button") score += 20;
        if (/\bsign in\b|\blog in\b/.test(blob) && !/sign up/.test(blob)) score -= 40;
        return score;
      }

      function buildSelector(meta) {
        if (meta.testId) return `[data-testid="${meta.testId.replace(/"/g, '\\"')}"]`;
        if (meta.id && meta.idUnique) return `#${meta.id.replace(/ /g, "\\ ")}`;
        return "";
      }

      // Positional CSS path so every element is targetable even without id/testid.
      function cssPath(el) {
        const parts = [];
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 5) {
          if (node.id) {
            try {
              if (document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
                parts.unshift(`#${CSS.escape(node.id)}`);
                return parts.join(" > ");
              }
            } catch {
              /* ignore */
            }
          }
          let sel = node.tagName.toLowerCase();
          const parent = node.parentElement;
          if (parent) {
            const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
            if (same.length > 1) sel += `:nth-of-type(${same.indexOf(node) + 1})`;
          }
          parts.unshift(sel);
          node = parent;
          depth += 1;
        }
        return parts.join(" > ");
      }

      function elementSelector(el, meta) {
        return buildSelector(meta) || cssPath(el);
      }

      function scoreListingEntry(meta) {
        let score = 0;
        const text = (meta.text || "").trim();
        const blob = `${text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();
        const href = (meta.href || "").toLowerCase();
        const pageHost = (location.hostname || "").replace(/^www\./, "");

        if (/^submit$/i.test(text)) score += 130;
        if (listingPattern.test(blob)) score += 90;
        if (submitPathPattern.test(href)) score += 85;
        if ((meta.inNav || meta.inTopBar) && /submit|add|suggest|list/i.test(blob)) score += 70;
        if (meta.inFooter || meta.inBottomChrome) score -= 90;

        if (href) {
          try {
            const linkHost = new URL(href, location.origin).hostname.replace(/^www\./, "");
            if (linkHost && linkHost !== pageHost) score -= 120;
          } catch {
            /* ignore */
          }
        }

        if (/apply to\b/i.test(blob)) score -= 100;
        if (/\bapply\b/i.test(text) && !/^submit$/i.test(text)) score -= 25;
        if (meta.tag === "a" || meta.role === "link") score += 15;
        if (meta.inMainContent) score += 10;
        if (/sign in|log in|login|comments|discuss|\bpast\b|\bnews\b/i.test(blob) && !/submit/i.test(blob)) {
          score -= 40;
        }
        return score;
      }

      function scoreEntry(meta) {
        if (listingMode) return scoreListingEntry(meta);

        let score = 0;
        const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();
        if (/interested/i.test(blob)) score += 95;
        if (/apply with autofill|autofill/i.test(blob)) {
          // Jobright Autofill depends on their Chrome extension — usually a dead end over CDP.
          score += 35;
        } else if (/easy apply|quick apply|1-click apply/i.test(blob)) {
          score += 98;
        }
        if (/apply now|start application/i.test(blob)) score += 82;
        if (/submit application/i.test(blob)) score -= 90;
        if (/\bapply\b/i.test(meta.text)) score += 55;
        if (/apply|interested/i.test(meta.testId || "")) score += 45;
        if (meta.inMainContent) score += 25;
        if (meta.inJobContext) score += 20;
        if (meta.inNav) score -= 50;
        if (meta.inFooter) score -= 15;
        if (meta.tag === "button" || meta.role === "button") score += 18;
        if (meta.tag === "a" && /apply|interested/i.test(blob)) score += 10;
        if (meta.tag === "input" && !meta.href) score -= 85;
        if (meta.tag === "input" && /apply for the job/i.test(blob)) score -= 60;
        if (meta.area < 800) score -= 25;
        if (/sign in|log in|register|search jobs|save job|share/i.test(blob)) score -= 60;
        meta.pageHost = pageHost;
        meta.hasNativeApplyButton = hasNativeApplyButton;
        if (/custom-button/i.test(meta.className || "")) score -= 70;
        if (/btn-apply/i.test(meta.className || "")) score += 45;
        if (hasNativeApplyButton && /custom-button/i.test(meta.className || "")) score -= 100;
        if (meta.href) {
          try {
            const linkHost = new URL(meta.href, location.origin).hostname.replace(/^www\./, "");
            if (linkHost && linkHost !== pageHost) {
              score -= 40;
              if (/thetodayupdate|victorytuitions|remotezest|liveblog365/i.test(linkHost)) score -= 80;
              if (/liveblog365|000webhost|blogspot\.|wixsite\.com|weebly\.com|godaddysites|strikingly|tiiny\.site/i.test(linkHost)) {
                score -= 200;
              }
            }
          } catch {
            /* ignore */
          }
        }
        return score;
      }

      function scoreCookie(meta) {
        let score = 0;
        const blob = `${meta.text} ${meta.aria} ${meta.testId}`.toLowerCase();
        if (nonCookiePopupPattern.test(pageTextEarly) || nonCookiePopupPattern.test(blob)) return 0;
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
          href: meta.href || "",
          selector: buildSelector(meta),
          score,
          inApplyModal: !!meta.inApplyModal,
          source: "dom",
        };
      }

      const pageHost = (location.hostname || "").replace(/^www\./, "");
      const hasNativeApplyButton = !!document.querySelector(
        ".btn-apply, [class*='btn-apply-job'], a.btn-apply-job-internal-without-login, a.btn-apply-job-external",
      );

      const applyModals = getApplyModalRoots();
      markApplyModalElements(applyModals);
      const applyModalTitle =
        applyModals[0]?.querySelector("h1, h2, h3, [id*='modal-title' i], [class*='title' i], [class*='Title' i]")?.innerText?.trim()?.slice(0, 80) ||
        applyModals[0]?.getAttribute("aria-label")?.slice(0, 80) ||
        (() => {
          const blob = (applyModals[0]?.innerText || "").replace(/\s+/g, " ").trim();
          const m = blob.match(/did you apply\??/i);
          return m ? m[0] : "";
        })();

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

      function isSiteSearchField(el) {
        if ((el.type || "").toLowerCase() === "search") return true;
        if ((el.getAttribute("role") || "").toLowerCase() === "searchbox") return true;
        const blob = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.getAttribute("aria-label") || ""}`.toLowerCase();
        if (/\bsearch\b|\bquery\b/.test(blob)) return true;
        try {
          return !!el.closest("[role='search'], form[action*='search' i]");
        } catch {
          return false;
        }
      }

      const fieldEls = queryDeep(
        'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])',
      ).filter((el) => isVisibleEl(el) && !isSiteSearchField(el));

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
          selector: elementSelector(el, meta),
          required: el.required || el.getAttribute("aria-required") === "true",
          filled: !!(el.value && String(el.value).trim()),
        };
      });

      const passwordFieldCount = fieldEls.filter((el) => (el.type || "").toLowerCase() === "password").length;
      const emailFieldCount = fieldEls.filter((el) => {
        const t = (el.type || "").toLowerCase();
        const blob = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""}`.toLowerCase();
        return t === "email" || /email/.test(blob);
      }).length;
      const usernameFieldCount = fieldEls.filter((el) => {
        const t = (el.type || "").toLowerCase();
        if (t === "password" || t === "email" || t === "hidden" || t === "submit") return false;
        const blob = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.autocomplete || ""}`.toLowerCase();
        if (/email|password|pass|pwd|search|query|url|website|phone|tel/.test(blob)) return false;
        return usernameFieldPattern.test(blob) || (el.autocomplete || "").toLowerCase() === "username";
      }).length;
      const confirmPasswordFieldCount = fieldEls.filter((el) => {
        if ((el.type || "").toLowerCase() !== "password") return false;
        const blob = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${el.autocomplete || ""}`.toLowerCase();
        return /confirm|repeat|again|verify/.test(blob);
      }).length;
      const newPasswordFieldCount = fieldEls.filter((el) => {
        if ((el.type || "").toLowerCase() !== "password") return false;
        return (el.autocomplete || "").toLowerCase() === "new-password";
      }).length;

      const comboboxEls = queryDeep('[role="combobox"], [aria-haspopup="listbox"]').filter(isVisibleEl);
      const customControls = comboboxEls.slice(0, 12).map((el) => {
        const meta = elementMetaWithModal(el, applyModals);
        const ariaLabel = (el.getAttribute("aria-label") || meta.aria || "").trim();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const label = (ariaLabel || nearbyFieldLabel(el) || text.slice(0, 60) || "combobox").slice(0, 60);
        const mapping = mapComboboxLabel(label);
        const placeholderLike = placeholderRe.test(text);
        const filled = !!(text && !placeholderLike && text.length > 3);
        return {
          label,
          mappedTo: mapping.mappedTo,
          type: mapping.type,
          role: el.getAttribute("role") || "combobox",
          widgetType: "combobox",
          text: text.slice(0, 80),
          selector: elementSelector(el, meta),
          triggerSelector: elementSelector(el, meta),
          filled,
          inModal: meta.inApplyModal || meta.inDialog,
        };
      });
      for (const ac of discoverApplicationControls()) {
        if (!customControls.some((c) => c.mappedTo === ac.mappedTo && c.label === ac.label)) {
          customControls.push(ac);
        }
      }
      const customControlCount = customControls.filter((c) => !c.filled).length;

      for (const el of comboboxEls.slice(0, 8)) {
        if (fields.some((f) => f.id && el.id && f.id === el.id)) continue;
        const meta = elementMetaWithModal(el, applyModals);
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const label = (
          el.getAttribute("aria-label") ||
          nearbyFieldLabel(el) ||
          text ||
          "combobox"
        ).slice(0, 60);
        const placeholderLike = placeholderRe.test(text);
        fields.push({
          type: "combobox",
          widgetType: "combobox",
          label,
          name: el.name || "",
          id: el.id || "",
          selector: elementSelector(el, meta),
          required: el.getAttribute("aria-required") === "true",
          filled: !!(text && !placeholderLike && text.length > 1),
        });
      }
      const contentEditableEls = queryDeep('[contenteditable="true"]').filter(isVisibleEl);
      for (const el of contentEditableEls.slice(0, 6)) {
        const meta = elementMetaWithModal(el, applyModals);
        const label = (
          el.getAttribute("aria-label") ||
          nearbyFieldLabel(el) ||
          (el.innerText || "").trim().slice(0, 60) ||
          "contenteditable"
        ).slice(0, 60);
        fields.push({
          type: "contenteditable",
          widgetType: "contenteditable",
          label,
          name: "",
          id: el.id || "",
          selector: elementSelector(el, meta),
          required: false,
          filled: !!(el.innerText || "").trim(),
        });
      }
      if (fields.length > 24) fields.length = 24;

      const controlCountVal = fieldEls.length + comboboxEls.length;

      const pageTextEarly = (document.body?.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1400);

      const interactive = queryDeep(interactiveSel).filter(isVisibleEl);
      const entryRaw = [];
      const cookieRaw = [];
      const continueRaw = [];
      const submitRaw = [];
      const modalRaw = [];
      const confirmRaw = [];
      const signInRaw = [];
      const signUpRaw = [];

      for (const el of interactive) {
        const meta = elementMetaWithModal(el, applyModals);
        const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href}`;

        if (meta.inApplyModal) {
          const modalScore = scoreModalStep(meta, blob, hasFileUploadInModal);
          if (modalScore >= 50) modalRaw.push(toCandidate(el, modalScore, "modal", meta));
          const contScore = scoreContinueAction(meta, blob);
          if (contScore >= 40) continueRaw.push(toCandidate(el, contScore, "continue", meta));
          const confirmScore = scoreConfirmAction(meta, blob);
          if (confirmScore >= 50) confirmRaw.push(toCandidate(el, confirmScore, "confirm", meta));
          continue;
        }

        const entryScore = scoreEntry(meta);
        const matchesListing =
          listingPattern.test(blob) || submitPathPattern.test(meta.href || "");
        const matchesApply = listingMode
          ? matchesListing
          : applyPattern.test(blob) || /apply|interested/i.test(meta.testId || "");
        const onApplicationUrl = /\/application\b/i.test(location.href || "");
        const isFinalSubmit = /^submit\s+application$/i.test((meta.text || "").trim());
        if (matchesApply && entryScore >= 20 && !applyModals.length && !(onApplicationUrl && isFinalSubmit)) {
          entryRaw.push(toCandidate(el, entryScore, "entry", meta));
        } else if (matchesApply && entryScore >= 20 && !meta.inNav && !(onApplicationUrl && isFinalSubmit)) {
          entryRaw.push(toCandidate(el, entryScore - 30, "entry", meta));
        } else if (matchesApply && entryScore >= 20 && listingMode && (meta.inNav || meta.inTopBar) && !(onApplicationUrl && isFinalSubmit)) {
          entryRaw.push(toCandidate(el, entryScore, "entry", meta));
        }

        const cookieScore = scoreCookie(meta);
        if (cookieScore >= 55) cookieRaw.push(toCandidate(el, cookieScore, "cookie", meta));

        const contScore = scoreContinueAction(meta, blob);
        if (contScore >= 40) continueRaw.push(toCandidate(el, contScore, "continue", meta));

        const signInScore = scoreSignInButton(meta);
        if (signInScore >= 45) signInRaw.push(toCandidate(el, signInScore, "signin", meta));

        const signUpScore = scoreSignUpButton(meta);
        if (signUpScore >= 45) signUpRaw.push(toCandidate(el, signUpScore, "signup", meta));

        if (submitPattern.test(blob) || submitPattern.test(meta.testId || "")) {
          if (!isJobDescriptionNoise(meta, blob)) {
            submitRaw.push(toCandidate(el, scoreEntry(meta) + 20, "submit", meta));
          }
        }

        const confirmScoreOuter = scoreConfirmAction(meta, blob);
        if (confirmScoreOuter >= 50) confirmRaw.push(toCandidate(el, confirmScoreOuter, "confirm", meta));
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
      const confirmCandidates = dedupeSort(confirmRaw, 50);
      const signInCandidates = dedupeSort(signInRaw, 45);
      const signUpCandidates = dedupeSort(signUpRaw, 45);

      // Numbered element map for AI-driven generic actions (browser-use style):
      // fields first, then controls ranked by modal/main-content relevance.
      const interactives = [];
      const seenInteractive = new Set();
      function hintScoreForText(text) {
        const t = String(text || "").trim();
        if (!t) return 0;
        if (/skip\s+free\s+expert|skip\s*(and|&)\s*continue|skip\s+to\s+(application|apply)/i.test(t)) return 10;
        if (/^(skip|no[, ]?thanks|not now|maybe later|dismiss|close)$/i.test(t)) return 8;
        if (/\b(apply|i'?m interested|continue|submit|upload|sign up|next)\b/i.test(t)) return 5;
        return 0;
      }
      function pushInteractive(el, meta, kind) {
        const sel = elementSelector(el, meta);
        const key = sel || `${meta.tag}:${(meta.text || "").slice(0, 40)}:${Math.round(meta.top || 0)}`;
        if (seenInteractive.has(key)) return;
        seenInteractive.add(key);
        let zIndex = 0;
        let disabled = false;
        let bbox = null;
        try {
          const cs = getComputedStyle(el);
          zIndex = parseInt(cs.zIndex, 10) || 0;
          disabled = !!(el.disabled || el.getAttribute("aria-disabled") === "true");
          const r = el.getBoundingClientRect();
          bbox = {
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        } catch {
          /* ignore */
        }
        const inputType = (el.type || "").toLowerCase();
        const resolvedKind =
          kind ||
          (inputType === "file"
            ? "file"
            : inputType === "checkbox" || inputType === "radio"
              ? inputType
              : el.tagName === "SELECT"
                ? "select"
                : el.tagName === "TEXTAREA"
                  ? "textarea"
                  : "control");
        interactives.push({
          index: interactives.length,
          kind: resolvedKind,
          tag: meta.tag,
          role: meta.role || "",
          text: (meta.text || "").slice(0, 70),
          href: (meta.href || "").slice(0, 110),
          testId: meta.testId || "",
          aria: (meta.aria || "").slice(0, 60),
          selector: sel,
          inNav: !!meta.inNav,
          inFooter: !!meta.inFooter,
          inModal: !!(meta.inApplyModal || meta.inDialog),
          zIndex,
          disabled,
          bbox,
          hintScore: hintScoreForText(meta.text || meta.aria),
        });
      }
      for (const el of fieldEls.slice(0, 16)) {
        const meta = elementMetaWithModal(el, applyModals);
        meta.text = meta.text || el.placeholder || el.name || "";
        pushInteractive(el, meta, `field:${(el.type || el.tagName || "").toLowerCase()}`);
      }
      for (const el of fileInputEls.slice(0, 4)) {
        const meta = elementMetaWithModal(el, applyModals);
        meta.text = meta.text || meta.aria || meta.testId || "file upload";
        pushInteractive(el, meta, "file");
      }
      const rankedInteractive = interactive
        .map((el) => ({ el, meta: elementMetaWithModal(el, applyModals) }))
        .filter(({ meta, el }) => {
          if (meta.text || meta.aria || meta.testId || meta.href) return true;
          // Design-system cards often have short child text only — keep short clickables in modals
          if (meta.inDialog || meta.inApplyModal) return (meta.area || 0) > 80;
          const cls = String(el.className || "");
          return /ds-button|cursor-pointer|\bbtn\b/i.test(cls);
        })
        .sort((a, b) => {
          const w = (m) =>
            hintScoreForText(m.text || m.aria) +
            (m.inDialog ? 4 : 0) +
            (m.inApplyModal ? 3 : 0) +
            (m.inMainContent ? 2 : 0) -
            (m.inNav ? 1 : 0) -
            (m.inFooter ? 2 : 0);
          return w(b.meta) - w(a.meta);
        });
      for (const { el, meta } of rankedInteractive) {
        const dense = entryCandidates.length === 0 && fieldEls.length === 0;
        if (interactives.length >= (dense ? 64 : 48)) break;
        pushInteractive(el, meta, "control");
      }

      const structuralCookieBanner = queryDeep(structuralCookieSel).some(isVisibleEl);
      const cookieBanner =
        cookieCandidates.some((c) => c.score >= 60) || structuralCookieBanner;

      const modalCount = queryDeep("[role='dialog'], .modal, [aria-modal='true']").filter(isVisibleEl).length;
      const hasApplyModal = applyModals.length > 0 || modalCandidates.length > 0;

      const allDialogs = queryDeep("[role='dialog'], [aria-modal='true']").filter(isVisibleEl);
      const dialogStack = allDialogs
        .map((el) => {
          const meta = elementMetaWithModal(el, applyModals);
          const titleEl = el.querySelector("h1, h2, h3, [id*='modal-title' i], [class*='title' i]");
          const title = (titleEl?.innerText || el.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80);
          let zIndex = 0;
          try {
            zIndex = parseInt(getComputedStyle(el).zIndex, 10) || 0;
          } catch {
            zIndex = 0;
          }
          return {
            title,
            selector: elementSelector(el, meta),
            zIndex,
            inApplyModal: applyModals.includes(el) || !!el.__inApplyModal,
          };
        })
        .sort((a, b) => b.zIndex - a.zIndex);
      const activeDialogIndex = dialogStack.length > 0 ? 0 : -1;
      const pickerOpen = allDialogs.some((el) => {
        const listbox = el.querySelector("[role='listbox']");
        if (listbox && isVisibleEl(listbox)) return true;
        return !!el.querySelector(
          "[role='combobox'][aria-expanded='true'], [aria-haspopup='listbox'][aria-expanded='true']",
        );
      });

      const fileInputCount = fileInputEls.length;
      const bodyTextLength = (document.body?.innerText || "").replace(/\s+/g, " ").trim().length;

      const headingEls = queryDeep("h1, h2, h3").filter(isVisibleEl).slice(0, 10);
      const headings = headingEls
        .map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" | ")
        .slice(0, 400);
      const pageText = pageTextEarly;

      let pageKind = "unknown";
      const authForm = passwordFieldCount > 0 && (emailFieldCount > 0 || usernameFieldCount > 0);
      const signupBlob = `${document.title || ""} ${applyModalTitle || ""} ${location.href || ""} ${pageText || ""} ${headings || ""}`.toLowerCase();
      const signupForm =
        authForm &&
        (confirmPasswordFieldCount > 0 ||
          newPasswordFieldCount > 0 ||
          /\b(create (an |your )?account|sign[- ]?up with email|registration|new account)\b/.test(signupBlob) ||
          (signUpCandidates.length > 0 && signInCandidates.length === 0) ||
          (usernameFieldCount > 0 && passwordFieldCount >= 2) ||
          (usernameFieldCount > 0 &&
            /\b(create (an )?account|you have to be logged in|must be logged in|login required)\b/.test(signupBlob)));
      if (signupForm) pageKind = "auth";
      else if (authForm) pageKind = "auth";
      else if (fieldEls.length >= 2 || comboboxEls.length >= 1) pageKind = "form";
      else if (hasApplyModal) pageKind = "modal";
      else if (entryCandidates.length > 0) pageKind = "listing";
      else if (cookieBanner) pageKind = "consent";
      else if (bodyTextLength > 400) pageKind = "content";

      return {
        url: location.href,
        title: document.title?.slice(0, 120) || "",
        hostname: location.hostname,
        hasNativeApplyButton,
        headings,
        pageText,
        fieldCount: fieldEls.length,
        fields,
        customControls,
        customControlCount,
        controlCount: controlCountVal,
        interactives,
        hasForm: fieldEls.length > 0 || comboboxEls.length > 0,
        pageKind,
        cookieBanner: cookieBanner && !hasApplyModal,
        structuralCookieBanner,
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
        dialogStack,
        activeDialogIndex,
        pickerOpen,
        confirmCount: confirmCandidates.length,
        confirmCandidates,
        bodyTextLength,
        passwordFieldCount,
        emailFieldCount,
        usernameFieldCount,
        confirmPasswordFieldCount,
        newPasswordFieldCount,
        authForm,
        signupForm,
        signInCount: signInCandidates.length,
        signInCandidates,
        signUpCount: signUpCandidates.length,
        signUpCandidates,
      };
    },
    {
      applyPatternSource: APPLY_TEXT.source,
      listingPatternSource: LISTING_ENTRY_TEXT.source,
      continuePatternSource: CONTINUE_TEXT.source,
      modalStepPatternSource: MODAL_STEP_TEXT.source,
      submitPatternSource: SUBMIT_TEXT.source,
      confirmPatternSource: CONFIRM_TEXT.source,
      confirmStrictSource: CONFIRM_TEXT_STRICT.source,
      cookiePatternSource: COOKIE_TEXT.source,
      usernameFieldPatternSource: USERNAME_FIELD_PATTERN_SOURCE,
      cookieBannerSel: COOKIE_BANNER_SELECTORS,
      structuralCookieSel: STRUCTURAL_COOKIE_SELECTORS,
      nonCookiePopupPatternSource: NON_COOKIE_POPUP_BODY.source,
      submitPathPatternSource: SUBMIT_PATH_RE.source,
      interactiveSel: INTERACTIVE_SEL,
      listingMode,
      ...browserPatternArgs(),
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

async function enrichResumeReviewUpsell(page, snap) {
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
        root.querySelectorAll("*").forEach((host) => {
          if (host.shadowRoot) out.push(...queryDeep(selector, host.shadowRoot));
        });
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
async function enrichCustomControlWidgetTypes(page, snap) {
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

async function enrichViaPlaywright(page, snap) {
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
    for (const pattern of [/interested/i, /apply now/i, /easy apply/i, /\bapply\b/i]) {
      for (const role of ["button", "link"]) {
        try {
          const loc = page.getByRole(role, { name: pattern }).first();
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

export async function inspectPage(page) {
  let snap;
  try {
    const listingMode = getSettings().listing_mode !== false;
    snap = await scanDom(page, { listingMode });
  } catch (exc) {
    snap = emptySnap(page, exc.message);
  }
  snap = await enrichViaPlaywright(page, snap);
  try {
    mergeOverlaySnap(snap, await scanBlockingOverlays(page));
  } catch {
    /* overlay scan optional */
  }
  if (isNonCookiePopup(snap)) {
    snap.cookieBanner = false;
    snap.structuralCookieBanner = false;
  }
  return snap;
}

export { applyAffordances } from "./applyStep.js";

export function logPageSnapshot(log, snap, layer = "inspect", classification = null, pageState = null) {
  const stepInfo = classification
    ? ` step=${classification.step} conf=${classification.confidence}`
    : "";
  log.layer(layer, `url=${snap.url}`);
  log.layer(
    layer,
    `title="${snap.title}" fields=${snap.fieldCount} kind=${snap.pageKind || "?"} body=${snap.bodyTextLength || 0}ch${stepInfo}`,
  );
  const layout = pageState || pageStateSummary(snap);
  if (layout.uiPhase && layout.uiPhase !== "idle") {
    log.layer(layer, `  layout phase=${layout.uiPhase} dialogs=${layout.dialogStackDepth || 0} picker=${layout.pickerOpen ? "open" : "closed"}`, "info");
  }
  if (layout.pendingCommits?.length) {
    for (const p of layout.pendingCommits.slice(0, 3)) {
      log.layer(layer, `  pending: ${p}`, "warn");
    }
  }
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
  if (snap.hasBlockingOverlay) {
    log.layer(
      layer,
      `  blocking overlay${snap.bodyLocked ? " (body locked)" : ""}${snap.overlayHints?.length ? `: ${snap.overlayHints.join(", ")}` : ""}`,
      "info",
    );
    for (const d of snap.dismissCandidates || []) {
      log.layer(layer, `  dismiss: "${d.text || d.aria || "?"}" score=${d.score}${d.source ? ` src=${d.source}` : ""}`, "info");
    }
  } else if (classification?.step === "overlay" || isBlockingInterstitial(snap)) {
    log.layer(layer, "  interstitial likely (no hasBlockingOverlay flag)", "info");
    for (const d of (snap.dismissCandidates || []).slice(0, 4)) {
      log.layer(layer, `  dismiss candidate: "${d.text || d.aria || "?"}" score=${d.score || "?"}`, "info");
    }
  }
  if (isActiveApplyWizard(snap) && (classification?.step === "overlay" || isBlockingInterstitial(snap))) {
    log.layer(layer, "  note: apply wizard active — upsell classification suppressed", "info");
  }
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
  return pageFingerprintFromSnap(snap);
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
