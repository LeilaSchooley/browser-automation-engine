/**
 * DOM scan payload — walks light DOM + shadow roots inside page.evaluate.
 * Injects candidateScoring helperJs + browserPatternArgs.
 */
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
} from "../../patterns/index.js";
import { browserPatternArgs } from "../../primitives/browserControlPatterns.js";
import { serializeCandidateScoringForPage } from "./candidateScoring.js";

export function emptySnap(page, error = "") {
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

export function mergeCandidates(list, minScore = 25) {
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

export function recomputePageKind(snap) {
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

export async function scanDom(page, { listingMode = true } = {}) {
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
      fieldNameRules,
      placeholderPatternSource,
      placeholderPatternFlags,
      candidateScoringHelperJs,
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
      function comboboxLooksFilled(text, label) {
        const trimmed = String(text || "").replace(/\s+/g, " ").trim();
        if (!trimmed || placeholderRe.test(trimmed) || /^search\b/i.test(trimmed)) return false;
        let body = trimmed;
        const lab = String(label || "").replace(/\s+/g, " ").trim();
        if (lab) {
          try {
            body = body.replace(new RegExp(lab.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "ig"), " ");
          } catch {
            /* ignore */
          }
        }
        body = body
          .replace(/\brequired\b/gi, "")
          .replace(/\bsearch\s*\.+/gi, "")
          .replace(/[*\s?]+/g, " ")
          .trim();
        if (!body || placeholderRe.test(body) || /^search\b/i.test(body)) return false;
        return body.length > 1;
      }

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
          const sibText = (sib.textContent || "").replace(/\s+/g, " ").trim();
          if (
            sibText.length >= 8 &&
            sibText.length <= 160 &&
            /\b(city|live in|relocat|location|where|authorized|sponsor|remote)\b/i.test(sibText)
          ) {
            return sibText;
          }
          sib = sib.previousElementSibling;
        }
        // YC / React: question text often sits in a parent field wrapper, not as <label>.
        let node = el.parentElement;
        for (let depth = 0; depth < 6 && node; depth += 1, node = node.parentElement) {
          const q =
            node.querySelector?.("label, legend, [class*='question' i], p, h1, h2, h3, span") || null;
          const qText = (q?.textContent || "").replace(/\s+/g, " ").trim();
          if (
            qText.length >= 8 &&
            qText.length <= 160 &&
            /\b(city|live in|relocat|location|where else|authorized|sponsor|remote)\b/i.test(qText)
          ) {
            return qText;
          }
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
      /** Prefer HTML name= over label text (stable across boards). */
      function mapByFieldName(name) {
        const key = String(name || "")
          .trim()
          .replace(/\[\d*\]$/, "")
          .toLowerCase();
        if (!key) return null;
        for (const rule of fieldNameRules || []) {
          if (rule.name === key) {
            return {
              mappedTo: rule.mappedTo,
              type: rule.type,
              widgetType: rule.widgetType || "",
            };
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
      function radioGroupLooksFilled(rootEl) {
        // Trust only real selection state — never the presence of "Yes"/"No" in
        // the question text (that falsely marked unfilled screening radios as done,
        // which then excluded them from the fill pass and stalled WaaS Continue).
        const radios = [...rootEl.querySelectorAll("input[type='radio'], [role='radio']")].filter(isVisibleEl);
        if (radios.some((r) => r.checked || r.getAttribute("aria-checked") === "true")) return true;
        // A label/button is "selected" only if it carries a selected marker AND
        // wraps/points at a checked control (avoids matching decorative .active).
        const options = [...rootEl.querySelectorAll("label, button, [role='button']")].filter(isVisibleEl);
        for (const opt of options) {
          if (!buttonLooksSelected(opt)) continue;
          const input = opt.querySelector("input[type='radio'], [role='radio']");
          if (input && (input.checked || input.getAttribute("aria-checked") === "true")) return true;
          // Button-style yes/no (no inner input) — selected marker is authoritative.
          if (!input && (opt.tagName === "BUTTON" || opt.getAttribute("role") === "button")) return true;
        }
        return false;
      }
      function discoverApplicationControls() {
        const out = [];
        const visited = new Set();
        // Lever custom cards (.application-question) before bare form — form's first <label> is often Name/Email.
        const roots = queryDeep(
          '[class*="ashby-application-form-field-entry"], fieldset, [class*="yesno" i], [data-field-id], [class*="application-form"] label, .application-question, .custom-question, [data-qa="multiple-choice"], form',
        );
        for (const root of roots) {
          if (!isVisibleEl(root) || visited.has(root)) continue;
          const questionEl =
            root.querySelector('[class*="question-title"]') ||
            root.querySelector(".application-label") ||
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
          if (
            (!label || label.length < 4) &&
            (root.matches('[data-qa="multiple-choice"]') || root.getAttribute("data-qa") === "multiple-choice")
          ) {
            label = (
              root.closest(".application-question, .custom-question")?.querySelector(".application-label")
                ?.textContent || ""
            )
              .replace(/\s+/g, " ")
              .trim();
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
            const filled = radioGroupLooksFilled(root, label);
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

          // Greenhouse/Lever-style EEOC / compliance <select>s.
          // Always label from the select itself — never inherit a form-wide question title
          // (Lever's first .application-label is often "Pronouns", which poisoned eeo[*] selects).
          const selects = [...root.querySelectorAll("select")].filter(isVisibleEl);
          for (const sel of selects) {
            if (visited.has(sel)) continue;
            const nameAttr = (sel.getAttribute("name") || "").trim();
            const scopedLabel = (
              sel.closest(".application-question, .custom-question, [class*='field-entry'], fieldset")
                ?.querySelector(".application-label, [class*='question-title'], legend")
                ?.textContent || ""
            )
              .replace(/\s+/g, " ")
              .trim();
            const selLabel =
              scopedLabel ||
              (sel.getAttribute("aria-label") || "").trim() ||
              nearbyFieldLabel(sel) ||
              nameAttr ||
              "";
            // Prefer name/id (eeo[gender]) over free-text label so Pronouns never wins.
            const selMap =
              mapApplicationLabel(nameAttr) ||
              (/\beeo\[?gender\]?/i.test(nameAttr) ? { mappedTo: "eeocgender", type: "eeocgender" } : null) ||
              (/\beeo\[?race\]?/i.test(nameAttr) ? { mappedTo: "eeocrace", type: "eeocrace" } : null) ||
              (/\beeo\[?veteran\]?/i.test(nameAttr) ? { mappedTo: "eeocveteran", type: "eeocveteran" } : null) ||
              (/\beeo\[?disabilit/i.test(nameAttr) ? { mappedTo: "eeocdisability", type: "eeocdisability" } : null) ||
              mapApplicationLabel(selLabel);
            if (!selMap) continue;
            // Native <select> is never Lever pronouns (those are checkboxes).
            if (selMap.mappedTo === "pronouns" && !/pronoun/i.test(nameAttr)) continue;
            const opts = [...sel.options].map((o) => (o.textContent || "").trim().toLowerCase());
            const looksCompliance =
              opts.some((o) => /decline|prefer not|do not wish|i do not want|n\/a|male|female|veteran|disabilit/.test(o)) ||
              ["eeocgender", "eeocrace", "eeocveteran", "eeocdisability"].includes(selMap.mappedTo);
            if (
              !looksCompliance &&
              ![
                "visasponsorship",
                "workauthorization",
                "remotepreference",
                "willingtorelocate",
                "policyack",
              ].includes(selMap.mappedTo)
            ) {
              continue;
            }
            visited.add(sel);
            const meta = elementMetaWithModal(sel, applyModals);
            out.push({
              label: (selLabel || selMap.mappedTo).slice(0, 120),
              mappedTo: selMap.mappedTo,
              type: selMap.type,
              widgetType: "select",
              text: "",
              selector: elementSelector(sel, meta),
              triggerSelector: elementSelector(sel, meta),
              questionLabel: (selLabel || selMap.mappedTo).slice(0, 120),
              top: meta.top,
              left: Math.round(sel.getBoundingClientRect().left),
              filled: Boolean(sel.value && sel.value !== "" && sel.selectedIndex > 0),
              inModal: meta.inApplyModal || meta.inDialog,
            });
          }

          // Lever-style pronouns checkbox groups.
          const pronounBoxes = [...root.querySelectorAll('input[type="checkbox"][name*="pronoun"], input[type="checkbox"][name*="Pronoun"], #candidatePronounsCheckboxes input[type="checkbox"], [data-qa="candidatePronounsCheckboxes"] input[type="checkbox"]')].filter(isVisibleEl);
          if (pronounBoxes.length >= 2) {
            const group =
              pronounBoxes[0].closest("#candidatePronounsCheckboxes, [data-qa='candidatePronounsCheckboxes'], ul, fieldset, .application-field") ||
              pronounBoxes[0].parentElement;
            if (group && !visited.has(group)) {
              const pLabel =
                (group.closest(".application-question")?.querySelector(".application-label")?.textContent || "").replace(/\s+/g, " ").trim() ||
                label ||
                "Pronouns";
              if (/\bpronoun/i.test(pLabel) || pronounBoxes.some((b) => /pronoun/i.test(b.name || ""))) {
                visited.add(group);
                const meta = elementMetaWithModal(group, applyModals);
                out.push({
                  label: pLabel.slice(0, 120) || "Pronouns",
                  mappedTo: "pronouns",
                  type: "pronouns",
                  widgetType: "checkbox",
                  text: "",
                  selector: elementSelector(group, meta),
                  triggerSelector: elementSelector(group, meta),
                  questionLabel: pLabel.slice(0, 120) || "Pronouns",
                  top: meta.top,
                  left: Math.round(group.getBoundingClientRect().left),
                  filled: pronounBoxes.some((b) => b.checked),
                  inModal: meta.inApplyModal || meta.inDialog,
                });
              }
            }
          }
        }

        // Also scan top-level selects with EEOC-ish options (Greenhouse bare forms).
        for (const sel of queryDeep("select")) {
          if (!isVisibleEl(sel) || visited.has(sel)) continue;
          const nameAttr = (sel.getAttribute("name") || "").trim();
          const scopedLabel = (
            sel.closest(".application-question, .custom-question, [class*='field-entry'], fieldset")
              ?.querySelector(".application-label, [class*='question-title'], legend")
              ?.textContent || ""
          )
            .replace(/\s+/g, " ")
            .trim();
          const selLabel =
            scopedLabel ||
            (sel.getAttribute("aria-label") || "").trim() ||
            nearbyFieldLabel(sel) ||
            nameAttr ||
            "";
          const selMap =
            mapApplicationLabel(nameAttr) ||
            (/\beeo\[?gender\]?/i.test(nameAttr) ? { mappedTo: "eeocgender", type: "eeocgender" } : null) ||
            (/\beeo\[?race\]?/i.test(nameAttr) ? { mappedTo: "eeocrace", type: "eeocrace" } : null) ||
            (/\beeo\[?veteran\]?/i.test(nameAttr) ? { mappedTo: "eeocveteran", type: "eeocveteran" } : null) ||
            (/\beeo\[?disabilit/i.test(nameAttr) ? { mappedTo: "eeocdisability", type: "eeocdisability" } : null) ||
            mapApplicationLabel(selLabel);
          if (!selMap) {
            // Unmapped <select> with a real question + concrete options → surface
            // for the semantic resolver. Skip identity/geo selects handled elsewhere.
            const qText = (selLabel || "").replace(/\s+/g, " ").trim();
            const selOpts = [...sel.options]
              .map((o) => ({ text: (o.textContent || "").replace(/\s+/g, " ").trim(), value: o.value }))
              .filter((o) => o.text && !/^(select|choose|please select|\-+)/i.test(o.text));
            const isGeoIdentity = /country|state|province|nationalit|postal|zip|phone|timezone|language/i.test(
              `${nameAttr} ${qText}`,
            );
            if (visited.has(sel) || qText.length < 8 || selOpts.length < 2 || isGeoIdentity) continue;
            visited.add(sel);
            const metaU = elementMetaWithModal(sel, applyModals);
            out.push({
              label: qText.slice(0, 120),
              mappedTo: null,
              type: "choice",
              unmapped: true,
              widgetType: "select",
              text: "",
              options: selOpts.slice(0, 40).map((o) => ({ text: o.text.slice(0, 120), value: o.value })),
              selector: elementSelector(sel, metaU),
              triggerSelector: elementSelector(sel, metaU),
              questionLabel: qText.slice(0, 120),
              top: metaU.top,
              left: Math.round(sel.getBoundingClientRect().left),
              filled: Boolean(sel.value && sel.value !== "" && sel.selectedIndex > 0),
              inModal: metaU.inApplyModal || metaU.inDialog,
            });
            continue;
          }
          if (selMap.mappedTo === "pronouns" && !/pronoun/i.test(nameAttr)) continue;
          visited.add(sel);
          const meta = elementMetaWithModal(sel, applyModals);
          out.push({
            label: (selLabel || selMap.mappedTo).slice(0, 120),
            mappedTo: selMap.mappedTo,
            type: selMap.type,
            widgetType: "select",
            text: "",
            selector: elementSelector(sel, meta),
            triggerSelector: elementSelector(sel, meta),
            questionLabel: (selLabel || selMap.mappedTo).slice(0, 120),
            top: meta.top,
            left: Math.round(sel.getBoundingClientRect().left),
            filled: Boolean(sel.value && sel.value !== "" && sel.selectedIndex > 0),
            inModal: meta.inApplyModal || meta.inDialog,
          });
        }

        // Top-level Lever pronouns groups (often not wrapped in <label>, so missed above).
        for (const group of queryDeep("#candidatePronounsCheckboxes, [data-qa='candidatePronounsCheckboxes']")) {
          if (!isVisibleEl(group) || visited.has(group)) continue;
          const boxes = [...group.querySelectorAll('input[type="checkbox"]')].filter(isVisibleEl);
          if (boxes.length < 2) continue;
          visited.add(group);
          const pLabel =
            (group.closest(".application-question")?.querySelector(".application-label")?.textContent || "")
              .replace(/\s+/g, " ")
              .trim() || "Pronouns";
          const meta = elementMetaWithModal(group, applyModals);
          out.push({
            label: pLabel.slice(0, 120),
            mappedTo: "pronouns",
            type: "pronouns",
            widgetType: "checkbox",
            text: "",
            selector: elementSelector(group, meta),
            triggerSelector: elementSelector(group, meta),
            questionLabel: pLabel.slice(0, 120),
            top: meta.top,
            left: Math.round(group.getBoundingClientRect().left),
            filled: boxes.some((b) => b.checked),
            inModal: meta.inApplyModal || meta.inDialog,
          });
        }

        // Lever Yes/No multiple-choice cards (radios under .application-label, no wrapping <label>).
        for (const group of queryDeep('[data-qa="multiple-choice"], ul[data-qa="multiple-choice"]')) {
          if (!isVisibleEl(group) || visited.has(group)) continue;
          const radios = [...group.querySelectorAll('input[type="radio"], [role="radio"]')].filter(isVisibleEl);
          if (radios.length < 2) continue;
          const question = group.closest(".application-question, .custom-question") || group.parentElement;
          const qLabel = (
            question?.querySelector(".application-label")?.textContent ||
            question?.querySelector('[class*="question-title"]')?.textContent ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          if (!qLabel) continue;
          const mapping = mapApplicationLabel(qLabel);
          if (!mapping) continue;
          const scope = question && question !== group ? question : group;
          if (visited.has(scope)) continue;
          visited.add(scope);
          visited.add(group);
          const filled = radioGroupLooksFilled(scope, qLabel);
          const meta = elementMetaWithModal(scope, applyModals);
          out.push({
            label: qLabel.slice(0, 160),
            mappedTo: mapping.mappedTo,
            type: mapping.type,
            widgetType: "radio",
            text: "",
            selector: elementSelector(scope, meta),
            triggerSelector: elementSelector(group, meta),
            questionLabel: qLabel.slice(0, 160),
            top: meta.top,
            left: Math.round(scope.getBoundingClientRect().left),
            filled,
            inModal: meta.inApplyModal || meta.inDialog,
          });
        }

        // Lever required textareas for company affiliation (related to employee → "No").
        for (const ta of queryDeep("textarea.card-field-input, .application-question textarea, textarea[name*='cards']")) {
          if (!isVisibleEl(ta) || visited.has(ta)) continue;
          const qLabel = (
            ta.closest(".application-question, .custom-question")?.querySelector(".application-label")?.textContent ||
            ta.getAttribute("aria-label") ||
            nearbyFieldLabel(ta) ||
            ""
          )
            .replace(/\s+/g, " ")
            .trim();
          const mapping = mapApplicationLabel(qLabel);
          if (!mapping || !["employeerelation"].includes(mapping.mappedTo)) continue;
          visited.add(ta);
          const meta = elementMetaWithModal(ta, applyModals);
          out.push({
            label: qLabel.slice(0, 160),
            mappedTo: mapping.mappedTo,
            type: mapping.type,
            widgetType: "text",
            text: "",
            selector: elementSelector(ta, meta),
            triggerSelector: elementSelector(ta, meta),
            questionLabel: qLabel.slice(0, 160),
            top: meta.top,
            left: Math.round(ta.getBoundingClientRect().left),
            filled: Boolean(ta.value && String(ta.value).trim()),
            inModal: meta.inApplyModal || meta.inDialog,
          });
        }

        // ATS: radio groups by name (or radiogroup) with nearby question text.
        // Option labels are often bare "Yes"/"No", so map from the question, not the radio.
        const radioNameGroups = new Map();
        for (const r of queryDeep("input[type='radio'], [role='radio']").filter(isVisibleEl)) {
          const rg = r.closest('[role="radiogroup"]');
          const name = (r.getAttribute("name") || "").trim();
          const key = name || (rg ? `rg:${rg.getAttribute("aria-label") || ""}:${Math.round(rg.getBoundingClientRect().top)}` : "");
          if (!key) continue;
          if (!radioNameGroups.has(key)) radioNameGroups.set(key, []);
          radioNameGroups.get(key).push(r);
        }
        function lowestCommonAncestor(els) {
          if (!els.length) return null;
          let anc = els[0].parentElement || els[0];
          for (let i = 1; i < els.length; i += 1) {
            while (anc && !anc.contains(els[i])) anc = anc.parentElement;
            if (!anc) return null;
          }
          return anc;
        }
        for (const radios of radioNameGroups.values()) {
          if (radios.length < 2) continue;
          // Use the tightest block that holds exactly this name-group's radios (their
          // lowest common ancestor). A broad `form > div` wrapper would swallow sibling
          // questions and make radioGroupLooksFilled() report a checked sibling as ours.
          const scope = lowestCommonAncestor(radios) || radios[0].parentElement;
          if (!scope || visited.has(scope)) continue;
          const optionTexts = radios
            .map((r) => {
              const lbl = r.closest("label");
              return (lbl?.textContent || r.getAttribute("aria-label") || r.value || "")
                .replace(/\s+/g, " ")
                .trim();
            })
            .filter(Boolean);
          const ariaGroup = (scope.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
          let qLabel = ariaGroup;
          if (!qLabel || qLabel.length < 8) {
            // Prefer a question label WITHIN the scope that does not wrap an option
            // radio (WaaS: <label class="font-bold">question</label> above the options).
            const inScopeQ = [
              ...scope.querySelectorAll(
                "label, legend, .question, .application-label, [class*='question-title']",
              ),
            ].find(
              (l) => isVisibleEl(l) && !l.querySelector("input[type='radio'], [role='radio']"),
            );
            const qEl = inScopeQ || scope.previousElementSibling;
            qLabel = (qEl?.textContent || "").replace(/\s+/g, " ").trim();
          }
          if (!qLabel || qLabel.length < 8) {
            // Parent block text minus option labels.
            let blob = (scope.parentElement?.innerText || scope.innerText || "").replace(/\s+/g, " ").trim();
            for (const opt of optionTexts) {
              if (opt.length >= 2) blob = blob.split(opt).join(" ");
            }
            qLabel = blob.replace(/\s+/g, " ").trim().slice(0, 200);
          }
          const mapping = mapApplicationLabel(qLabel) || mapApplicationLabel(ariaGroup);
          const radioName = (radios[0].getAttribute("name") || "").replace(/\[\d*\]$/, "").trim();
          const nameMapping = mapByFieldName(radioName);
          const resolvedMapping = nameMapping || mapping;
          if (!resolvedMapping) {
            // No deterministic mapping — still surface it as an unmapped choice
            // group so the semantic option-resolver can pick from real options.
            // Require a real question (>= 8 chars) and >= 2 options to avoid noise.
            if (visited.has(scope) || qLabel.length < 8 || optionTexts.length < 2) continue;
            visited.add(scope);
            const filledU = radioGroupLooksFilled(scope, qLabel);
            const metaU = elementMetaWithModal(scope, applyModals);
            out.push({
              label: qLabel.slice(0, 160),
              mappedTo: null,
              type: "choice",
              unmapped: true,
              widgetType: "radio",
              text: "",
              options: optionTexts.slice(0, 24).map((t) => ({ text: t.slice(0, 120) })),
              selector: elementSelector(scope, metaU),
              triggerSelector: elementSelector(scope, metaU),
              questionLabel: qLabel.slice(0, 160),
              top: metaU.top,
              left: Math.round(scope.getBoundingClientRect().left),
              filled: filledU,
              inModal: metaU.inApplyModal || metaU.inDialog,
            });
            continue;
          }
          if (out.some((c) => c.mappedTo === resolvedMapping.mappedTo)) continue;
          visited.add(scope);
          const filled = radioGroupLooksFilled(scope, qLabel);
          const meta = elementMetaWithModal(scope, applyModals);
          const widgetFromName = nameMapping?.widgetType;
          out.push({
            label: qLabel.slice(0, 160),
            mappedTo: resolvedMapping.mappedTo,
            type: resolvedMapping.type,
            widgetType:
              widgetFromName === "yesno"
                ? "yesno"
                : widgetFromName === "checkbox"
                  ? "checkbox"
                  : "radio",
            text: "",
            selector: elementSelector(scope, meta),
            triggerSelector: elementSelector(scope, meta),
            questionLabel: qLabel.slice(0, 160),
            top: meta.top,
            left: Math.round(scope.getBoundingClientRect().left),
            filled,
            inModal: meta.inApplyModal || meta.inDialog,
          });
        }

        // Generic checkbox groups (non-pronoun): WaaS job_type
        // ("Full-time employee / Contractor / Cofounder") and similar multi-selects.
        // Group by shared name; map the question when possible (employmenttype),
        // otherwise surface as an unmapped choice group for the semantic resolver.
        const checkboxNameGroups = new Map();
        for (const cb of queryDeep("input[type='checkbox']").filter(isVisibleEl)) {
          const name = (cb.getAttribute("name") || "").replace(/\[\d*\]$/, "").trim();
          if (!name) continue;
          if (/pronoun/i.test(name)) continue;
          if (!checkboxNameGroups.has(name)) checkboxNameGroups.set(name, []);
          checkboxNameGroups.get(name).push(cb);
        }
        for (const boxes of checkboxNameGroups.values()) {
          if (boxes.length < 2) continue;
          const scope = lowestCommonAncestor(boxes) || boxes[0].parentElement;
          if (!scope || visited.has(scope)) continue;
          const optionTexts = boxes
            .map((b) => {
              const lbl = b.closest("label");
              return (lbl?.textContent || b.getAttribute("aria-label") || b.value || "")
                .replace(/\s+/g, " ")
                .trim();
            })
            .filter(Boolean);
          const inScopeQ = [
            ...scope.querySelectorAll("label, legend, .question, .application-label, [class*='question-title']"),
          ].find((l) => isVisibleEl(l) && !l.querySelector("input[type='checkbox']"));
          let qLabel = (inScopeQ?.textContent || scope.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim();
          if (!qLabel || qLabel.length < 8) {
            let blob = (scope.parentElement?.innerText || scope.innerText || "").replace(/\s+/g, " ").trim();
            for (const opt of optionTexts) {
              if (opt.length >= 2) blob = blob.split(opt).join(" ");
            }
            qLabel = blob.replace(/\s+/g, " ").trim().slice(0, 200);
          }
          if (qLabel.length < 8 || optionTexts.length < 2) continue;
          const cbName = (boxes[0].getAttribute("name") || "").replace(/\[\d*\]$/, "").trim();
          let mapping = mapByFieldName(cbName) || mapApplicationLabel(qLabel);
          if (mapping && out.some((c) => c.mappedTo === mapping.mappedTo)) continue;
          visited.add(scope);
          const filledC = boxes.some((b) => b.checked || b.getAttribute("aria-checked") === "true");
          const metaC = elementMetaWithModal(scope, applyModals);
          out.push({
            label: qLabel.slice(0, 160),
            mappedTo: mapping ? mapping.mappedTo : null,
            type: mapping ? mapping.type : "choice",
            unmapped: !mapping,
            widgetType: "checkbox",
            text: "",
            options: optionTexts.slice(0, 24).map((t) => ({ text: t.slice(0, 120) })),
            selector: elementSelector(scope, metaC),
            triggerSelector: elementSelector(scope, metaC),
            questionLabel: qLabel.slice(0, 160),
            top: metaC.top,
            left: Math.round(scope.getBoundingClientRect().left),
            filled: filledC,
            inModal: metaC.inApplyModal || metaC.inDialog,
          });
        }

        // WaaS engineering sub-roles (eng_type) — react-select multi after role=eng.
        for (const block of queryDeep("form div.mb-4, .mb-4")) {
          if (!isVisibleEl(block) || visited.has(block)) continue;
          const hidden = block.querySelector("input[name='eng_type'], input[type='hidden'][name='eng_type']");
          const rsInput = block.querySelector("[id^='react-select-'][id$='-input'], [class*='select__control']");
          if (!hidden && !rsInput) continue;
          let qLabel = "";
          const qEl = [...block.querySelectorAll("label, legend")].find(
            (l) => isVisibleEl(l) && !l.querySelector("input[type='checkbox'], input[type='radio']"),
          );
          qLabel = (qEl?.textContent || block.innerText || "").replace(/\s+/g, " ").trim();
          if (!/engineering roles|choose up to four/i.test(qLabel)) continue;
          if (out.some((c) => c.mappedTo === "engroles")) continue;
          visited.add(block);
          const filledEng =
            Boolean(hidden?.value && String(hidden.value).trim()) ||
            block.querySelectorAll("[class*='multi-value'], [class*='MultiValue']").length > 0;
          const metaE = elementMetaWithModal(block, applyModals);
          const globals = typeof window !== "undefined" ? window.JOBS_GLOBALS : null;
          const engOpts = (globals?.ENG_TYPES || [])
            .map((e) => ({ text: String(e.label || e.value || "").trim() }))
            .filter((o) => o.text);
          out.push({
            label: qLabel.slice(0, 160),
            mappedTo: "engroles",
            type: "engroles",
            widgetType: "combobox",
            multiple: true,
            text: "",
            options: engOpts.length
              ? engOpts.slice(0, 24)
              : ["Full stack", "Backend", "Frontend", "Machine learning"].map((t) => ({ text: t })),
            selector: elementSelector(block, metaE),
            triggerSelector: elementSelector(block, metaE),
            questionLabel: qLabel.slice(0, 160),
            top: metaE.top,
            left: Math.round(block.getBoundingClientRect().left),
            filled: filledEng,
            inModal: metaE.inApplyModal || metaE.inDialog,
          });
        }

        // WaaS /application/skills — technologies multi-select.
        for (const block of queryDeep("form div.mb-4, .mb-4, form")) {
          if (!isVisibleEl(block) || visited.has(block)) continue;
          const rsInput = block.querySelector(
            "[id^='react-select-'][id$='-input'], [class*='select__control'], [role='combobox']",
          );
          if (!rsInput) continue;
          let qLabel = "";
          const qEl = [...block.querySelectorAll("label, legend, p, h1, h2, h3, div")].find((l) => {
            const t = (l.textContent || "").replace(/\s+/g, " ").trim();
            return t.length > 12 && t.length < 200 && /technologies|skills are you/i.test(t);
          });
          qLabel = (qEl?.textContent || "").replace(/\s+/g, " ").trim();
          if (!/technologies|skills are you most/i.test(qLabel)) continue;
          if (out.some((c) => c.mappedTo === "techskills")) continue;
          visited.add(block);
          const filledSkills =
            block.querySelectorAll("[class*='multi-value'], [class*='MultiValue']").length > 0;
          const metaS = elementMetaWithModal(block, applyModals);
          out.push({
            label: qLabel.slice(0, 160),
            mappedTo: "techskills",
            type: "techskills",
            widgetType: "combobox",
            multiple: true,
            text: "",
            options: [],
            selector: elementSelector(rsInput.closest("[class*='select']") || block, metaS),
            triggerSelector: elementSelector(rsInput, metaS),
            questionLabel: qLabel.slice(0, 160),
            top: metaS.top,
            left: Math.round(block.getBoundingClientRect().left),
            filled: filledSkills,
            required: true,
            inModal: metaS.inApplyModal || metaS.inDialog,
          });
        }

        // WaaS-style screening: questions rendered as plain text with bare radios
        // that carry no `name` and no `[role=radiogroup]`, so the grouping above
        // skips them. Anchor on the question text, climb to the smallest block
        // that owns the radio options, and emit a mapped control with a real
        // selector so completeness + fill can both see it.
        const SCREENING_RADIO_MAPPED = new Set([
          "visasponsorship",
          "workauthorization",
          "remotepreference",
          "willingtorelocate",
          "policyack",
          "jobfunction",
          "roleinterest",
          "fulltimestudent",
        ]);
        function ownTextOf(el) {
          let t = "";
          for (const n of el.childNodes) {
            if (n.nodeType === 3) t += n.textContent;
          }
          return t.replace(/\s+/g, " ").trim();
        }
        const textCandidates = queryDeep(
          "label, legend, p, h2, h3, h4, div, span, li",
        ).filter(isVisibleEl);
        for (const el of textCandidates) {
          const own = ownTextOf(el);
          if (own.length < 8 || own.length > 240) continue;
          const mapping = mapApplicationLabel(own);
          if (!mapping || !SCREENING_RADIO_MAPPED.has(mapping.mappedTo)) continue;
          if (out.some((c) => c.mappedTo === mapping.mappedTo)) continue;
          // Climb to the nearest ancestor that actually owns radio options,
          // capped so we never grab the whole form (a per-question block holds
          // ≤ 3 options; a full-form wrapper holds far more).
          let node = el.closest(
            '[class*="field" i], [class*="question" i], [class*="form-group" i], fieldset, [data-field], [data-testid], li, section',
          ) || el.parentElement;
          let radios = [];
          for (let up = 0; up < 4 && node; up += 1) {
            radios = [...node.querySelectorAll("input[type='radio'], [role='radio']")].filter(isVisibleEl);
            if (radios.length >= 1) break;
            node = node.parentElement;
          }
          if (!node || radios.length < 1 || radios.length > 4) continue;
          if (visited.has(node)) continue;
          visited.add(node);
          const meta = elementMetaWithModal(node, applyModals);
          out.push({
            label: own.slice(0, 160),
            mappedTo: mapping.mappedTo,
            type: mapping.type,
            widgetType: mapping.mappedTo === "remotepreference" ? "radio" : "yesno",
            text: "",
            selector: elementSelector(node, meta),
            triggerSelector: elementSelector(node, meta),
            questionLabel: own.slice(0, 160),
            top: meta.top,
            left: Math.round(node.getBoundingClientRect().left),
            filled: radioGroupLooksFilled(node),
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
          type: (el.type || "").toLowerCase(),
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
        // "Continue with Apple/Google" must not steal email Continue clicks.
        if (
          /\b((continue|sign|log)\s+(in\s+)?with\s+(apple|google|facebook|github|microsoft|linkedin|x|twitter)|(sign|log)\s+up\s+with\s+(apple|google|facebook|github|microsoft))\b/i.test(
            text,
          )
        ) {
          return false;
        }
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
        let disabled = false;
        try {
          disabled = !!(el.disabled || el.getAttribute("aria-disabled") === "true");
        } catch {
          /* ignore */
        }
        return {
          kind,
          tag: meta.tag,
          text: meta.text.slice(0, 80) || meta.testId || meta.aria,
          testId: meta.testId,
          aria: meta.aria,
          href: meta.href || "",
          selector: buildSelector(meta),
          score,
          disabled,
          inApplyModal: !!meta.inApplyModal,
          source: "dom",
        };
      }

      const pageHost = (location.hostname || "").replace(/^www\./, "");
      const hasNativeApplyButton = !!document.querySelector(
        ".btn-apply, [class*='btn-apply-job'], a.btn-apply-job-internal-without-login, a.btn-apply-job-external",
      );
      // Injected scorers: scoreListingEntry, scoreEntry, scoreSignInButton, scoreSignUpButton
      // eslint-disable-next-line no-eval
      eval(candidateScoringHelperJs);

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

      function fieldLabelText(el) {
        const parts = [];
        const push = (t) => {
          const s = String(t || "").replace(/\s+/g, " ").trim();
          if (s && s.length < 48 && !parts.includes(s)) parts.push(s);
        };
        if (el.labels?.length) {
          for (const lab of el.labels) push(lab.innerText);
          if (parts.length) return parts.join(" ").slice(0, 60);
        }
        push(el.getAttribute("aria-label"));
        const labelledBy = el.getAttribute("aria-labelledby");
        if (labelledBy) {
          for (const id of labelledBy.split(/\s+/)) {
            const n = document.getElementById(id);
            if (n) push(n.innerText || n.textContent);
          }
        }
        const parent = el.parentElement;
        if (parent) {
          for (const lab of parent.querySelectorAll(":scope > label, :scope > span, :scope > legend")) {
            if (lab.contains(el)) continue;
            push(lab.innerText || lab.textContent);
          }
          let sib = el.previousElementSibling;
          while (sib) {
            if (!sib.querySelector?.("input, textarea, select")) push(sib.innerText || sib.textContent);
            sib = sib.previousElementSibling;
          }
        }
        push(el.placeholder);
        return parts.join(" ").replace(/\s+/g, " ").trim();
      }

      const fields = fieldEls.slice(0, 16).map((el) => {
        const meta = elementMetaWithModal(el, applyModals);
        return {
          type: el.type || el.tagName.toLowerCase(),
          label: (fieldLabelText(el) || meta.text || "").slice(0, 60),
          name: el.name || "",
          id: el.id || "",
          selector: elementSelector(el, meta),
          required: el.required || el.getAttribute("aria-required") === "true",
          filled: !!(el.value && String(el.value).trim()),
          autocomplete: (el.autocomplete || "").toLowerCase(),
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

      const comboboxEls = queryDeep(
        [
          '[role="combobox"]',
          '[aria-haspopup="listbox"]',
          // React Select / similar — do NOT include bare div[data-field] (YC wraps radios in those).
          ".Select__control",
          "[class*='select__control' i]",
          "[class*='Select__control']",
          "[id^='react-select-'][id$='-input']",
        ].join(", "),
      ).filter(isVisibleEl);
      function screeningRadiosFilled(rootEl, textBlob) {
        return radioGroupLooksFilled(rootEl, textBlob);
      }
      const customControls = comboboxEls.slice(0, 12).map((el) => {
        const meta = elementMetaWithModal(el, applyModals);
        const ariaLabel = (el.getAttribute("aria-label") || meta.aria || "").trim();
        const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        const label = (ariaLabel || nearbyFieldLabel(el) || text.slice(0, 60) || "combobox").slice(0, 80);
        const appMap = mapApplicationLabel(label);
        // Some boards expose screening questions with role=combobox; treat as application radios.
        if (
          appMap &&
          [
            "workauthorization",
            "visasponsorship",
            "remotepreference",
            "willingtorelocate",
            "policyack",
            "hidecompanies",
          ].includes(appMap.mappedTo)
        ) {
          const filled = screeningRadiosFilled(el, `${label} ${text}`);
          return {
            label: label.slice(0, 120),
            mappedTo: appMap.mappedTo,
            type: appMap.type,
            role: el.getAttribute("role") || "combobox",
            widgetType: "radio",
            text: text.slice(0, 80),
            selector: elementSelector(el, meta),
            triggerSelector: elementSelector(el, meta),
            questionLabel: label.slice(0, 120),
            filled,
            inModal: meta.inApplyModal || meta.inDialog,
          };
        }
        const mapping = mapComboboxLabel(label);
        const isLoc = mapping.mappedTo === "location" || mapping.mappedTo === "relocatelocations";
        let filled;
        if (isLoc) {
          // A typeahead input's committed value lives in el.value (not innerText).
          // An open dropdown (aria-expanded=true) or a bare single-token search
          // string ("LONDON") is NOT committed — a real Places chip is "London, UK".
          const val = String(el.value || text || "").replace(/\s+/g, " ").trim();
          const expanded = el.getAttribute("aria-expanded") === "true";
          filled = !expanded && val.length >= 2 && (/,/.test(val) || /\S\s+\S/.test(val)) && !/^search\b/i.test(val);
        } else {
          filled = comboboxLooksFilled(text, label);
        }
        return {
          label,
          mappedTo: mapping.mappedTo,
          type: mapping.type,
          role: el.getAttribute("role") || "combobox",
          widgetType: isLoc ? "typeahead" : "combobox",
          text: text.slice(0, 80),
          selector: elementSelector(el, meta),
          triggerSelector: elementSelector(el, meta),
          filled,
          inModal: meta.inApplyModal || meta.inDialog,
        };
      });
      for (const ac of discoverApplicationControls()) {
        const idx = customControls.findIndex((c) => {
          if (c.mappedTo !== ac.mappedTo) return false;
          // One screening control per mappedTo (YC radios + mis-tagged comboboxes).
          if (
            [
              "workauthorization",
              "visasponsorship",
              "remotepreference",
              "willingtorelocate",
              "policyack",
              "hidecompanies",
            ].includes(ac.mappedTo)
          ) {
            return true;
          }
          return c.label === ac.label || c.selector === ac.selector;
        });
        if (idx < 0) {
          customControls.push(ac);
          continue;
        }
        // Prefer pronouns checkbox group over a mis-tagged select; prefer concrete eeo[name] selects.
        // Prefer real radio/yesno over a mis-tagged combobox for the same screening mappedTo.
        const prev = customControls[idx];
        const acBetter =
          (prev.widgetType === "select" && ac.widgetType === "checkbox" && ac.mappedTo === "pronouns") ||
          (prev.widgetType === "select" &&
            ac.widgetType === "select" &&
            /eeo\[/i.test(String(ac.selector || "")) &&
            !/eeo\[/i.test(String(prev.selector || ""))) ||
          (prev.widgetType === "combobox" && (ac.widgetType === "radio" || ac.widgetType === "yesno")) ||
          (prev.widgetType === "radio" && ac.widgetType === "radio" && !prev.questionLabel && ac.questionLabel);
        if (acBetter) customControls[idx] = ac;
      }
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
        fields.push({
          type: "combobox",
          widgetType: "combobox",
          label,
          name: el.name || "",
          id: el.id || "",
          selector: elementSelector(el, meta),
          required: el.getAttribute("aria-required") === "true",
          filled: comboboxLooksFilled(text, label),
        });
      }
      const contentEditableEls = queryDeep('[contenteditable="true"]').filter(isVisibleEl);
      for (const el of contentEditableEls.slice(0, 8)) {
        const meta = elementMetaWithModal(el, applyModals);
        const label = (
          el.getAttribute("aria-label") ||
          nearbyFieldLabel(el) ||
          (el.innerText || "").trim().slice(0, 60) ||
          "contenteditable"
        ).slice(0, 60);
        const filled = !!(el.innerText || "").trim();
        const selector = elementSelector(el, meta);
        fields.push({
          type: "contenteditable",
          widgetType: "contenteditable",
          label,
          name: "",
          id: el.id || "",
          selector,
          required: false,
          filled,
        });
        // Also expose on customControls so fillCustomControls / interactWidget run.
        if (!customControls.some((c) => c.selector && c.selector === selector && c.widgetType === "contenteditable")) {
          customControls.push({
            type: "contenteditable",
            widgetType: "contenteditable",
            label,
            selector,
            testId: meta.testId || "",
            aria: meta.aria || "",
            filled,
            inApplyModal: meta.inApplyModal,
            score: meta.inApplyModal ? 90 : 70,
          });
        }
      }
      if (fields.length > 24) fields.length = 24;

      const customControlCount = customControls.filter((c) => !c.filled).length;
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
      candidateScoringHelperJs: serializeCandidateScoringForPage().helperJs,
      ...browserPatternArgs(),
    },
  );
}
