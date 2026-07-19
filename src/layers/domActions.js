/**
 * Click elements discovered by DOM scan — no hardcoded site selectors.
 */
import path from "path";
import { humanPause, humanType } from "../human.js";
import { gotoWithCloudflareRetry } from "../cloudflare.js";
import { loadSiteMappings } from "../siteMappings.js";
import { getRuntime } from "../runtime.js";
import { hostnameFromPage, resolveHostMapping } from "../host.js";
import { inspectPage } from "./formDiscovery.js";
import {
  isExpertReviewGate,
  isResumeChoiceStep,
  snapSuggestsFileUpload,
  uploadAlreadySucceeded,
} from "../heuristics.js";
import { dismissInterstitialDialog } from "./adDismiss.js";
import { acceptFundingChoicesConsent } from "./fundingChoices.js";
import { rankEntryCandidates, entryCandidateKey } from "./pageIntent.js";
import { resolveDialogScope } from "./dialogScope.js";
import { isSocialSsoCta } from "./applyUrlSafety.js";
import {
  normalizeRoleName,
  roleNameMatcher,
  safeLabelLocator,
  safeRoleLocator,
  safeTextLocator,
  shouldExactMatchName,
} from "../primitives/safeLocator.js";

function rankFileSelectors(selectors = []) {
  const score = (sel) => {
    const s = String(sel).toLowerCase();
    if (/systemfield_resume|name=".*resume|id=".*resume/i.test(s)) return 100;
    if (/resume|cv/i.test(s)) return 80;
    if (/autofill/i.test(s)) return 20;
    return 50;
  };
  return [...selectors].sort((a, b) => score(b) - score(a));
}

function shouldScopeUploadToDialog(snap) {
  const stack = snap?.dialogStack || [];
  return stack.some((d) => d.inApplyModal) && (snap?.modalCount || 0) > 0;
}

function uploadLocator(page, snap, sel) {
  if (snap?.hasApplyModal && shouldScopeUploadToDialog(snap)) {
    return resolveDialogScope(page, snap, "fill_parent").locator(sel).first();
  }
  return page.locator(sel).first();
}

function modalHintsForHost(hostname) {
  const maps = loadSiteMappings();
  const map = resolveHostMapping(maps, hostname);
  const apply = map?._apply || map?.$apply || {};
  return apply.modalSteps || [];
}

async function clickMappingModalHints(page, log, layer) {
  const hints = modalHintsForHost(hostnameFromPage(page));
  for (const sel of hints) {
    try {
      const loc = page.locator(sel).first();
      if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) continue;
      await loc.click({ timeout: 8000 });
      log.layer(layer, `modal: site_mapping hint \`${sel}\``, "info");
      await humanPause(700, 1400);
      return true;
    } catch {
      /* next */
    }
  }
  return false;
}

async function discoverFileSelectors(page, snap) {
  const fromScan = (snap?.fileInputCandidates || []).map((f) => f.selector).filter(Boolean);
  let fromDom = [];
  try {
    fromDom = await page.evaluate(() => {
      const roots = [
        ...document.querySelectorAll("[role='dialog'], [aria-modal='true'], .ui-modal, dialog"),
        document.body,
      ];
      const seen = new Set();
      const out = [];
      for (const root of roots) {
        if (!root?.querySelectorAll) continue;
        for (const el of root.querySelectorAll('input[type="file"]')) {
          const testId = (el.getAttribute("data-testid") || "").trim();
          const id = (el.getAttribute("id") || "").trim();
          const name = (el.getAttribute("name") || "").trim();
          let sel = 'input[type="file"]';
          if (testId) sel = `[data-testid="${testId}"]`;
          else if (id) sel = `#${CSS.escape(id)}`;
          else if (name) sel = `input[type="file"][name="${name}"]`;
          if (!seen.has(sel)) {
            seen.add(sel);
            out.push(sel);
          }
        }
      }
      return out;
    });
  } catch {
    /* ignore */
  }
  return [...new Set([...fromScan, ...fromDom, 'input[type="file"]'])];
}

async function clickInModal(page, candidate, log, layer, label, { force = false, snap = null } = {}) {
  const dialog = resolveDialogScope(page, snap, "click_wizard");

  const attempts = [];

  if (candidate.testId) {
    attempts.push(async () => {
      const loc = dialog.locator(`[data-testid="${candidate.testId}"]`).first();
      if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) {
        const global = page.getByTestId(candidate.testId).first();
        if (!(await global.isVisible({ timeout: 800 }).catch(() => false))) return false;
        await global.click({ timeout: 8000, force });
      } else {
        await loc.click({ timeout: 8000, force });
      }
      log.layer(layer, `${label}: modal click [testid=${candidate.testId}] "${candidate.text}"`, "info");
      return true;
    });
  }

  if (candidate.text) {
    const nameRe = roleNameMatcher(candidate.text);
    if (nameRe) {
      attempts.push(async () => {
        const loc = safeTextLocator(dialog, candidate.text).first();
        if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) return false;
        await loc.click({ timeout: 8000, force });
        log.layer(layer, `${label}: modal click text "${candidate.text.slice(0, 50)}"`, "info");
        return true;
      });
      for (const role of ["button", "link"]) {
        attempts.push(async () => {
          const loc = safeRoleLocator(dialog, role, candidate.text).first();
          if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) return false;
          await loc.click({ timeout: 8000, force });
          log.layer(layer, `${label}: modal click role=${role} "${candidate.text.slice(0, 50)}"`, "info");
          return true;
        });
      }
    }
  }

  for (const tryClick of attempts) {
    try {
      if (await tryClick()) {
        await humanPause(700, 1400);
        return true;
      }
    } catch (exc) {
      log.layer(layer, `${label}: modal attempt failed (${exc.message})`, "debug");
    }
  }
  return false;
}

export async function clickCandidate(page, candidate, log, layer, label, { force = false, inModal = false } = {}) {
  if (!candidate) return false;

  if (inModal || candidate.inApplyModal || candidate.inModal) {
    if (await clickInModal(page, candidate, log, layer, label, { force })) return true;
  }

  const attempts = [];

  // Prefer stable perception refs (Playwright MCP-style) when present.
  if (candidate.perceptionRef || candidate.refId) {
    attempts.push(async () => {
      const { locatorForRef } = await import("./pagePerception.js");
      const refs = candidate._perceptionRefs || [];
      const loc = locatorForRef(page, candidate.perceptionRef || candidate.refId, refs);
      if (!loc) return false;
      if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) return false;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 8000, force });
      log.layer(layer, `${label}: clicked perception ref ${candidate.perceptionRef || candidate.refId}`, "info");
      return true;
    });
  }

  if (candidate.testId) {
    attempts.push(async () => {
      const loc = page.getByTestId(candidate.testId).first();
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 8000, force });
      log.layer(layer, `${label}: clicked [testid=${candidate.testId}] "${candidate.text}"`, "info");
      return true;
    });
  }

  if (candidate.selector) {
    attempts.push(async () => {
      const loc = page.locator(candidate.selector).first();
      if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) return false;
      await loc.scrollIntoViewIfNeeded().catch(() => {});
      await loc.click({ timeout: 8000, force });
      log.layer(layer, `${label}: clicked \`${candidate.selector}\` "${candidate.text}"`, "info");
      return true;
    });
  }

  if (candidate.text) {
    const nameRe = roleNameMatcher(candidate.text);
    if (nameRe) {
      for (const role of ["button", "link"]) {
        attempts.push(async () => {
          const loc = safeRoleLocator(page, role, candidate.text).first();
          if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) return false;
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ timeout: 8000, force });
          log.layer(layer, `${label}: clicked role=${role} "${candidate.text.slice(0, 50)}"`, "info");
          return true;
        });
      }
      attempts.push(async () => {
        const loc = safeTextLocator(page, candidate.text).first();
        if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) return false;
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 8000, force });
        log.layer(layer, `${label}: clicked text "${candidate.text.slice(0, 50)}"`, "info");
        return true;
      });
    }
  }

  if (candidate.aria && !/close dialog/i.test(candidate.aria)) {
    attempts.push(async () => {
      const loc = safeLabelLocator(page, candidate.aria).first();
      if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) return false;
      await loc.click({ timeout: 8000, force });
      log.layer(layer, `${label}: clicked aria-label "${candidate.aria}"`, "info");
      return true;
    });
  }

  // Last resort for anchor candidates: navigate to the href directly. Handles links whose
  // accessible name carries decorative glyphs ("Apply to role ›") that defeat role/text matching
  // and would otherwise fall through to a weaker candidate ("Apply") on the same page. Resolve
  // relative hrefs (YC role links are like "/companies/…/jobs/…") against the current URL.
  const rawHref = String(candidate.href || "").trim();
  if (rawHref && !/^(mailto:|tel:|javascript:|#)/i.test(rawHref)) {
    attempts.push(async () => {
      let dest = "";
      try {
        dest = new URL(rawHref, page.url()).href;
      } catch {
        return false;
      }
      if (!/^https?:\/\//i.test(dest)) return false;
      await page.goto(dest, { waitUntil: "domcontentloaded", timeout: 15_000 });
      log.layer(layer, `${label}: navigated to href ${dest.slice(0, 90)} "${(candidate.text || "").slice(0, 40)}"`, "info");
      return true;
    });
  }

  for (const tryClick of attempts) {
    try {
      if (await tryClick()) {
        await humanPause(700, 1400);
        await page.waitForLoadState("domcontentloaded").catch(() => {});
        return true;
      }
    } catch (exc) {
      log.layer(layer, `${label}: attempt failed (${exc.message})`, "debug");
    }
  }

  log.layer(layer, `${label}: could not click "${candidate.text || candidate.testId || "?"}"`, "warn");
  return false;
}

export async function clickTargetCandidate(page, target, log, layer = "agent") {
  if (!target?.trim()) return false;
  const t = target.trim();

  if (t.startsWith("[") || t.startsWith("#") || t.startsWith(".")) {
    try {
      const loc = page.locator(t).first();
      if (await loc.isVisible({ timeout: 1500 }).catch(() => false)) {
        await loc.click({ timeout: 8000 });
        log.layer(layer, `target: clicked selector \`${t}\``, "info");
        await humanPause(700, 1400);
        return true;
      }
    } catch {
      /* fall through */
    }
  }

  try {
    const byTestId = page.getByTestId(t).first();
    if (await byTestId.isVisible({ timeout: 1200 }).catch(() => false)) {
      await byTestId.click({ timeout: 8000 });
      log.layer(layer, `target: clicked testid=${t}`, "info");
      await humanPause(700, 1400);
      return true;
    }
  } catch {
    /* fall through */
  }

  const nameRe = normalizeRoleName(t);
  if (nameRe) {
    for (const role of ["button", "link"]) {
      try {
        const loc = safeRoleLocator(page, role, t).first();
        if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
          await loc.click({ timeout: 8000 });
          log.layer(layer, `target: clicked role=${role} "${t.slice(0, 50)}"`, "info");
          await humanPause(700, 1400);
          return true;
        }
      } catch {
        /* next */
      }
    }
  }

  log.layer(layer, `target: could not click "${t.slice(0, 60)}"`, "debug");
  return false;
}

function looksLikeCssSelector(s) {
  return /^[#.[]/.test(s) || /[>~+:]/.test(s) || /^\w+(\.\w|#)/.test(s);
}

/**
 * Generic AI-driven primitive: click / fill / goto / press / scroll on any
 * element, addressed by snapshot interactives index, CSS selector, or text.
 * This is what lets the agent handle flows no step classifier anticipated.
 */
export async function performGenericAct(page, plan, { snap = null, log = null, sessionId = null, layer = "agent", context = null } = {}) {
  const action = (plan.action || "").toLowerCase();
  const item = Number.isInteger(plan.elementIndex)
    ? (snap?.interactives || []).find((i) => i.index === plan.elementIndex)
    : null;
  const targetStr = (plan.target || "").trim();

  switch (action) {
    case "click": {
      if (item) {
        const ok = await clickCandidate(page, item, log, layer, "act-click", {
          inModal: !!(item.inModal || item.inApplyModal),
        });
        if (ok) return { ok: true };
        // Design-system div buttons: text click when roles miss
        if (item.text && item.text.length >= 2) {
          try {
            const loc = safeTextLocator(page, item.text.slice(0, 60)).first();
            if (await loc.isVisible({ timeout: 1200 }).catch(() => false)) {
              await loc.click({ timeout: 6000 });
              log?.layer(layer, `act: clicked text "${item.text.slice(0, 50)}"`, "info");
              return { ok: true };
            }
          } catch {
            /* fall through */
          }
        }
      }
      if (targetStr) {
        return { ok: await clickTargetCandidate(page, targetStr, log, layer) };
      }
      return { ok: false };
    }

    case "fill": {
      const { resolveIdentityFillValue } = await import("../fillProfile.js");
      const { resolvePreferenceFillValue } = await import("../fillPreferences.js");
      const hint = [targetStr, item?.text, item?.aria, item?.kind, item?.label].filter(Boolean).join(" ");
      let value = String(resolveIdentityFillValue(hint, plan.value ?? "", context) || "").trim();
      value = String(resolvePreferenceFillValue(hint, value, context) || "").trim();
      if (!value) return { ok: false };
      const locators = [];
      if (item?.selector) locators.push(() => page.locator(item.selector).first());
      if (targetStr) {
        if (looksLikeCssSelector(targetStr)) {
          locators.push(() => page.locator(targetStr).first());
        } else {
          locators.push(() => safeLabelLocator(page, targetStr).first());
          locators.push(() => page.getByPlaceholder(targetStr, { exact: shouldExactMatchName(targetStr) }).first());
        }
      }
      for (const make of locators) {
        try {
          const loc = make();
          if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) continue;
          if (value.length > 80) {
            await humanType(loc, value, page);
          } else {
            await loc.fill(value, { timeout: 5000 });
          }
          log?.layer(layer, `act: filled "${(item?.text || targetStr).slice(0, 50)}"`, "info");
          return { ok: true };
        } catch {
          /* next */
        }
      }
      log?.layer(layer, `act: could not fill "${targetStr.slice(0, 60)}"`, "warn");
      return { ok: false };
    }

    case "goto": {
      const dest = plan.url || targetStr || (item?.href || "");
      if (!/^https?:/i.test(dest)) return { ok: false };
      log?.layer(layer, `act: goto ${dest.slice(0, 110)}`, "info");
      await gotoWithCloudflareRetry(page, dest, { sessionId });
      return { ok: true };
    }

    case "press": {
      const key = plan.value || "Enter";
      try {
        await page.keyboard.press(key);
        log?.layer(layer, `act: pressed ${key}`, "info");
        return { ok: true };
      } catch {
        return { ok: false };
      }
    }

    case "scroll": {
      const ok = await page
        .evaluate(() => {
          window.scrollBy(0, Math.round((window.innerHeight || 800) * 0.8));
          return true;
        })
        .catch(() => false);
      if (ok) log?.layer(layer, "act: scrolled down", "debug");
      return { ok: !!ok };
    }

    case "select": {
      const value = String(plan.value ?? "").trim();
      if (!value) return { ok: false };
      const locators = [];
      if (item?.selector) locators.push(() => page.locator(item.selector).first());
      if (targetStr) {
        if (looksLikeCssSelector(targetStr)) {
          locators.push(() => page.locator(targetStr).first());
        } else {
          locators.push(() => safeLabelLocator(page, targetStr).first());
          locators.push(() => page.locator(`select:has-text("${value}")`).first());
        }
      }
      for (const make of locators) {
        try {
          const loc = make();
          if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) continue;
          await loc.selectOption({ label: value }).catch(async () => {
            await loc.selectOption({ value });
          });
          log?.layer(layer, `act: selected "${value.slice(0, 50)}"`, "info");
          return { ok: true };
        } catch {
          /* try combobox path */
        }
      }
      const comboboxLocators = [];
      if (item?.selector) comboboxLocators.push(() => page.locator(item.selector).first());
      if (targetStr) {
        if (looksLikeCssSelector(targetStr)) {
          comboboxLocators.push(() => page.locator(targetStr).first());
        } else {
          comboboxLocators.push(() => safeRoleLocator(page, "combobox", targetStr));
          comboboxLocators.push(() => safeTextLocator(page, targetStr));
        }
      }
      for (const make of comboboxLocators) {
        try {
          const trigger = make();
          if (!(await trigger.isVisible({ timeout: 1500 }).catch(() => false))) continue;
          await trigger.click({ timeout: 3000 });
          const option = safeRoleLocator(page, "option", value).first();
          if (await option.isVisible({ timeout: 2000 }).catch(() => false)) {
            await option.click({ timeout: 3000 });
            log?.layer(layer, `act: combobox selected "${value.slice(0, 50)}"`, "info");
            return { ok: true };
          }
        } catch {
          /* next */
        }
      }
      return { ok: false };
    }

    case "check":
    case "uncheck": {
      const wantChecked = action === "check";
      const locators = [];
      if (item?.selector) locators.push(() => page.locator(item.selector).first());
      if (targetStr) {
        if (looksLikeCssSelector(targetStr)) {
          locators.push(() => page.locator(targetStr).first());
        } else {
          locators.push(() => safeLabelLocator(page, targetStr).first());
          locators.push(() => safeRoleLocator(page, "checkbox", targetStr).first());
        }
      }
      for (const make of locators) {
        try {
          const loc = make();
          if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) continue;
          if (wantChecked) await loc.check({ timeout: 4000 });
          else await loc.uncheck({ timeout: 4000 });
          log?.layer(layer, `act: ${action} "${(item?.text || targetStr).slice(0, 50)}"`, "info");
          return { ok: true };
        } catch {
          /* next */
        }
      }
      return { ok: false };
    }

    case "upload": {
      // Prefer indexed file input; fall back to discovery.
      if (item && (item.kind === "file" || /file/i.test(item.kind || "") || item.tag === "input")) {
        const ok = await uploadDiscoveredFile(page, log, layer, snap, sessionId, {
          preferredSelector: item.selector || "",
          preferredTestId: item.testId || "",
        });
        return { ok };
      }
      return { ok: await uploadDiscoveredFile(page, log, layer, snap, sessionId) };
    }

    default:
      return { ok: false };
  }
}

export async function clickDiscoveredCookie(page, log, layer = "page_prep", snap = null) {
  const state = snap || (await inspectPage(page));
  if (state.hasApplyModal) {
    log.layer(layer, "cookie: skipped — apply modal is open", "debug");
    return false;
  }

  if (await acceptFundingChoicesConsent(page, log, layer)) return true;

  for (const c of state.cookieCandidates || []) {
    if (/close dialog/i.test(c.aria || c.text || "")) continue;
    if (await clickCandidate(page, c, log, layer, "cookie")) return true;
  }
  return false;
}

export async function clickDiscoveredEntry(page, log, layer = "page_prep", snap = null, context = {}) {
  const state = snap || (await inspectPage(page));

  if (state.hasApplyModal) {
    log.layer(layer, "entry: skipped — apply modal already open", "debug");
    return false;
  }

  if (!state.hasApplyModal) {
    await page.evaluate(() => window.scrollTo(0, Math.min(400, document.body?.scrollHeight || 400))).catch(() => {});
  }

  const candidates = rankEntryCandidates(state.entryCandidates, context);
  if (!candidates.length) {
    log.layer(layer, "entry: DOM scan found no apply/interested controls", "debug");
    return false;
  }

  log.layer(layer, `entry: trying ${candidates.length} ranked candidate(s) from DOM scan`, "info");

  for (const c of candidates) {
    if (await clickCandidate(page, c, log, layer, "entry")) return true;
    if (await clickCandidate(page, c, log, layer, "entry-force", { force: true })) return true;
  }

  return false;
}

export async function clickDiscoveredModalStep(page, log, layer = "agent", snap = null, sessionId = null, history = []) {
  const state = snap || (await inspectPage(page));
  const candidates = state.modalCandidates || [];
  const uploaded = uploadAlreadySucceeded(history);

  const success = (candidate) => ({
    ok: true,
    selector: candidate?.selector || (candidate?.testId ? `[data-testid="${candidate.testId}"]` : ""),
  });

  if ((uploaded || isExpertReviewGate(state)) && (state.modalCount > 0 || state.hasApplyModal)) {
    log.layer(layer, "modal: resume uploaded — trying skip/dismiss before re-clicking wizard", "info");
    if (await dismissInterstitialDialog(page, log, layer)) return { ok: true, selector: "skip-continue" };
  }

  if (isResumeChoiceStep(state) || candidates.some((c) => /have a resume|option-upload/i.test(`${c.testId} ${c.text}`))) {
    log.layer(layer, "modal: resume choice step — click before upload", "info");
    for (const c of candidates) {
      if (/close dialog|^x$|need a resume|resume builder/i.test(c.aria || c.text || "")) continue;
      if (await clickCandidate(page, c, log, layer, "modal", { inModal: true })) return success(c);
      if (await clickCandidate(page, c, log, layer, "modal-force", { inModal: true, force: true })) return success(c);
    }
  }

  if ((state.fileInputCount > 0 || snapSuggestsFileUpload(state)) && !uploaded) {
    log.layer(layer, "modal: upload flow detected — use setInputFiles", "debug");
    const uploadedNow = await uploadDiscoveredFile(page, log, layer, state, sessionId);
    if (uploadedNow) return { ok: true, selector: "input[type=file]" };
  }

  if (uploaded && isExpertReviewGate(state)) {
    log.layer(layer, "modal: expert review gate after upload — dismiss only", "info");
    if (await dismissInterstitialDialog(page, log, layer)) return { ok: true, selector: "skip-continue" };
    return { ok: false };
  }

  if (!candidates.length) {
    log.layer(layer, "modal: no wizard steps found in DOM scan", "debug");
    const hinted = await clickMappingModalHints(page, log, layer);
    return { ok: Boolean(hinted) };
  }

  log.layer(
    layer,
    `modal: "${state.applyModalTitle || "dialog"}" — trying ${candidates.length} step(s)`,
    "info",
  );

  for (const c of candidates) {
    if (/close dialog|^x$/i.test(c.aria || c.text || "")) continue;
    if (uploaded && /upload resume|upload cv|attach/i.test(`${c.text || ""} ${c.aria || ""}`)) continue;
    if (await clickCandidate(page, c, log, layer, "modal", { inModal: true })) return success(c);
    if (await clickCandidate(page, c, log, layer, "modal-force", { inModal: true, force: true })) return success(c);
  }

  return { ok: false };
}

/** Upload file via file input (setInputFiles) — never click the overlay button. */
export async function uploadDiscoveredFile(page, log, layer = "agent", snap = null, sessionId = null, options = {}) {
  const state = snap || (await inspectPage(page));
  const file = await getRuntime().resolveFileUpload(sessionId, log);
  if (!file.ok) {
    log.layer(layer, "upload: no file available from resolveFileUpload", "warn");
    return false;
  }

  if (file.generated) {
    log.layer(layer, `upload: auto-generated file at ${file.path}`, "info");
  }

  const preferred = [options.preferredSelector, options.preferredTestId ? `[data-testid="${options.preferredTestId}"]` : ""]
    .filter(Boolean);
  const fromScan = (state.fileInputCandidates || []).map((f) => f.selector).filter(Boolean);
  const selectors = await discoverFileSelectors(page, state);
  const merged = rankFileSelectors([...new Set([...preferred, ...selectors, ...fromScan, 'input[type="file"]'])]);

  for (const sel of merged) {
    try {
      const loc = uploadLocator(page, state, sel);

      if (!(await loc.count())) continue;

      await loc.setInputFiles(file.path, { timeout: 15000 });
      log.layer(layer, `upload: attached ${path.basename(file.path)} → ${sel}`, "info");
      await humanPause(1200, 2200);
      return true;
    } catch (exc) {
      log.layer(layer, `upload: skip ${sel} (${exc.message})`, "debug");
    }
  }

  log.layer(layer, "upload: no file input accepted the file", "warn");
  return false;
}

/** @deprecated use uploadDiscoveredFile */
export const uploadDiscoveredResume = uploadDiscoveredFile;

export async function clickDiscoveredContinue(page, log, layer = "agent", snap = null) {
  const state = snap || (await inspectPage(page));

  if (state.hasApplyModal && state.modalCandidates?.length) {
    const modal = await clickDiscoveredModalStep(page, log, layer, state);
    return modal.ok;
  }

  for (const c of state.continueCandidates || []) {
    if ((c.text || "").length > 80) continue;
    if (isSocialSsoCta(c.text || c.aria || "")) continue;
    if (await clickCandidate(page, c, log, layer, "continue")) return true;
  }
  return false;
}
