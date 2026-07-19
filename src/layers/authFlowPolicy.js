/**
 * Pure auth/signup preference decisions — shared by classify + actionCatalog.
 * Actuators stay in authActions / signupActions; this file only chooses a path.
 */
import {
  hasAuthCredentials,
  looksLikeAuthForm,
  looksLikePasswordlessLoginSurface,
  looksLikeSoftOtpGate,
  looksLikeExistingAccountError,
  looksLikeExistingAccountSignInPrompt,
} from "./authActions.js";
import {
  canProvisionAccounts,
  resolveAccountForHost,
} from "../accountStore.js";
import {
  looksLikeSignupEntry,
  looksLikeSignupForm,
  isRegistrationSurface,
} from "./signupActions.js";
import { looksLikeApplySignupGate } from "../heuristics.js";

export function loginFailedTwice(history) {
  return (history || []).filter((h) => h.action === "auth_login" && !h.ok).length >= 2;
}

export function shouldPreferSignupForAccount(stored) {
  if (!stored) return false;
  // Site already has this email — stop creating accounts; login (or handoff) instead.
  if (stored.existsOnSite) return false;
  return Boolean(stored.pending || stored.verified === false);
}

export function getAuthFromContext(context) {
  const auth = context?.auth || {};
  const profile = context?.profile || {};
  return {
    email: auth.email || profile.email || "",
    password: auth.password || "",
  };
}

export function ensureAccount(context, hostname) {
  const host = hostname || "";
  // Prefer a real per-host account; never treat bare profile email as "already logged in."
  if (hasAuthCredentials(context, host)) return getAuthFromContext(context);
  const account = resolveAccountForHost(context, host, { provision: canProvisionAccounts(context) });
  if (!account) return null;
  if (context) {
    context.auth = {
      ...(context.auth || {}),
      email: account.email,
      password: account.password,
      username: account.username || "",
      provisioned: true,
      fromSiteAccount: true,
      hostname: host,
    };
    context.siteAccount = { ...account, hostname: host };
  }
  return account;
}

export function signupHistorySaysExists(history) {
  return (history || []).some(
    (h) => h.action === "auth_signup" && (h.existingAccount || h.learnings?.existingAccount),
  );
}

export function authFormIsOpen(snap) {
  return Boolean(looksLikeAuthForm(snap) || (snap?.passwordFieldCount || 0) > 0);
}

/** Prefer disk store, then in-memory context.siteAccount bound to this host. */
export function accountForHost(context, hostname) {
  const stored = resolveAccountForHost(context, hostname, { provision: false });
  if (stored) return stored;
  const site = context?.siteAccount;
  if (!site || !(site.email || site.username) || !site.password) return null;
  const host = String(hostname || "").toLowerCase();
  const siteHost = String(site.hostname || site.host || "").toLowerCase();
  if (
    host &&
    siteHost &&
    siteHost !== host &&
    !host.endsWith(`.${siteHost}`) &&
    !siteHost.endsWith(`.${host}`)
  ) {
    return null;
  }
  return site;
}

export function hasVerifiedSiteLogin(context, hostname, stored = null) {
  const account = stored || accountForHost(context, hostname);
  return Boolean(
    (account &&
      account.verified === true &&
      !shouldPreferSignupForAccount(account) &&
      (account.email || account.username) &&
      account.password) ||
      (hasAuthCredentials(context, hostname) && context?.siteAccount?.verified === true),
  );
}

/**
 * Site says account already exists (error toast / prior signup / verified + soft CTA).
 * Soft "Already have an account?" alone does not override a fresh signup path.
 */
export function shouldForceSignIn(snap, history, context) {
  if (!snap) return false;
  const hostname = snap.hostname || "";
  const stored = accountForHost(context, hostname);
  return (
    signupHistorySaysExists(history) ||
    looksLikeExistingAccountError(snap) ||
    (looksLikeExistingAccountSignInPrompt(snap) &&
      !isRegistrationSurface(snap) &&
      !looksLikePasswordlessLoginSurface(snap) &&
      hasVerifiedSiteLogin(context, hostname, stored))
  );
}

/** Soft OTP / email-code wall visible. */
export function shouldEnterOtp(snap, _history, _context) {
  return looksLikeSoftOtpGate(snap);
}

/** Convenience: true when we should open/create account rather than log in. */
export function shouldPreferSignupPath(snap, history, context) {
  return resolveAuthPreference(snap, history, context).prefer === "signup";
}

/**
 * Consolidated auth/signup preference for classify + catalog scoring.
 * Priority matches the auth classifiers (force sign-in → OTP → passwordless → …).
 *
 * @returns {{ prefer: "signup"|"signin"|"auth"|"otp"|"none", reason: string, step?: string }}
 */
export function resolveAuthPreference(snap, history = [], context = null) {
  if (!snap) return { prefer: "none", reason: "no snap" };

  const force = resolveForceSignInPreference(snap, history, context);
  if (force) return force;

  if (shouldEnterOtp(snap, history, context)) {
    return {
      prefer: "otp",
      reason: "OTP / email verification code — poll inbox or wait for paste",
      step: "enter_otp",
    };
  }

  const passwordless = resolvePasswordlessPreference(snap, context);
  if (passwordless) return passwordless;

  const gate = resolveApplySignupGatePreference(snap, context);
  if (gate) return gate;

  if (isRegistrationSurface(snap) && canProvisionAccounts(context)) {
    return {
      prefer: "signup",
      reason: "registration form — filling all signup fields from DOM",
      step: "signup",
    };
  }

  const signupForm = resolveSignupFormPreference(snap, context);
  if (signupForm) return signupForm;

  const authForm = resolveAuthFormPreference(snap, history, context);
  if (authForm) return authForm;

  return { prefer: "none", reason: "no auth preference" };
}

function resolveForceSignInPreference(snap, history, context) {
  if (!shouldForceSignIn(snap, history, context)) return null;
  // Only actionable paths — fall through so OTP / passwordless can still win.
  if (authFormIsOpen(snap)) {
    return {
      prefer: "auth",
      reason: "site says account already exists — log in",
      step: "auth",
    };
  }
  if ((snap.signInCount || 0) > 0) {
    return {
      prefer: "signin",
      reason: "site says account already exists — open sign in",
      step: "signin_entry",
    };
  }
  return null;
}

function resolvePasswordlessPreference(snap, context) {
  if (!(looksLikePasswordlessLoginSurface(snap) && !looksLikeAuthForm(snap))) return null;

  const hostname = snap.hostname || "";
  const stored = accountForHost(context, hostname);

  if (stored?.existsOnSite) {
    return {
      prefer: "signin",
      reason: "passwordless login — email already registered; continue login (not signup)",
      step: "auth",
    };
  }

  const hasVerifiedCreds =
    hasAuthCredentials(context, hostname) &&
    stored?.verified === true &&
    !shouldPreferSignupForAccount(stored);
  if (!hasVerifiedCreds && canProvisionAccounts(context)) {
    return {
      prefer: "signup",
      reason: "passwordless login wall, no verified account — open Create an account",
      step: "signup_entry",
    };
  }
  return null;
}

function resolveApplySignupGatePreference(snap, context) {
  if (!looksLikeApplySignupGate(snap)) return null;

  const hostname = snap.hostname || "";
  const stored = accountForHost(context, hostname);
  const hasVerified =
    stored &&
    stored.verified === true &&
    !shouldPreferSignupForAccount(stored) &&
    (stored.email || stored.username) &&
    stored.password;

  if (hasVerified) {
    if (authFormIsOpen(snap)) {
      return {
        prefer: "auth",
        reason: "verified site account — log in to apply",
        step: "auth",
      };
    }
    if ((snap.signInCount || 0) > 0) {
      return {
        prefer: "signin",
        reason: "verified site account — switch to sign in",
        step: "signin_entry",
      };
    }
    return {
      prefer: "auth",
      reason: "verified site account — log in to apply",
      step: "auth",
    };
  }

  if (canProvisionAccounts(context)) {
    return {
      prefer: "signup",
      reason: "platform signup gate — create account to apply",
      step: "signup",
    };
  }

  return {
    prefer: "none",
    reason: "sign up required on this job board — create account manually to apply",
    step: "blocked",
  };
}

function resolveSignupFormPreference(snap, context) {
  if (!(looksLikeSignupForm(snap) && canProvisionAccounts(context))) return null;
  const hostname = snap.hostname || "";
  const stored = accountForHost(context, hostname);
  if (!stored || stored.pending || !hasAuthCredentials(context, hostname)) {
    return {
      prefer: "signup",
      reason: "signup / create-account wall — provisioning account on the fly",
      step: "signup",
    };
  }
  return null;
}

function resolveAuthFormPreference(snap, history, context) {
  if (!looksLikeAuthForm(snap)) return null;

  const hostname = snap.hostname || "";
  const stored = accountForHost(context, hostname);

  if (loginFailedTwice(history) && canProvisionAccounts(context) && (snap.signUpCount || 0) > 0) {
    return {
      prefer: "signup",
      reason: "login failed — switching to account creation",
      step: "signup_entry",
    };
  }

  if (shouldPreferSignupForAccount(stored) && canProvisionAccounts(context)) {
    if (looksLikeSignupForm(snap)) {
      return {
        prefer: "signup",
        reason: "account not verified on site — completing registration",
        step: "signup",
      };
    }
    if (looksLikeSignupEntry(snap) || (snap.signUpCount || 0) > 0) {
      return {
        prefer: "signup",
        reason: "account not verified on site — opening signup",
        step: "signup_entry",
      };
    }
  }

  if (hasAuthCredentials(context, hostname) || (stored && stored.verified)) {
    return {
      prefer: "auth",
      reason: stored?.verified
        ? "login form — using saved site account"
        : "login form — using configured or provisioned credentials",
      step: "auth",
    };
  }

  if (looksLikeSignupEntry(snap) && canProvisionAccounts(context)) {
    return {
      prefer: "signup",
      reason: "login wall with signup path — opening registration",
      step: "signup_entry",
    };
  }

  if (canProvisionAccounts(context)) {
    if ((snap.signUpCount || 0) > 0) {
      return {
        prefer: "signup",
        reason: "no account yet — creating one for this directory",
        step: "signup_entry",
      };
    }
    return {
      prefer: "signup",
      reason: "auth surface — attempting signup with new account",
      step: "signup",
    };
  }

  return {
    prefer: "none",
    reason: "login required — configure account email/password or enable auto-signup",
    step: "blocked",
  };
}
