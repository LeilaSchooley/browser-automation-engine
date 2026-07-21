/**
 * Auth wall state machine — one signup attempt, hard switch to sign-in on
 * “account already exists”, never re-fill the same register form in a loop.
 */
import { humanPause } from "../human.js";
import { inspectPage, pageFingerprint } from "./formDiscovery.js";
import {
  attemptAuthLogin,
  clickSignInEntry,
  looksLikeAuthForm,
  looksLikeExistingAccountError,
} from "./authActions.js";
import { attemptAuthSignup, looksLikeSignupForm } from "./signupActions.js";
import {
  resolveAuthPreference,
  shouldForceSignIn,
  ensureAccount,
} from "./authFlowPolicy.js";
import {
  detectAuthWallFromSnap,
  countAuthAttemptsOnPage,
  historySaysAccountExists,
} from "../patterns/authWall.js";
import { markAccountExists } from "../accountStore.js";

/**
 * @param {import('playwright').Page} page
 * @param {object} snap
 */
export async function detectAuthWall(page, snap = null) {
  const working = snap || (await inspectPage(page).catch(() => null));
  return detectAuthWallFromSnap(working);
}

/**
 * Handle register/login wall. At most one auth attempt per page fingerprint;
 * on already-exists → switch to sign-in once then hand off if still stuck.
 *
 * @param {import('playwright').Page} page
 * @param {object} snap
 * @param {object} context
 * @param {object|null} log
 * @param {{ history?: object[] }} [opts]
 * @returns {Promise<{
 *   handled: boolean,
 *   mode?: 'login'|'register'|'handoff'|'skip',
 *   ok?: boolean,
 *   existingAccount?: boolean,
 *   handoff?: boolean,
 *   reason?: string,
 *   snap?: object,
 *   learnings?: object,
 * }>}
 */
export async function handleAuthWall(page, snap, context, log = null, opts = {}) {
  const history = opts.history || [];
  const state = detectAuthWallFromSnap(snap);
  if (!state.isAuthWall) {
    log?.layer?.("auth_wall", `skip — ${state.reason || "not_auth"}`, "debug");
    return { handled: false, reason: state.reason || "not_auth" };
  }

  log?.layer?.(
    "auth_wall",
    `detected (${state.reason}) register=${state.isRegister} login=${state.isLogin} exists=${state.alreadyExists}`,
    "info",
  );

  const fp = pageFingerprint(snap);
  const attempts = countAuthAttemptsOnPage(history, fp);
  const forceSignIn =
    shouldForceSignIn(snap, history, context) ||
    state.alreadyExists ||
    historySaysAccountExists(history) ||
    looksLikeExistingAccountError(snap);

  // Burned the budget on this page → clean handoff (stops WWR 4-step death spiral).
  if (attempts >= 1 && forceSignIn) {
    // Allow exactly one login after a prior signup that reported exists.
    const hadLogin = (history || []).some(
      (h) => h.action === "auth_login" && (h.fingerprint === fp || !fp),
    );
    if (hadLogin || attempts >= 2) {
      log?.layer?.(
        "auth_wall",
        "auth wall exhausted on this page — handoff (no more signup/login loops)",
        "warn",
      );
      return {
        handled: true,
        mode: "handoff",
        ok: false,
        handoff: true,
        existingAccount: forceSignIn,
        reason: "auth_wall_exhausted",
        snap,
      };
    }
  }

  if (attempts >= 2) {
    log?.layer?.("auth_wall", "too many auth attempts on page — handoff", "warn");
    return {
      handled: true,
      mode: "handoff",
      ok: false,
      handoff: true,
      reason: "auth_wall_max_attempts",
      snap,
    };
  }

  ensureAccount(context, snap?.hostname || "");

  // Hard switch: account exists → sign-in only (never re-register).
  if (forceSignIn) {
    if (snap?.hostname) markAccountExists(snap.hostname);
    log?.layer?.("auth_wall", "account exists — switching to sign-in", "info");

    let working = snap;
    if (!looksLikeAuthForm(working) || looksLikeSignupForm(working)) {
      const switched = await clickSignInEntry(page, working, log).catch(() => false);
      if (switched) {
        await humanPause(800, 1400);
        working = await inspectPage(page).catch(() => working);
      }
    }

    const login = await attemptAuthLogin(page, working, context, log);
    const after = await inspectPage(page).catch(() => working);
    const stillAuth =
      looksLikeAuthForm(after) || looksLikeSignupForm(after) || detectAuthWallFromSnap(after).isAuthWall;

    if (login.ok && !stillAuth) {
      return {
        handled: true,
        mode: "login",
        ok: true,
        existingAccount: true,
        snap: after,
        learnings: { ...(login.learnings || {}), existingAccount: true },
      };
    }

    // Login filled but still on wall, or click failed — one shot then handoff.
    log?.layer?.(
      "auth_wall",
      stillAuth
        ? "sign-in attempted but still on auth wall — handoff"
        : "sign-in failed — handoff",
      "warn",
    );
    return {
      handled: true,
      mode: "handoff",
      ok: false,
      handoff: true,
      existingAccount: true,
      reason: stillAuth ? "auth_wall_still_present" : "auth_login_failed",
      snap: after,
      learnings: { existingAccount: true, ...(login.learnings || {}) },
    };
  }

  const pref = resolveAuthPreference(snap, history, context);
  if (pref.prefer === "auth" || pref.prefer === "signin" || state.isLogin) {
    if (pref.prefer === "signin" && !looksLikeAuthForm(snap)) {
      await clickSignInEntry(page, snap, log).catch(() => false);
      await humanPause(800, 1400);
    }
    const working = await inspectPage(page).catch(() => snap);
    const login = await attemptAuthLogin(page, working, context, log);
    return {
      handled: true,
      mode: "login",
      ok: Boolean(login.ok),
      snap: await inspectPage(page).catch(() => working),
      learnings: login.learnings,
      handoff: !login.ok,
      reason: login.ok ? "auth_login" : "auth_login_failed",
    };
  }

  if (pref.prefer === "signup" || state.isRegister || looksLikeSignupForm(snap)) {
    log?.layer?.("auth_wall", "register path — one signup attempt", "info");
    const signup = await attemptAuthSignup(page, snap, context, log);
    if (!signup.ok && signup.existingAccount) {
      if (snap?.hostname) markAccountExists(snap.hostname);
      log?.layer?.("auth_wall", "signup → account exists — switching to sign-in", "warn");
      let working = await inspectPage(page).catch(() => snap);
      const switched = await clickSignInEntry(page, working, log).catch(() => false);
      if (switched) {
        await humanPause(800, 1400);
        working = await inspectPage(page).catch(() => working);
      }
      const login = await attemptAuthLogin(page, working, context, log);
      const after = await inspectPage(page).catch(() => working);
      const stillAuth = looksLikeAuthForm(after) || looksLikeSignupForm(after);
      return {
        handled: true,
        mode: login.ok && !stillAuth ? "login" : "handoff",
        ok: Boolean(login.ok && !stillAuth),
        existingAccount: true,
        handoff: stillAuth || !login.ok,
        reason: stillAuth ? "auth_wall_still_present" : "switched_to_signin",
        snap: after,
        learnings: { existingAccount: true, ...(login.learnings || signup.learnings || {}) },
      };
    }
    return {
      handled: true,
      mode: "register",
      ok: Boolean(signup.ok),
      existingAccount: Boolean(signup.existingAccount),
      handoff: !signup.ok,
      reason: signup.ok ? "auth_signup" : "auth_signup_failed",
      snap: await inspectPage(page).catch(() => snap),
      learnings: signup.learnings,
    };
  }

  return { handled: false };
}
