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
import { isResumeChoiceStep, snapSuggestsFileUpload } from "../heuristics.js";
import { rankEntryCandidates, entryCandidateKey } from "./pageIntent.js";

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

async function clickInModal(page, candidate, log, layer, label, { force = false } = {}) {
  const dialog = page
    .locator("[role='dialog'][aria-modal='true'], .ui-modal, [data-testid^='umja-'], [data-testid*='modal' i]")
    .first();

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
    const snippet = candidate.text.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    attempts.push(async () => {
      const loc = dialog.getByText(new RegExp(snippet, "i")).first();
      if (!(await loc.isVisible({ timeout: 1500 }).catch(() => false))) return false;
      await loc.click({ timeout: 8000, force });
      log.layer(layer, `${label}: modal click text "${candidate.text.slice(0, 50)}"`, "info");
      return true;
    });
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

  if (inModal || candidate.inApplyModal) {
    if (await clickInModal(page, candidate, log, layer, label, { force })) return true;
  }

  const attempts = [];

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
    const escaped = candidate.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40);
    if (escaped.length >= 2) {
      for (const role of ["button", "link"]) {
        attempts.push(async () => {
          const loc = page.getByRole(role, { name: new RegExp(escaped, "i") }).first();
          if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) return false;
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ timeout: 8000, force });
          log.layer(layer, `${label}: clicked role=${role} "${candidate.text.slice(0, 50)}"`, "info");
          return true;
        });
      }
    }
  }

  if (candidate.aria && !/close dialog/i.test(candidate.aria)) {
    attempts.push(async () => {
      const loc = page.getByLabel(candidate.aria).first();
      if (!(await loc.isVisible({ timeout: 1200 }).catch(() => false))) return false;
      await loc.click({ timeout: 8000, force });
      log.layer(layer, `${label}: clicked aria-label "${candidate.aria}"`, "info");
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

  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 40);
  for (const role of ["button", "link"]) {
    try {
      const loc = page.getByRole(role, { name: new RegExp(escaped, "i") }).first();
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
export async function performGenericAct(page, plan, { snap = null, log = null, sessionId = null, layer = "agent" } = {}) {
  const action = (plan.action || "").toLowerCase();
  const item = Number.isInteger(plan.elementIndex)
    ? (snap?.interactives || []).find((i) => i.index === plan.elementIndex)
    : null;
  const targetStr = (plan.target || "").trim();

  switch (action) {
    case "click": {
      if (item) {
        const ok = await clickCandidate(page, item, log, layer, "act-click");
        if (ok) return { ok: true };
      }
      if (targetStr) {
        return { ok: await clickTargetCandidate(page, targetStr, log, layer) };
      }
      return { ok: false };
    }

    case "fill": {
      const value = String(plan.value ?? "").trim();
      if (!value) return { ok: false };
      const locators = [];
      if (item?.selector) locators.push(() => page.locator(item.selector).first());
      if (targetStr) {
        if (looksLikeCssSelector(targetStr)) {
          locators.push(() => page.locator(targetStr).first());
        } else {
          locators.push(() => page.getByLabel(targetStr).first());
          locators.push(() => page.getByPlaceholder(targetStr).first());
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

export async function clickDiscoveredModalStep(page, log, layer = "agent", snap = null, sessionId = null) {
  const state = snap || (await inspectPage(page));
  const candidates = state.modalCandidates || [];

  const success = (candidate) => ({
    ok: true,
    selector: candidate?.selector || (candidate?.testId ? `[data-testid="${candidate.testId}"]` : ""),
  });

  if (isResumeChoiceStep(state) || candidates.some((c) => /have a resume|option-upload/i.test(`${c.testId} ${c.text}`))) {
    log.layer(layer, "modal: resume choice step — click before upload", "info");
    for (const c of candidates) {
      if (/close dialog|^x$|need a resume|resume builder/i.test(c.aria || c.text || "")) continue;
      if (await clickCandidate(page, c, log, layer, "modal", { inModal: true })) return success(c);
      if (await clickCandidate(page, c, log, layer, "modal-force", { inModal: true, force: true })) return success(c);
    }
  }

  if (state.fileInputCount > 0 || snapSuggestsFileUpload(state)) {
    log.layer(layer, "modal: upload flow detected — use setInputFiles", "debug");
    const uploaded = await uploadDiscoveredFile(page, log, layer, state, sessionId);
    if (uploaded) return { ok: true, selector: "input[type=file]" };
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
    if (await clickCandidate(page, c, log, layer, "modal", { inModal: true })) return success(c);
    if (await clickCandidate(page, c, log, layer, "modal-force", { inModal: true, force: true })) return success(c);
  }

  return { ok: false };
}

/** Upload file via file input (setInputFiles) — never click the overlay button. */
export async function uploadDiscoveredFile(page, log, layer = "agent", snap = null, sessionId = null) {
  const state = snap || (await inspectPage(page));
  const file = await getRuntime().resolveFileUpload(sessionId, log);
  if (!file.ok) {
    log.layer(layer, "upload: no file available from resolveFileUpload", "warn");
    return false;
  }

  if (file.generated) {
    log.layer(layer, `upload: auto-generated file at ${file.path}`, "info");
  }

  const fromScan = (state.fileInputCandidates || []).map((f) => f.selector).filter(Boolean);
  const selectors = await discoverFileSelectors(page, state);
  const merged = [...new Set([...selectors, ...fromScan, 'input[type="file"]'])];

  for (const sel of merged) {
    try {
      const loc = state.hasApplyModal
        ? page.locator("[role='dialog'], .ui-modal, [aria-modal='true']").locator(sel).first()
        : page.locator(sel).first();

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
    if (await clickCandidate(page, c, log, layer, "continue")) return true;
  }
  return false;
}
