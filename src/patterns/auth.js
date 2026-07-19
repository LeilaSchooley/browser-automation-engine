/**
 * Auth/identity patterns — site-agnostic.
 * Per-host overrides: context.authPatterns / siteLearnings.authSelectors.
 */

/** Page text that indicates a login gate (any directory). */
export const LOGIN_WALL_TEXT =
  /\b(you have to be logged in|must be logged in|need to (log|sign) in|log in to (submit|continue|post|comment)|sign in to (submit|continue|post)|login required|please (log|sign) in)\b/i;

/** Signup / register language (buttons, links, CTAs). */
export const SIGNUP_TEXT =
  /\b(sign up with email|create (an |your )?account|register|sign up|get started|join now)\b/i;

/** Job-board modal that requires creating a platform account before applying (Jobright, etc.). */
export const APPLY_SIGNUP_GATE_TEXT =
  /\b(sign[- ]?up to apply|sign up to continue|create (an |your )?account to apply|register to apply|sign up to use autofill)\b/i;

/**
 * Stronger signals that the visible *form* is registration (not a login page
 * that merely links to Sign up / says "get started").
 */
export const SIGNUP_FORM_TEXT =
  /\b(create (an |your )?account|create account|sign[- ]?up with email|registration|new account)\b/i;

/** Login / sign-in language. */
export const SIGN_IN_TEXT =
  /\b(sign in with email|log in with email|sign in|log in|login|continue with email)\b/i;

export const OAUTH_PROVIDER_TEXT =
  /\b((continue|sign|log)\s+(in\s+)?with\s+(x|twitter|google|github|apple|microsoft|facebook|linkedin)|(sign|log)\s+up\s+with\s+(x|twitter|google|github|apple|microsoft|facebook))\b/i;

/** Server-side rejection after a login/signup submit (wrong password / not found). */
export const AUTH_FAILURE_TEXT =
  /\b(that email or password is incorrect|invalid (email|password|credentials)|incorrect password|wrong password|couldn'?t sign you in|login failed|authentication failed|no account found|user not found|account (does not|doesn't) exist|try again)\b/i;

/**
 * Site says this identity already has an account — switch signup → sign-in.
 * Covers error toasts and "Already have an account? Sign in" prompts.
 */
export const EXISTING_ACCOUNT_TEXT =
  /\b(already have an account|account already exists|email (is )?(already )?(taken|registered|in use)|user already exists|already registered|already a member|already signed up|an account with (this|that) email)\b/i;

/** CTA language inviting sign-in for existing members (must not match "Don't have an account?"). */
export const EXISTING_ACCOUNT_SIGNIN_CTA =
  /\b(already (have an )?account|already a member)\b.*\b(sign in|log in)\b|\b(sign in|log in)\b.*\b(already have|existing account)\b/i;

/** Browser-evaluate source for username field detection (no module imports in page). */
export const USERNAME_FIELD_PATTERN_SOURCE =
  String.raw`\b(user[_-]?name|user|login|handle|nickname|screen[_-]?name|member|account|acct)\b|^acct$|^user$|^login$`;

/**
 * Heuristic: field looks like a username/handle (not email).
 * Includes common aliases used across forums/directories (acct, login, handle, …).
 */
export function isUsernameFieldBlob(blob) {
  const b = String(blob || "").toLowerCase();
  if (!b || /email|password|pass|pwd|search|query|q\b|url|website|phone|tel/.test(b)) {
    return false;
  }
  return (
    /\b(user[_-]?name|user|login|handle|nickname|screen[_-]?name|member|account|acct)\b/.test(b) ||
    b === "acct" ||
    b === "user" ||
    b === "login"
  );
}

/** Playwright selectors to try for identity fill (username first, then email). */
export const USERNAME_SELECTORS = [
  'input[autocomplete="username"]',
  'input[name*="user" i]',
  'input[id*="user" i]',
  'input[name*="login" i]',
  'input[id*="login" i]',
  'input[name*="acct" i]',
  'input[id*="acct" i]',
  'input[name*="handle" i]',
  'input[placeholder*="user" i]',
  'input[placeholder*="login" i]',
];

export const EMAIL_SELECTORS = [
  'input[type="email"]',
  'input[name*="email" i]',
  'input[id*="email" i]',
  'input[autocomplete="email"]',
  'input[placeholder*="email" i]',
];

export const PASSWORD_SELECTORS = [
  'input[type="password"][autocomplete="new-password"]',
  'input[type="password"][autocomplete="current-password"]',
  'input[type="password"]',
];

export const LOGIN_SUBMIT_PATTERNS = [
  /^login$/i,
  /^log in$/i,
  /^sign in$/i,
  /^sign in with email$/i,
  /^continue$/i,
];

export const SIGNUP_SUBMIT_PATTERNS = [
  /^create (an )?account$/i,
  /^sign up with email$/i,
  /^sign up to apply$/i,
  /^sign up$/i,
  /^register$/i,
  /^get started$/i,
  /^join$/i,
  /^sign up now$/i,
  /^continue\s*>?$/i,
  /^continue$/i,
  /^next$/i,
];

/** Multi-step registration wizards (JobLeads-style) — Continue after identity/password. */
export const REGISTRATION_CONTINUE_PATTERNS = [
  /^continue\s*>?$/i,
  /^continue$/i,
  /^next$/i,
  /^proceed$/i,
  /^create (an )?account$/i,
  /^sign up$/i,
  /^register$/i,
];

/**
 * Dual auth surface: multiple identity+password pairs (login block + register block).
 * Convention used by many sites: first pair = login, last pair = register.
 */
export function dualAuthPairIndex({ passwordCount = 0, identityCount = 0, preferSignup = false }) {
  if (passwordCount >= 2 || identityCount >= 2) {
    return preferSignup ? Math.max(passwordCount, identityCount) - 1 : 0;
  }
  return 0;
}
