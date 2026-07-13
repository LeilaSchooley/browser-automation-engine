/**
 * Post-signup platform onboarding (Jobright diagnostics wizard, etc.).
 */
import { normalizeHost } from "./host.js";
import { safeRoleLocator, safeTextLocator } from "./primitives/safeLocator.js";

const ONBOARDING_URL_RE = /\/onboarding(-v\d+)?\//i;
const ONBOARDING_BODY_RE =
  /\b(what type of role|job function|job type|open to remote|your jobright ai copilot|orion)\b/i;

/** Jobright welcome confirm after onboarding — "Confirm & See Jobs". */
const WELCOME_CONFIRM_BODY_RE =
  /\b(welcome!\s*we found|roles that fit you|confirm\s*&\s*see jobs|making sure everything looks right)\b/i;

export function looksLikePlatformOnboarding(snap) {
  if (!snap) return false;
  const url = String(snap.url || "");
  const host = normalizeHost(snap.hostname || url);
  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  if (/jobright\.ai$/i.test(host) && ONBOARDING_URL_RE.test(url)) return true;
  if (ONBOARDING_URL_RE.test(url) && ONBOARDING_BODY_RE.test(blob)) return true;
  return ONBOARDING_BODY_RE.test(blob) && (snap.continueCount || 0) > 0;
}

/**
 * Jobright "Welcome! We found N roles" modal — must Confirm before applying.
 */
export function looksLikeJobBoardWelcomeConfirm(snap) {
  if (!snap) return false;
  const blob = [
    snap.title,
    snap.applyModalTitle,
    snap.pageText,
    snap.headings,
    ...(snap.continueCandidates || []).map((c) => c.text),
    ...(snap.confirmCandidates || []).map((c) => c.text),
    ...(snap.modalCandidates || []).map((c) => c.text),
    ...(snap.submitCandidates || []).map((c) => c.text),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (WELCOME_CONFIRM_BODY_RE.test(blob)) return true;

  const hasConfirmCta = [...(snap.continueCandidates || []), ...(snap.confirmCandidates || []), ...(snap.submitCandidates || [])].some(
    (c) => /confirm\s*&\s*see|confirm and see|see jobs/i.test(c.text || ""),
  );
  return hasConfirmCta && /welcome|fit you best|experience level/i.test(blob);
}

export function welcomeConfirmCta(snap) {
  const pools = [
    ...(snap.continueCandidates || []),
    ...(snap.confirmCandidates || []),
    ...(snap.submitCandidates || []),
    ...(snap.modalCandidates || []),
  ];
  return (
    pools.find((c) => /confirm\s*&\s*see|confirm and see jobs|see jobs/i.test(c.text || "")) ||
    pools.find((c) => /^confirm$/i.test((c.text || "").trim())) ||
    null
  );
}

/** True while the onboarding wizard still needs checkbox defaults and/or Next. */
export function platformOnboardingIncomplete(snap, fillResult = null) {
  if (!looksLikePlatformOnboarding(snap)) return false;
  if ((snap.continueCount || 0) === 0) return false;

  const titleFilled = (fillResult?.filled || []).some(
    (f) => f.type === "desiredtitle" || /job function|job title/i.test(`${f.label || ""} ${f.selector || ""}`),
  );
  const titleField = (snap.fields || []).find((f) =>
    /job function|expected job function|job title/i.test(`${f.label || ""} ${f.placeholder || ""}`),
  );
  const titleEmpty = titleField && !titleField.filled && !titleFilled;

  return titleEmpty || (snap.continueCount || 0) > 0;
}

/** Tick common Jobright onboarding defaults before Continue/Next. */
export async function tickOnboardingDefaults(page, log) {
  const targets = [
    { name: /full[- ]?time/i },
    { name: /open to remote/i },
  ];
  for (const { name } of targets) {
    try {
      const loc = safeRoleLocator(page, "checkbox", name).first();
      if (!(await loc.isVisible({ timeout: 600 }).catch(() => false))) continue;
      const checked = await loc.isChecked().catch(() => false);
      if (!checked) {
        await loc.check({ timeout: 4000 });
        log?.layer("onboarding", `checked ${name}`, "info");
      }
    } catch {
      /* next */
    }
  }
  return true;
}

/** Click Jobright welcome Confirm & See Jobs (and leave experience levels as-is). */
export async function clickWelcomeConfirm(page, snap, log) {
  const cta = welcomeConfirmCta(snap);
  if (cta?.selector) {
    try {
      const loc = page.locator(cta.selector).first();
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        await loc.click({ timeout: 8000 });
        log?.layer("onboarding", `clicked welcome confirm: ${cta.text}`, "info");
        return true;
      }
    } catch {
      /* fallback */
    }
  }

  const patterns = [/^confirm\s*&\s*see jobs$/i, /^confirm and see jobs$/i, /^confirm$/i];
  for (const pattern of patterns) {
    try {
      const btn = safeRoleLocator(page, "button", pattern).first();
      if (await btn.isVisible({ timeout: 600 }).catch(() => false)) {
        await btn.click({ timeout: 8000 });
        log?.layer("onboarding", `clicked welcome confirm: ${pattern}`, "info");
        return true;
      }
    } catch {
      /* next */
    }
  }

  try {
    const byText = safeTextLocator(page, /confirm\s*&\s*see jobs/i).first();
    if (await byText.isVisible({ timeout: 600 }).catch(() => false)) {
      await byText.click({ timeout: 8000 });
      log?.layer("onboarding", "clicked welcome confirm via text", "info");
      return true;
    }
  } catch {
    /* ignore */
  }

  log?.layer("onboarding", "welcome confirm CTA not found", "warn");
  return false;
}

/** Jobright post-apply tracker: "Did you apply?" — answer No/Not yet so we keep applying. */
const DID_YOU_APPLY_RE = /\bdid you apply\b|\balready applied\b|\bhave you applied\b/i;

export function looksLikeDidYouApplyPrompt(snap) {
  if (!snap) return false;
  const texts = [
    snap.applyModalTitle,
    snap.pageText,
    snap.headings,
    snap.title,
    ...(snap.modalCandidates || []).map((c) => c.text),
    ...(snap.continueCandidates || []).map((c) => c.text),
    ...(snap.dismissCandidates || []).map((c) => c.text),
    ...(snap.interactives || []).map((i) => `${i.text || ""} ${i.aria || ""}`),
    ...(snap.overlayHints || []),
  ]
    .filter(Boolean)
    .map((t) => String(t));
  const blob = texts.join(" ");
  if (DID_YOU_APPLY_RE.test(blob)) {
    return (
      (snap.modalCount || 0) > 0 ||
      snap.hasApplyModal ||
      snap.hasBlockingOverlay ||
      /\bnot yet\b|\byes\b/i.test(blob)
    );
  }
  // Fallback: Yes + Not yet pair on Jobright apply surface (title often not in pageText scrape)
  const labels = texts
    .flatMap((t) => t.split(/\n|\|/))
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  const hasYes = labels.some((t) => /^(yes|yes,? i applied|i applied)$/i.test(t));
  const hasNotYet = labels.some((t) => /^(not yet|no|haven'?t applied|i('ll| will) apply later)$/i.test(t));
  if (hasYes && hasNotYet && (snap.hasApplyModal || (snap.modalCount || 0) > 0)) {
    const host = String(snap.hostname || snap.url || "");
    if (/jobright\.ai/i.test(host)) return true;
  }
  return false;
}

export function didYouApplyDeclineCta(snap) {
  const pools = [
    ...(snap.dismissCandidates || []),
    ...(snap.continueCandidates || []),
    ...(snap.modalCandidates || []),
    ...(snap.interactives || []),
  ];
  const prefer = [
    /not yet/i,
    /i('ll| will) apply later/i,
    /no[, ]?not yet/i,
    /^no$/i,
    /haven'?t applied/i,
    /skip/i,
  ];
  for (const re of prefer) {
    const hit = pools.find((c) => re.test(String(c.text || c.aria || "").trim()));
    if (hit) return hit;
  }
  return null;
}

export async function clickDidYouApplyDecline(page, snap, log) {
  const cta = didYouApplyDeclineCta(snap);
  const patterns = [
    /^not yet$/i,
    /i('ll| will) apply later/i,
    /haven'?t applied/i,
    /^no$/i,
    /^no[, ]?thanks$/i,
  ];

  if (cta?.selector) {
    try {
      const loc = page.locator(cta.selector).first();
      if (await loc.isVisible({ timeout: 800 }).catch(() => false)) {
        await loc.click({ timeout: 8000 });
        log?.layer("onboarding", `did-you-apply: clicked "${cta.text || cta.aria}"`, "info");
        return true;
      }
    } catch {
      /* fallback */
    }
  }

  for (const pattern of patterns) {
    for (const role of ["button", "link"]) {
      try {
        const btn = safeRoleLocator(page, role, pattern).first();
        if (!(await btn.isVisible({ timeout: 500 }).catch(() => false))) continue;
        await btn.click({ timeout: 8000 });
        log?.layer("onboarding", `did-you-apply: clicked ${role} ${pattern}`, "info");
        return true;
      } catch {
        /* next */
      }
    }
  }

  try {
    const dialog = page.locator('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="Modal" i]').filter({ hasText: DID_YOU_APPLY_RE }).first();
    const root = (await dialog.isVisible({ timeout: 600 }).catch(() => false)) ? dialog : page;
    for (const pattern of patterns) {
      const hosts = root.locator('button, a, [role="button"], [class*="button" i], [class*="btn" i], span, div');
      const n = Math.min(await hosts.count().catch(() => 0), 40);
      let best = null;
      let bestLen = Infinity;
      for (let i = 0; i < n; i += 1) {
        const el = hosts.nth(i);
        if (!(await el.isVisible({ timeout: 80 }).catch(() => false))) continue;
        const text = ((await el.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        if (!text || text.length > 40) continue;
        if (!pattern.test(text)) continue;
        if (text.length < bestLen) {
          best = el;
          bestLen = text.length;
        }
      }
      if (best) {
        const label = ((await best.innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();
        await best.click({ timeout: 8000 });
        log?.layer("onboarding", `did-you-apply: clicked "${label}" (text host)`, "info");
        return true;
      }
      const byText = safeTextLocator(root, pattern).first();
      if (await byText.isVisible({ timeout: 300 }).catch(() => false)) {
        await byText.click({ timeout: 8000 });
        log?.layer("onboarding", `did-you-apply: clicked text ${pattern}`, "info");
        return true;
      }
    }
  } catch {
    /* ignore */
  }

  // Last resort: evaluate-click leftmost non-Yes action in dialog
  try {
    const hit = await page.evaluate(() => {
      const root =
        [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="Modal" i]')].find((el) =>
          /did you apply/i.test(el.innerText || ""),
        ) || document.body;
      const nodes = [...root.querySelectorAll("button, a, [role='button'], [class*='button' i], span, div")];
      const prefer = [/not yet/i, /haven'?t/i, /^no$/i, /later/i];
      for (const re of prefer) {
        for (const el of nodes) {
          const t = (el.innerText || "").replace(/\s+/g, " ").trim();
          if (!t || t.length > 40) continue;
          if (!re.test(t)) continue;
          el.click();
          return t;
        }
      }
      return null;
    });
    if (hit) {
      log?.layer("onboarding", `did-you-apply: evaluate-clicked "${hit}"`, "info");
      return true;
    }
  } catch {
    /* ignore */
  }

  log?.layer("onboarding", "did-you-apply decline CTA not found", "warn");
  return false;
}
