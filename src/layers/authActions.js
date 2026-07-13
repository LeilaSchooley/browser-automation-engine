/**
 * Detect and complete login surfaces (email or username + password).
 * Site-agnostic: uses shared patterns + optional host overrides from learnings.
 */
import {
  attachAccountToContext,
  resolveAccountForHost,
} from "../accountStore.js";
import { hostKey } from "../host.js";
import { loadSiteLearnings, stableAuthSelector } from "../siteLearnings.js";
import {
  LOGIN_WALL_TEXT,
  OAUTH_PROVIDER_TEXT,
  SIGN_IN_TEXT,
  AUTH_FAILURE_TEXT,
  USERNAME_SELECTORS,
  EMAIL_SELECTORS,
  PASSWORD_SELECTORS,
  LOGIN_SUBMIT_PATTERNS,
  dualAuthPairIndex,
  CAPTCHA_TEXT,
  TWO_FACTOR_TEXT,
} from "../patterns/index.js";
import { fillFirstVisible, fillFirstVisibleTracked, clickRoleMatching, clickSubmitByPatterns } from "./fillPrimitives.js";
import { inspectPage } from "./formDiscovery.js";
import { humanPause } from "../human.js";
import { markAccountLoginFailed } from "../accountStore.js";

/** Merge default selectors with context/learnings overrides (modular per host). */
export function resolveAuthSelectors(context, hostname, kind) {
  const defaults =
    kind === "username"
      ? USERNAME_SELECTORS
      : kind === "email"
        ? EMAIL_SELECTORS
        : PASSWORD_SELECTORS;

  const fromContext = context?.authPatterns?.[kind];
  const learned = loadSiteLearnings()?.[hostKey(hostname)]?.authSelectors?.[kind];
  const extra = [
    ...(Array.isArray(fromContext) ? fromContext : []),
    ...(Array.isArray(learned) ? learned : []),
  ];
  return [...extra, ...defaults];
}

export function looksLikeAuthForm(snap) {
  if (!snap) return false;
  if (snap.authForm) return true;
  const passwords = snap.passwordFieldCount || 0;
  const emails = snap.emailFieldCount || 0;
  const usernames = snap.usernameFieldCount || 0;
  if (passwords > 0 && (emails > 0 || usernames > 0)) return true;
  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  return passwords > 0 && LOGIN_WALL_TEXT.test(blob);
}

export function looksLikeAuthFailure(snap) {
  if (!snap) return false;
  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  return AUTH_FAILURE_TEXT.test(blob);
}

export function looksLikeOAuthOnly(snap) {
  if (!snap || looksLikeAuthForm(snap)) return false;
  const blob = [
    snap.title,
    snap.applyModalTitle,
    snap.pageText,
    ...(snap.signInCandidates || []).map((c) => c.text),
    ...(snap.entryCandidates || []).map((c) => c.text),
  ]
    .join(" ")
    .toLowerCase();
  return OAUTH_PROVIDER_TEXT.test(blob) && /\b(sign in|log in)\b/i.test(blob);
}

export function looksLikeHardGate(snap) {
  const blob = `${snap?.title || ""} ${snap?.pageText || ""} ${snap?.headings || ""}`.toLowerCase();
  if (CAPTCHA_TEXT.test(blob)) {
    return { hard: true, reason: "CAPTCHA / human verification" };
  }
  if (TWO_FACTOR_TEXT.test(blob)) {
    return { hard: true, reason: "2FA / OTP required" };
  }
  if (looksLikeOAuthOnly(snap) && (snap.passwordFieldCount || 0) === 0) {
    return { hard: true, reason: "OAuth-only sign-in" };
  }
  return { hard: false, reason: "" };
}

export function hasAuthCredentials(context) {
  const auth = context?.auth || {};
  const profile = context?.profile || {};
  const identity = auth.username || auth.email || profile.email;
  const password = auth.password;
  return Boolean(identity && password);
}

export function getAuthCredentials(context) {
  const auth = context?.auth || {};
  const profile = context?.profile || {};
  return {
    email: auth.email || profile.email || "",
    username: auth.username || "",
    password: auth.password || "",
  };
}

/**
 * Fill the login pair when dual login/register surfaces exist (first pair = login).
 * @returns {Promise<{ ok: boolean, learnings?: { authSelectors?: Record<string, string[]> } }>}
 */
export async function attemptAuthLogin(page, snap, context, log) {
  const hostname = snap?.hostname || "";
  const authSelectorsUsed = {};
  const trackSelector = (kind, selector, meta = {}) => {
    if (!kind || !selector) return;
    const stable = stableAuthSelector(selector, { kind, ...meta });
    if (!stable) return;
    authSelectorsUsed[kind] = [...new Set([...(authSelectorsUsed[kind] || []), stable])];
  };

  let account = null;
  if (!hasAuthCredentials(context) && hostname) {
    account = resolveAccountForHost(context, hostname, { provision: false });
    if (account) attachAccountToContext(context, account);
  }

  const { email, username, password } = getAuthCredentials(context);
  const identity = username || email;
  if (!identity || !password) {
    log?.layer("auth", "no credentials configured", "warn");
    return { ok: false };
  }

  log?.layer("auth", `attempting login as ${identity}`, "info");

  const passwordFields = page.locator('input[type="password"]');
  const pwCount = await passwordFields.count().catch(() => 0);
  const identityLoc = page.locator(resolveAuthSelectors(context, hostname, "username").join(", "));
  const identityCount = await identityLoc.count().catch(() => 0);
  const pairIndex = dualAuthPairIndex({
    passwordCount: pwCount,
    identityCount,
    preferSignup: false,
  });

  let filledIdentity = false;
  if (username || (snap?.usernameFieldCount || 0) > 0) {
    if (identityCount > pairIndex) {
      try {
        await identityLoc.nth(pairIndex).fill(username || identity, { timeout: 5000 });
        filledIdentity = true;
        trackSelector("username", `input[type="text"]:nth-of-type(${pairIndex + 1})`, { kind: "username" });
      } catch {
        /* fallback */
      }
    }
    if (!filledIdentity) {
      const r = await fillFirstVisibleTracked(
        page,
        resolveAuthSelectors(context, hostname, "username"),
        username || identity,
        { log, layer: "auth", label: "username" },
      );
      filledIdentity = r.ok;
      if (r.ok) trackSelector("username", r.selector, { kind: "username" });
    }
  }
  if (!filledIdentity) {
    const r = await fillFirstVisibleTracked(
      page,
      resolveAuthSelectors(context, hostname, "email"),
      email || identity,
      { log, layer: "auth", label: "email" },
    );
    filledIdentity = r.ok;
    if (r.ok) trackSelector("email", r.selector, { kind: "email" });
  }
  if (!filledIdentity) {
    const r = await fillFirstVisibleTracked(page, ['input[type="text"]'], identity, {
      log,
      layer: "auth",
      label: "identity",
    });
    filledIdentity = r.ok;
    if (r.ok) trackSelector("username", r.selector, { kind: "username" });
  }

  let filledPassword = false;
  if (pwCount > pairIndex) {
    try {
      const pw = passwordFields.nth(pairIndex);
      await pw.click({ timeout: 3000 });
      await pw.fill(password, { timeout: 5000 });
      filledPassword = true;
      trackSelector("password", 'input[type="password"]', { kind: "password" });
      log?.layer("auth", "filled password", "debug");
    } catch {
      /* fallback */
    }
  }
  if (!filledPassword) {
    const r = await fillFirstVisibleTracked(
      page,
      resolveAuthSelectors(context, hostname, "password"),
      password,
      { log, layer: "auth", label: "password" },
    );
    filledPassword = r.ok;
    if (r.ok) trackSelector("password", r.selector, { kind: "password" });
  }

  if (!filledIdentity || !filledPassword) {
    log?.layer("auth", `fill incomplete (id=${filledIdentity} password=${filledPassword})`, "warn");
    return { ok: false };
  }

  let clicked = false;
  if (await clickRoleMatching(page, LOGIN_SUBMIT_PATTERNS, { log, layer: "auth", roles: ["button"] })) {
    clicked = true;
  } else if (await clickSubmitByPatterns(page, LOGIN_SUBMIT_PATTERNS, { log, layer: "auth" })) {
    clicked = true;
  } else {
    try {
      const submit = page.locator('button[type="submit"], input[type="submit"]').nth(pairIndex);
      if (await submit.isVisible({ timeout: 1000 })) {
        await submit.click({ timeout: 8000 });
        log?.layer("auth", "clicked submit control", "info");
        clicked = true;
      }
    } catch {
      /* ignore */
    }
  }

  if (!clicked) {
    log?.layer("auth", "could not find sign-in button", "warn");
    return { ok: false };
  }

  await humanPause(1000, 1800);
  const after = await inspectPage(page);
  if (looksLikeAuthFailure(after) || (looksLikeAuthForm(after) && looksLikeAuthFailure(after))) {
    log?.layer("auth", "login rejected by site — will try signup", "warn");
    if (hostname) markAccountLoginFailed(hostname);
    return { ok: false };
  }
  if (looksLikeAuthForm(after)) {
    log?.layer("auth", "still on login form after submit", "warn");
    if (hostname) markAccountLoginFailed(hostname);
    return { ok: false };
  }

  const learnings =
    Object.keys(authSelectorsUsed).length > 0 ? { authSelectors: authSelectorsUsed } : undefined;
  return { ok: true, learnings };
}

export function scoreSignInCandidate(meta) {
  const blob = `${meta.text} ${meta.testId} ${meta.aria}`.toLowerCase();
  if (!SIGN_IN_TEXT.test(blob) && !/\bsign in\b|\blog in\b|^login$/i.test(blob)) return 0;
  if (OAUTH_PROVIDER_TEXT.test(blob) && !/email/.test(blob)) return 0;
  let score = 50;
  if (/sign in with email|log in with email/.test(blob)) score += 80;
  if (meta.tag === "button" || meta.role === "button" || meta.tag === "input") score += 20;
  if (/magic link/.test(blob)) score -= 30;
  return score;
}

export { LOGIN_WALL_TEXT, SIGN_IN_TEXT };
