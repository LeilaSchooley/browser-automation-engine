/**
 * Auth-wall detection — register vs login vs “account already exists”.
 * Requires strong evidence; never treat a job listing Apply page as auth.
 * Pure helpers; actuators live in layers/authWall.js.
 */
import {
  EXISTING_ACCOUNT_TEXT,
  EXISTING_ACCOUNT_SIGNIN_CTA,
  SIGNUP_FORM_TEXT,
  LOGIN_WALL_TEXT,
} from "./auth.js";

/** Extra copy from site toasts / signup failures (WWR, etc.). */
export const SWITCH_TO_SIGNIN_TEXT =
  /\b(switch to sign[- ]?in|already (have an )?account|account already exists|email already|user already exists)\b/i;

/** Strong auth URL paths (register/login/account gate). */
export const AUTH_URL_RE =
  /\/(login|log-in|signin|sign-in|register|signup|sign-up|session|sessions|job-seekers\/account|accounts?\/(login|sign|register)|users?\/sign)/i;

/** Strong auth copy (not generic “apply” / job description). */
export const AUTH_COPY_RE =
  /\b(create an account|sign up for free|already have an account|log in to continue|sign in to (apply|continue|view)|you have to be logged in|must be logged in|login required)\b/i;

/** Job listing / detail copy — negative signal when no password field. */
export const JOB_LISTING_COPY_RE =
  /\b(apply for (this |the )?job|apply now|job description|about the (role|job|company)|responsibilities|requirements|what you.?ll (do|build))\b/i;

/**
 * Snap-level auth wall state (no Playwright).
 * @param {object} snap
 * @returns {{
 *   isRegister: boolean,
 *   isLogin: boolean,
 *   alreadyExists: boolean,
 *   isAuthWall: boolean,
 *   reason: string,
 * }}
 */
export function detectAuthWallFromSnap(snap) {
  if (!snap) {
    return {
      isRegister: false,
      isLogin: false,
      alreadyExists: false,
      isAuthWall: false,
      reason: "no_snap",
    };
  }

  const url = String(snap.url || "").toLowerCase();
  const body = `${snap.pageText || ""} ${snap.headings || ""} ${snap.title || ""} ${snap.applyModalTitle || ""}`
    .toLowerCase()
    .slice(0, 4000);

  const passwordCount = Number(snap.passwordFieldCount || 0);
  const emailCount = Number(snap.emailFieldCount || 0);
  const usernameCount = Number(snap.usernameFieldCount || 0);
  const hasPassword = passwordCount > 0;
  const hasIdentity = emailCount > 0 || usernameCount > 0;
  const urlIsAuth = AUTH_URL_RE.test(url);
  const copyIsAuth = AUTH_COPY_RE.test(body) || LOGIN_WALL_TEXT.test(body);

  // Clear Apply CTA + no password → job listing / aggregator, not auth.
  const hasApplyEntry = (snap.entryCount || 0) > 0;
  const looksLikeJobListing =
    !hasPassword &&
    !urlIsAuth &&
    (hasApplyEntry || JOB_LISTING_COPY_RE.test(body) || snap.pageKind === "listing");

  if (looksLikeJobListing) {
    return {
      isRegister: false,
      isLogin: false,
      alreadyExists: false,
      isAuthWall: false,
      reason: "job_listing",
    };
  }

  // Strong surface only: auth URL, or password + (identity | auth copy | stamped authForm).
  const isAuthWall =
    urlIsAuth ||
    (hasPassword && (hasIdentity || copyIsAuth || Boolean(snap.authForm || snap.signupForm))) ||
    (hasPassword && hasIdentity);

  if (!isAuthWall) {
    return {
      isRegister: false,
      isLogin: false,
      alreadyExists: false,
      isAuthWall: false,
      reason: "not_auth",
    };
  }

  const alreadyExists =
    EXISTING_ACCOUNT_TEXT.test(body) ||
    EXISTING_ACCOUNT_SIGNIN_CTA.test(body) ||
    SWITCH_TO_SIGNIN_TEXT.test(body) ||
    /\b(email (is )?(already )?(taken|registered|in use))\b/i.test(body);

  const isRegister =
    /register|sign[- ]?up|create.?account/i.test(url) ||
    SIGNUP_FORM_TEXT.test(body) ||
    Boolean(snap.signupForm) ||
    (hasPassword &&
      ((snap.confirmPasswordFieldCount || 0) > 0 || (snap.newPasswordFieldCount || 0) > 0));

  const isLogin =
    !isRegister &&
    (/login|sign[- ]?in|log[- ]?in|\/session/i.test(url) ||
      (Boolean(snap.authForm) && !snap.signupForm) ||
      (hasPassword && hasIdentity && !isRegister));

  return {
    isRegister,
    isLogin,
    alreadyExists,
    isAuthWall: true,
    reason: urlIsAuth
      ? "auth_url"
      : alreadyExists
        ? "already_exists"
        : hasPassword
          ? "password_form"
          : "strong_auth_surface",
  };
}

/**
 * How many auth attempts already burned on this page fingerprint.
 * @param {object[]} history
 * @param {string} pageHash
 */
export function countAuthAttemptsOnPage(history, pageHash) {
  const fp = String(pageHash || "");
  return (history || []).filter(
    (h) =>
      (h.action === "auth_signup" ||
        h.action === "auth_login" ||
        h.action === "click_signin" ||
        (h.action === "smart_fill" && h.authWall)) &&
      (!fp || h.fingerprint === fp || h.pageHash === fp),
  ).length;
}

/**
 * True when history already saw existing-account on this host/session.
 * @param {object[]} history
 */
export function historySaysAccountExists(history) {
  return (history || []).some(
    (h) =>
      h.existingAccount ||
      h.learnings?.existingAccount ||
      /account already exists|switch to sign/i.test(String(h.reason || "")),
  );
}
