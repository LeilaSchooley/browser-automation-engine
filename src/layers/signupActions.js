/**
 * Detect and complete email/username signup surfaces.
 * Site-agnostic: shared patterns + optional host overrides from learnings.
 */
import {
  attachAccountToContext,
  markAccountVerified,
  resolveAccountForHost,
} from "../accountStore.js";
import { getAuthCredentials, LOGIN_WALL_TEXT, looksLikeAuthFailure, looksLikeAuthForm } from "./authActions.js";
import {
  SIGNUP_TEXT,
  SIGNUP_FORM_TEXT,
  OAUTH_PROVIDER_TEXT,
  SIGNUP_SUBMIT_PATTERNS,
} from "../patterns/index.js";
import { clickRoleMatching, clickSubmitByPatterns } from "./fillPrimitives.js";
import { fillSignupFormFromDom } from "./signupFieldFill.js";
import { authSelectorsFromSignupFields } from "../learningRecorder.js";
import { inspectPage } from "./formDiscovery.js";
import { humanPause } from "../human.js";

async function confirmSignupSucceeded(page, hostname, log) {
  await humanPause(1200, 2000);
  const after = await inspectPage(page);
  if (looksLikeAuthFailure(after)) {
    log?.layer("signup", "signup rejected by site", "warn");
    return false;
  }
  if (looksLikeAuthForm(after) && !looksLikeSignupForm(after)) {
    log?.layer("signup", "still on login wall after signup submit", "warn");
    return false;
  }
  markAccountVerified(hostname);
  return true;
}

export function looksLikeSignupForm(snap) {
  if (!snap) return false;
  if (snap.signupForm) return true;

  const passwords = snap.passwordFieldCount || 0;
  const emails = snap.emailFieldCount || 0;
  const usernames = snap.usernameFieldCount || 0;
  if (passwords === 0 || (emails === 0 && usernames === 0)) return false;

  const blob = `${snap.title || ""} ${snap.applyModalTitle || ""} ${snap.url || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();

  if ((snap.confirmPasswordFieldCount || 0) > 0) return true;
  if ((snap.newPasswordFieldCount || 0) > 0) return true;
  if (usernames > 0 && passwords >= 2) return true;

  if (SIGNUP_FORM_TEXT.test(blob)) return true;
  if (LOGIN_WALL_TEXT.test(blob) && SIGNUP_FORM_TEXT.test(blob)) return true;
  if (usernames > 0 && passwords >= 1 && SIGNUP_FORM_TEXT.test(blob)) return true;

  if ((snap.signUpCount || 0) > 0 && (snap.signInCount || 0) === 0) return true;

  return false;
}

export function isRegistrationSurface(snap) {
  if (!snap || !looksLikeSignupForm(snap)) return false;
  return (
    (snap.confirmPasswordFieldCount || 0) > 0 ||
    (snap.newPasswordFieldCount || 0) > 0 ||
    (snap.passwordFieldCount || 0) >= 2 ||
    (snap.usernameFieldCount || 0) > 0
  );
}

export function looksLikeSignupEntry(snap) {
  if (!snap) return false;
  if ((snap.signUpCount || 0) === 0) return false;
  if (looksLikeSignupForm(snap)) return false;
  return true;
}

export function looksLikeOAuthOnlySignup(snap) {
  if (!snap || looksLikeSignupForm(snap)) return false;
  const blob = [
    snap.title,
    snap.applyModalTitle,
    snap.pageText,
    ...(snap.signUpCandidates || []).map((c) => c.text),
  ]
    .join(" ")
    .toLowerCase();
  return OAUTH_PROVIDER_TEXT.test(blob) && SIGNUP_TEXT.test(blob);
}

export async function clickSignupEntry(page, snap, log) {
  const candidate = snap?.signUpCandidates?.[0];
  if (!candidate) {
    log?.layer("signup", "no signup entry candidate", "warn");
    return false;
  }

  log?.layer("signup", `opening signup: ${candidate.text}`, "info");

  if (await clickRoleMatching(page, SIGNUP_SUBMIT_PATTERNS, { log, layer: "signup" })) {
    return true;
  }

  if (candidate.selector) {
    try {
      const loc = page.locator(candidate.selector).first();
      if (await loc.isVisible({ timeout: 1000 })) {
        await loc.click({ timeout: 8000 });
        return true;
      }
    } catch {
      /* ignore */
    }
  }

  return false;
}

async function checkTermsIfNeeded(page, log) {
  const selectors = [
    'input[type="checkbox"][name*="terms" i]',
    'input[type="checkbox"][name*="agree" i]',
    'input[type="checkbox"][id*="terms" i]',
    'input[type="checkbox"][id*="agree" i]',
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 500 })) {
        const checked = await loc.isChecked();
        if (!checked) {
          await loc.check({ timeout: 3000 });
          log?.layer("signup", "accepted terms checkbox", "debug");
        }
        return true;
      }
    } catch {
      /* next */
    }
  }
  return false;
}

/**
 * Prefer the register pair when dual login/register surfaces exist (last pair = signup).
 * @returns {Promise<{ ok: boolean, learnings?: { authSelectors?: Record<string, string[]> } }>}
 */
export async function attemptAuthSignup(page, snap, context, log) {
  const hostname = snap?.hostname || new URL(page.url()).hostname;
  const account = resolveAccountForHost(context, hostname);
  if (!account) {
    log?.layer("signup", "could not provision account for host", "warn");
    return { ok: false };
  }

  attachAccountToContext(context, account);
  const { email, username, password } = getAuthCredentials(context);
  const fullName = context?.profile?.founderName || context?.profile?.startupName || "Founder";

  log?.layer("signup", `creating account ${username || email} on ${hostname}`, "info");

  const fillResult = await fillSignupFormFromDom(
    page,
    { email, username, password, fullName },
    { log },
  );

  log?.layer(
    "signup",
    `discovered ${fillResult.fields.length} fields: ${fillResult.fields.map((f) => f.kind).join(", ")}`,
    "info",
  );

  if (!fillResult.complete) {
    log?.layer(
      "signup",
      `fill incomplete — missing: ${fillResult.missing.join(", ") || "identity/password"}`,
      "warn",
    );
    return { ok: false };
  }

  await checkTermsIfNeeded(page, log);

  const authSelectors = authSelectorsFromSignupFields(fillResult.fields);
  const learnings =
    Object.keys(authSelectors).length > 0 ? { authSelectors } : undefined;

  if (await clickRoleMatching(page, SIGNUP_SUBMIT_PATTERNS, { log, layer: "signup", roles: ["button"] })) {
    const ok = await confirmSignupSucceeded(page, hostname, log);
    return { ok, learnings: ok ? learnings : undefined };
  }
  if (await clickSubmitByPatterns(page, SIGNUP_SUBMIT_PATTERNS, { log, layer: "signup", preferLast: true })) {
    const ok = await confirmSignupSucceeded(page, hostname, log);
    return { ok, learnings: ok ? learnings : undefined };
  }

  try {
    const submits = page.locator('input[type="submit"], button[type="submit"]');
    const count = await submits.count();
    if (count >= 2) {
      await submits.nth(count - 1).click({ timeout: 8000 });
      log?.layer("signup", "clicked last submit (register pair)", "info");
      const ok = await confirmSignupSucceeded(page, hostname, log);
      return { ok, learnings: ok ? learnings : undefined };
    }
    if (count === 1) {
      await submits.first().click({ timeout: 8000 });
      const ok = await confirmSignupSucceeded(page, hostname, log);
      return { ok, learnings: ok ? learnings : undefined };
    }
  } catch {
    /* ignore */
  }

  log?.layer("signup", "could not find signup button", "warn");
  return { ok: false };
}

export function scoreSignUpCandidate(meta) {
  const blob = `${meta.text} ${meta.testId} ${meta.aria} ${meta.href}`.toLowerCase();
  if (!SIGNUP_TEXT.test(blob) && !/\b(signup|sign-up|register|join)\b/.test(blob)) return 0;
  if (OAUTH_PROVIDER_TEXT.test(blob) && !/email/.test(blob)) return 0;
  let score = 55;
  if (/sign up with email|create account/.test(blob)) score += 75;
  if (/^sign up$|create account|^register$/i.test((meta.text || "").trim())) score += 45;
  if (meta.tag === "a" && /signup|register|join/.test(meta.href || "")) score += 55;
  if (meta.tag === "button" || meta.role === "button" || meta.tag === "input") score += 20;
  if (/\bsign in\b|\blog in\b/.test(blob) && !/sign up/.test(blob)) score -= 40;
  return score;
}
