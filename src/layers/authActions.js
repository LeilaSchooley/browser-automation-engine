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
  EXISTING_ACCOUNT_TEXT,
  EXISTING_ACCOUNT_SIGNIN_CTA,
  USERNAME_SELECTORS,
  EMAIL_SELECTORS,
  PASSWORD_SELECTORS,
  LOGIN_SUBMIT_PATTERNS,
  dualAuthPairIndex,
  CAPTCHA_TEXT,
  TWO_FACTOR_TEXT,
} from "../patterns/index.js";
import { isOauthProviderHost } from "./applyUrlSafety.js";
import { fillFirstVisible, fillFirstVisibleTracked, clickRoleMatching, clickSubmitByPatterns } from "./fillPrimitives.js";
import { inspectPage } from "./formDiscovery.js";
import { humanPause } from "../human.js";
import { markAccountLoginFailed } from "../accountStore.js";
import { safeTextLocator } from "../primitives/safeLocator.js";

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

/**
 * Passwordless login surface (magic-link / email-code): a "Log in" / "Sign in" titled
 * page with a single email/username field and a Continue/Verify button, no password.
 * e.g. account.ycombinator.com. Must not be a full registration form.
 */
export function looksLikePasswordlessLoginSurface(snap) {
  if (!snap) return false;
  if ((snap.passwordFieldCount || 0) > 0) return false;
  if ((snap.fieldCount || 0) > 2) return false;
  const hasIdentity =
    (snap.emailFieldCount || 0) > 0 ||
    (snap.usernameFieldCount || 0) > 0 ||
    (snap.fields || []).some((f) => {
      const t = `${f.type || ""} ${f.label || ""} ${f.name || ""}`.toLowerCase();
      return /email|username|user\s*id|ycid/.test(t);
    });
  if (!hasIdentity) return false;
  const hasContinue =
    (snap.continueCandidates || []).length > 0 ||
    (snap.signInCount || 0) > 0 ||
    (snap.submitCandidates || []).length > 0;
  if (!hasContinue) return false;
  // Prefer title/headings for the login signal — page nav can mention "sign in".
  const titleBlob = `${snap.title || ""} ${snap.headings || ""}`.toLowerCase();
  if (/\blog\s?in\b|\bsign\s?in\b|verify code|enter the code/.test(titleBlob)) return true;
  // Fallback for SPA login cards whose title is generic ("Account | Y Combinator") and headings
  // / body text are sparsely captured (YC often reports ~170ch of pageText without the CTA copy).
  const bodyBlob = `${snap.pageText || ""}`.toLowerCase();
  const fieldBlob = (snap.fields || []).map((f) => `${f.label || ""} ${f.name || ""}`).join(" ").toLowerCase();
  const strongPhrase =
    /magic link|enter the code|one[- ]time code|log\s?in to|sign\s?in to|passwordless/.test(bodyBlob) ||
    /username or email|email or username/.test(fieldBlob);
  const hasSignupSwitch =
    (snap.signUpCount || 0) > 0 || /create an account|don'?t have an account/.test(bodyBlob);
  if (strongPhrase && hasSignupSwitch) return true;
  // Tiny identity+Continue card on an account.* host (YC Work at a Startup gate).
  const host = String(snap.hostname || "").toLowerCase();
  const continueToApply = /continue=.*apply\.|account\./i.test(String(snap.url || ""));
  if (
    (host.startsWith("account.") || continueToApply) &&
    (snap.fieldCount || 0) === 1 &&
    strongPhrase
  ) {
    return true;
  }
  return false;
}

function hasEmailIdentityField(snap) {
  if ((snap.emailFieldCount || 0) > 0) return true;
  return (snap.fields || []).some((f) => {
    const t = `${f.type || ""} ${f.label || ""} ${f.name || ""}`.toLowerCase();
    return f.type === "email" || /email/.test(t);
  });
}

/** True when the page offers an email Continue / password path (not SSO-only). */
export function hasEmailAuthPath(snap) {
  if (!snap) return false;
  if (hasEmailIdentityField(snap)) return true;
  const continues = snap.continueCandidates || [];
  if (continues.some((c) => /^continue$/i.test(String(c.text || "").trim()))) return true;
  if (continues.some((c) => /\b(continue with email|sign in with email)\b/i.test(String(c.text || "")))) {
    return true;
  }
  const blob = `${snap.pageText || ""} ${continues.map((c) => c.text).join(" ")}`;
  return /\b(email address|continue with email|sign in with email)\b/i.test(blob);
}

export function looksLikeAuthFailure(snap) {
  if (!snap) return false;
  // Existing-account errors are handled separately (switch to sign-in, don't treat as wrong password).
  if (looksLikeExistingAccount(snap)) return false;
  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  return AUTH_FAILURE_TEXT.test(blob);
}

/**
 * Site says the identity already has an account (toast/error) or shows "Already have an account?".
 */
export function looksLikeExistingAccount(snap) {
  if (!snap) return false;
  const blob = [
    snap.title,
    snap.applyModalTitle,
    snap.pageText,
    snap.headings,
    ...(snap.signInCandidates || []).map((c) => c.text),
    ...(snap.continueCandidates || []).map((c) => c.text),
    ...(snap.dismissCandidates || []).map((c) => c.text),
    ...(snap.interactives || []).map((i) => `${i.text || ""} ${i.aria || ""}`),
  ]
    .filter(Boolean)
    .join(" ");
  return EXISTING_ACCOUNT_TEXT.test(blob) || EXISTING_ACCOUNT_SIGNIN_CTA.test(blob);
}

/** Strong error toast — email already registered / account exists (not just a Sign in link). */
export function looksLikeExistingAccountError(snap) {
  if (!snap) return false;
  const blob = `${snap.title || ""} ${snap.applyModalTitle || ""} ${snap.pageText || ""} ${snap.headings || ""}`;
  return /\b(email (is )?(already )?(taken|registered|in use)|account already exists|user already exists|already registered|already signed up|an account with (this|that) email)\b/i.test(
    blob,
  );
}

/** Prompt/CTA to switch to sign-in (often next to Sign up). */
export function looksLikeExistingAccountSignInPrompt(snap) {
  if (!snap) return false;
  const blob = snapBlob(snap);
  // "Don't have an account? Create…" is the opposite — never treat as sign-in prompt.
  if (/\bdon'?t have an account\b/i.test(blob) && !/\balready (have an )?account\b/i.test(blob)) {
    return false;
  }
  if ((snap.signInCount || 0) > 0 && EXISTING_ACCOUNT_SIGNIN_CTA.test(blob)) return true;
  if ((snap.signInCount || 0) > 0 && /\balready (have an )?account\b|\balready a member\b/i.test(blob)) {
    return true;
  }
  return false;
}

function snapBlob(snap) {
  return [
    snap.title,
    snap.applyModalTitle,
    snap.pageText,
    snap.headings,
    ...(snap.signInCandidates || []).map((c) => c.text),
    ...(snap.signUpCandidates || []).map((c) => c.text),
  ]
    .filter(Boolean)
    .join(" ");
}

export function looksLikeOAuthOnly(snap) {
  if (!snap || looksLikeAuthForm(snap)) return false;
  // Email field or exact Continue (Indeed) means SSO buttons are optional, not exclusive.
  if (hasEmailAuthPath(snap)) return false;
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

/** Soft OTP: on-page code field present — do not hard-stop (enter_otp handles it). */
export function looksLikeSoftOtpGate(snap) {
  if (!snap) return false;
  const blob = `${snap.title || ""} ${snap.pageText || ""} ${snap.headings || ""}`.toLowerCase();
  if (!TWO_FACTOR_TEXT.test(blob) && !/enter the code|verify code|from your email|one[- ]time/.test(blob)) {
    return false;
  }
  const fields = snap.fields || [];
  const hasCodeish = fields.some((f) => {
    const t = `${f.type || ""} ${f.label || ""} ${f.name || ""} ${f.autocomplete || ""}`.toLowerCase();
    return /otp|one[-_]?time|totp|verification|security.?code|passcode/.test(t) || /code/.test(t);
  });
  if (hasCodeish) return true;
  return (
    (snap.fieldCount || 0) >= 1 &&
    (snap.fieldCount || 0) <= 2 &&
    (snap.passwordFieldCount || 0) === 0 &&
    /enter the code|verify code|from your email|one[- ]time|otp/.test(blob)
  );
}

export function looksLikeHardGate(snap) {
  if (isOauthProviderHost(snap?.url || snap?.hostname || "")) {
    return {
      hard: true,
      reason: "third-party SSO (Apple/Google/…) — use email Continue on the job site",
    };
  }
  const blob = `${snap?.title || ""} ${snap?.pageText || ""} ${snap?.headings || ""} ${snap?.url || ""}`.toLowerCase();
  if (CAPTCHA_TEXT.test(blob)) {
    return { hard: true, reason: "CAPTCHA / human verification" };
  }
  // Soft OTP walls (fillable code field) → enter_otp; hard-stop only when no field.
  if (TWO_FACTOR_TEXT.test(blob)) {
    if (looksLikeSoftOtpGate(snap)) {
      return { hard: false, reason: "OTP wall — soft enter_otp path", softOtp: true };
    }
    return { hard: true, reason: "2FA / OTP required" };
  }
  if (looksLikeOAuthOnly(snap) && (snap.passwordFieldCount || 0) === 0) {
    return { hard: true, reason: "OAuth-only sign-in" };
  }
  return { hard: false, reason: "" };
}

/**
 * True when we have host-scoped login credentials for THIS site — not the applicant
 * profile email alone. Profile identity is for signup/smart_fill; site login requires
 * context.auth bound to the current host (via attachAccountToContext / ensureAccount)
 * or an explicit password on context.auth after host attach.
 */
export function hasAuthCredentials(context, hostname = "") {
  const auth = context?.auth || {};
  const password = auth.password;
  if (!password) return false;

  const host = String(hostname || context?.siteAccount?.hostname || "").toLowerCase();
  const site = context?.siteAccount;
  if (site && (site.email || site.username) && site.password) {
    // Reject failed / unverified leftovers when asking "do we already have a login?"
    if (site.lastLoginFailedAt && !site.verified) return false;
    if (host) {
      const siteHost = String(site.hostname || site.host || "").toLowerCase();
      if (siteHost && siteHost !== host && !host.endsWith(`.${siteHost}`) && !siteHost.endsWith(`.${host}`)) {
        return false;
      }
    }
    return true;
  }

  // context.auth only counts when it was attached for a site account (not bare profile).
  if (auth.provisioned || auth.fromSiteAccount) {
    return Boolean((auth.email || auth.username) && password);
  }
  return false;
}

export function getAuthCredentials(context) {
  const auth = context?.auth || {};
  const site = context?.siteAccount || {};
  const profile = context?.profile || {};
  // Prefer site-scoped identity; fall back to profile email only for fill values, not login gate.
  return {
    email: auth.email || site.email || profile.email || "",
    username: auth.username || site.username || "",
    password: auth.password || site.password || "",
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
  const identity = email || username;
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
  const fieldBlob = (snap?.fields || [])
    .map((f) => `${f.label || ""} ${f.name || ""} ${f.placeholder || ""}`)
    .join(" ")
    .toLowerCase();
  // YC "Username or email" is counted as usernameField — still prefer a real email.
  const combinedIdentityField = /username or email|email or username|email\s*\/\s*username|ycid/.test(
    fieldBlob,
  );
  const siteKnowsEmail = Boolean(context?.siteAccount?.existsOnSite && email);
  const preferEmail =
    Boolean(email) &&
    ((snap?.emailFieldCount || 0) > 0 ||
      (snap?.usernameFieldCount || 0) === 0 ||
      combinedIdentityField ||
      siteKnowsEmail);
  if (!preferEmail && (username || (snap?.usernameFieldCount || 0) > 0)) {
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

export { scoreSignInCandidate } from "./perception/candidateScoring.js";

const SIGNIN_ENTRY_PATTERNS = [
  /already have an account/i,
  /already a member/i,
  /have an account\??/i,
  /sign in now/i,
  /^sign in$/i,
  /^log in$/i,
  /sign in with email/i,
];

/** Resolve only a same-site, non-SSO login destination. */
export function resolveSameSiteSignInUrl(rawHref, currentUrl) {
  if (!rawHref || !currentUrl) return "";
  try {
    const current = new URL(String(currentUrl));
    const target = new URL(String(rawHref), current);
    if (target.origin !== current.origin) return "";
    if (isOauthProviderHost(target.href)) return "";
    if (!/\/(?:login|log-in|signin|sign-in|session)(?:\/|$)/i.test(target.pathname)) return "";
    return target.href;
  } catch {
    return "";
  }
}

async function discoverSameSiteSignInUrl(page, currentUrl) {
  try {
    const href = await page.locator("a[href]").evaluateAll((links) => {
      const match = links.find((link) => {
        const text = String(link.textContent || link.getAttribute("aria-label") || "").trim();
        const hrefValue = String(link.getAttribute("href") || "");
        return (
          /sign in|log in|login/i.test(text) &&
          /\/(?:login|log-in|signin|sign-in|session)(?:\/|$|\?)/i.test(hrefValue) &&
          !/linkedin|google|apple|facebook|github|microsoft|twitter|oauth/i.test(
            `${text} ${hrefValue}`,
          )
        );
      });
      return match?.getAttribute("href") || "";
    });
    return resolveSameSiteSignInUrl(href, currentUrl);
  } catch {
    return "";
  }
}

/** Switch Sign up → Sign in when we already have a verified site account. */
export async function clickSignInEntry(page, snap, log) {
  // Never follow magic-link CTAs from the passwordless login card — that loops OTP.
  const candidates = (snap?.signInCandidates || []).filter(
    (c) => !/magic link|email me a (code|link)|send (me )?(a )?code/i.test(String(c.text || "")),
  );
  const candidate = candidates[0] || null;
  log?.layer("auth", `opening sign in: ${candidate?.text || "Sign in"}`, "info");

  // Prefer the actual same-site login href. Clicking a nested text node can report success
  // while leaving registration open (WWR), which otherwise creates a click_signin loop.
  const currentUrl = page.url();
  const directUrl =
    resolveSameSiteSignInUrl(candidate?.href, currentUrl) ||
    (await discoverSameSiteSignInUrl(page, currentUrl));
  if (directUrl && directUrl !== currentUrl) {
    try {
      await page.goto(directUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
      log?.layer("auth", `opened same-site login URL: ${new URL(directUrl).pathname}`, "info");
      return true;
    } catch (err) {
      log?.layer("auth", `login URL navigation failed: ${err?.message || err}`, "warn");
    }
  }

  if (candidate?.selector) {
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

  if (await clickRoleMatching(page, SIGNIN_ENTRY_PATTERNS, { log, layer: "auth", roles: ["button", "link"] })) {
    return true;
  }

  try {
    const byText = safeTextLocator(
      page,
      /\balready have an account\b|\balready a member\b|\bsign in now\b/i,
    ).first();
    if (await byText.isVisible({ timeout: 800 }).catch(() => false)) {
      await byText.click({ timeout: 8000 });
      log?.layer("auth", "clicked existing-account sign-in text", "info");
      return true;
    }
  } catch {
    /* ignore */
  }

  log?.layer("auth", "no sign-in entry candidate", "warn");
  return false;
}

export { LOGIN_WALL_TEXT, SIGN_IN_TEXT, EXISTING_ACCOUNT_TEXT };
