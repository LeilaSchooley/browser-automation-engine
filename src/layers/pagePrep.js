import { humanPause } from "../human.js";
import { loadSiteMappings } from "../siteMappings.js";
import { hostnameFromUrl, resolveHostMapping } from "../host.js";
import { clickDiscoveredCookie, clickDiscoveredEntry } from "./domActions.js";
import { dismissBlockingOverlays } from "./adDismiss.js";
import { acceptFundingChoicesConsent } from "./fundingChoices.js";
import { inspectPage, logPageSnapshot, looksLikeApplyForm } from "./formDiscovery.js";
import { isPageUnloaded, waitForApplySurface } from "./pageReady.js";

function applyConfig(hostname, siteMappings) {
  const map = resolveHostMapping(siteMappings, hostname) || {};
  const apply = map._apply || map.$apply || {};
  return {
    cookieAccept: [...(apply.cookieAccept || []), ...(apply.cookies || [])],
    entry: [...(apply.entry || []), ...(apply.entryButtons || []), ...(apply.apply || [])],
    dismiss: apply.dismiss || [],
  };
}

async function clickMappingHint(page, selectors, log, label) {
  for (const sel of selectors || []) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 800 })) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 8000 });
        log.layer("page_prep", `${label}: site_mapping hint \`${sel}\``, "info");
        await humanPause(700, 1400);
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

export async function runPagePrepRound(page, url, log, { mode = "all" } = {}) {
  const siteMappings = loadSiteMappings();
  const hostname = hostnameFromUrl(url);
  const cfg = applyConfig(hostname, siteMappings);

  log.layer(
    "page_prep",
    `host=${hostname || "?"} mode=${mode} mapping hints: cookies=${cfg.cookieAccept.length} entry=${cfg.entry.length}`,
  );

  const actions = [];
  let snap = await inspectPage(page);

  if (mode === "all" || mode === "dismiss") {
    let hit = await dismissBlockingOverlays(page, log, "page_prep", snap);
    if (!hit && cfg.dismiss?.length) {
      hit = await clickMappingHint(page, cfg.dismiss, log, "dismiss");
    }
    if (hit) {
      actions.push("dismiss");
      await humanPause(800, 1400);
      snap = await inspectPage(page);
    } else if (snap.hasBlockingOverlay) {
      log.layer("page_prep", "overlay: detected but could not dismiss", "warn");
    }
  }

  if (mode === "all" || mode === "cookies") {
    let hit = await acceptFundingChoicesConsent(page, log, "page_prep");
    if (!hit) hit = await clickDiscoveredCookie(page, log, "page_prep");
    if (!hit && cfg.cookieAccept.length) {
      hit = await clickMappingHint(page, cfg.cookieAccept, log, "cookie");
    }
    if (hit) {
      actions.push("cookies");
      await humanPause(1200, 2000);
      snap = await inspectPage(page);
    } else {
      log.layer("page_prep", "cookie: none found in DOM scan", "debug");
    }
  }

  if (mode === "all" || mode === "entry") {
    snap = await inspectPage(page);
    let hit = await clickDiscoveredEntry(page, log, "page_prep", snap);
    if (!hit && cfg.entry.length) {
      hit = await clickMappingHint(page, cfg.entry, log, "entry");
    }
    if (hit) {
      actions.push("entry");
    } else if (snap.entryCount > 0) {
      log.layer("page_prep", `entry: ${snap.entryCount} candidate(s) in DOM but click failed`, "warn");
    } else {
      log.layer("page_prep", "entry: no apply/interested control in DOM scan", "debug");
    }
  }

  return { actions, hostname };
}

const MAX_PREP_ROUNDS = 3;

export async function preparePageForApply(page, url, log) {
  log.step("page_prep", "Preparing page (DOM scan: ads/overlays → cookies → apply entry)…");

  const allActions = [];
  let lastFieldCount = -1;
  let entryClicked = false;

  for (let round = 1; round <= MAX_PREP_ROUNDS; round++) {
    let snap = await inspectPage(page);
    if (round === 1 && isPageUnloaded(snap)) {
      snap = await waitForApplySurface(page, log, { timeoutMs: 15000 });
    }
    logPageSnapshot(log, snap, "page_prep");

    if (looksLikeApplyForm(snap, 2)) {
      log.layer("page_prep", `form detected (${snap.fieldCount} fields) — prep complete`, "info");
      break;
    }

    const stuckOnListing = snap.entryCount > 0 && !entryClicked;
    if (snap.fieldCount === lastFieldCount && round > 1 && !stuckOnListing) {
      log.layer("page_prep", "no new fields after last round — stopping prep", "debug");
      break;
    }
    lastFieldCount = snap.fieldCount;

    log.layer("page_prep", `round ${round}/${MAX_PREP_ROUNDS}`, "info");
    const { actions } = await runPagePrepRound(page, url, log);
    allActions.push(...actions);
    if (actions.includes("entry")) entryClicked = true;

    if (!actions.length && !stuckOnListing) {
      log.layer("page_prep", "no actions taken this round — stopping", "debug");
      break;
    }

    await humanPause(1200, 2200);
  }

  const finalSnap = await inspectPage(page);
  logPageSnapshot(log, finalSnap, "page_prep");

  return {
    actions: allActions,
    hostname: finalSnap.hostname,
    fieldCount: finalSnap.fieldCount,
    hasForm: looksLikeApplyForm(finalSnap, 1),
    pageKind: finalSnap.pageKind,
    entryCount: finalSnap.entryCount,
    entryCandidates: finalSnap.entryCandidates,
  };
}

export { hostnameFromUrl, applyConfig };
