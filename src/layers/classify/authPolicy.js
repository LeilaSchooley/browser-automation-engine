import {
  hasAuthCredentials,
  looksLikeAuthForm,
  looksLikePasswordlessLoginSurface,
} from "../authActions.js";
import { canProvisionAccounts } from "../../accountStore.js";
import {
  looksLikeSignupForm,
  isRegistrationSurface,
} from "../signupActions.js";
import { looksLikeEmailVerifyWall } from "../../inboxVerify.js";
import { looksLikeApplySignupGate } from "../../heuristics.js";
import {
  accountForHost,
  ensureAccount,
  resolveAuthPreference,
  shouldEnterOtp,
  shouldForceSignIn,
} from "../authFlowPolicy.js";

function classificationFromPref(pref, affordances, fp, target = null) {
  const medium =
    pref.step === "signup" && pref.prefer === "signup" && /attempting signup/i.test(pref.reason || "");
  return {
    step: pref.step,
    confidence: medium ? "medium" : "high",
    reason: pref.reason,
    target,
    affordances,
    fingerprint: fp,
    ...(pref.step === "blocked" ? { hardStop: true } : {}),
  };
}

export function classifyForceSignIn(ctx) {
  const { snap, history, context, affordances, fingerprint: fp } = ctx;
  if (!shouldForceSignIn(snap, history, context)) return null;

  const pref = resolveAuthPreference(snap, history, context);
  if ((pref.prefer !== "auth" && pref.prefer !== "signin") || !pref.step) return null;

  const hostname = snap.hostname || "";
  if (hostname) ensureAccount(context, hostname);
  return classificationFromPref(pref, affordances, fp, snap.signInCandidates?.[0] || null);
}

export function classifySoftOtp(ctx) {
  const { snap, history, context, affordances, fingerprint: fp } = ctx;
  // Soft OTP / email-code wall — must win over passwordless "Create account" once a code field is shown.
  if (!shouldEnterOtp(snap, history, context)) return null;
  return classificationFromPref(
    {
      prefer: "otp",
      reason: "OTP / email verification code — poll inbox or wait for paste",
      step: "enter_otp",
    },
    affordances,
    fp,
    null,
  );
}

export function classifyPasswordlessLogin(ctx) {
  const { snap, history, context, affordances, fingerprint: fp } = ctx;
  // Passwordless magic-link/OTP login (e.g. YC): with no verified account, submitting the
  // email just triggers an email-code wall for an account that doesn't exist. Prefer the
  // "Create an account" path instead of filling the login form.
  // Runs BEFORE any soft sign-in prompt so pending leftovers can't hijack this.
  if (!(looksLikePasswordlessLoginSurface(snap) && !looksLikeAuthForm(snap))) return null;

  const pref = resolveAuthPreference(snap, history, context);
  const hostname = snap.hostname || "";

  if (pref.prefer === "signin" && pref.step === "auth") {
    ensureAccount(context, hostname);
    return classificationFromPref(pref, affordances, fp, snap.signInCandidates?.[0] || null);
  }

  if (pref.prefer === "signup" && pref.step === "signup_entry") {
    ensureAccount(context, hostname);
    return classificationFromPref(
      pref,
      affordances,
      fp,
      snap.signUpCandidates?.[0] || { text: "Create an account" },
    );
  }

  return null;
}

export function classifyApplySignupGate(ctx) {
  const { snap, history, context, affordances, fingerprint: fp } = ctx;
  if (!looksLikeApplySignupGate(snap)) return null;

  const pref = resolveAuthPreference(snap, history, context);
  const hostname = snap.hostname || "";

  if (pref.prefer === "auth" || pref.prefer === "signin") {
    ensureAccount(context, hostname);
    return classificationFromPref(pref, affordances, fp, snap.signInCandidates?.[0] || null);
  }

  if (pref.prefer === "signup" && pref.step === "signup") {
    ensureAccount(context, snap.hostname || "");
    return classificationFromPref(
      pref,
      affordances,
      fp,
      snap.signUpCandidates?.[0] || snap.submitCandidates?.[0] || null,
    );
  }

  if (pref.step === "blocked") {
    return classificationFromPref(pref, affordances, fp, null);
  }

  return null;
}

export function classifyEmailVerifyWall(ctx) {
  const { snap, affordances, fingerprint: fp } = ctx;
  if (!looksLikeEmailVerifyWall(snap)) return null;
  return {
    step: "verify_email",
    confidence: "high",
    reason: "email verification wall — polling inbox",
    target: null,
    affordances,
    fingerprint: fp,
  };
}

export function classifyRegistrationSurface(ctx) {
  const { snap, history, context, affordances, fingerprint: fp } = ctx;
  // Registration surface (confirm password, username+email, etc.) — always signup, never login
  if (!(isRegistrationSurface(snap) && canProvisionAccounts(context))) return null;
  const pref = resolveAuthPreference(snap, history, context);
  if (pref.prefer !== "signup" || pref.step !== "signup") return null;
  ensureAccount(context, snap.hostname || "");
  return classificationFromPref(pref, affordances, fp, snap.signUpCandidates?.[0] || null);
}

export function classifySignupForm(ctx) {
  const { snap, history, context, affordances, fingerprint: fp } = ctx;
  // Prefer signup on dual login+create walls when we can provision and have no saved account
  if (!(looksLikeSignupForm(snap) && canProvisionAccounts(context))) return null;
  const hostname = snap.hostname || "";
  const stored = accountForHost(context, hostname);
  if (stored && !stored.pending && hasAuthCredentials(context, hostname)) return null;
  const pref = resolveAuthPreference(snap, history, context);
  if (pref.prefer !== "signup" || pref.step !== "signup") return null;
  ensureAccount(context, hostname);
  return classificationFromPref(pref, affordances, fp, snap.signUpCandidates?.[0] || null);
}

export function classifyAuthForm(ctx) {
  const { snap, history, context, affordances, fingerprint: fp } = ctx;
  if (!looksLikeAuthForm(snap)) return null;

  const pref = resolveAuthPreference(snap, history, context);
  const hostname = snap.hostname || "";

  if (pref.step === "blocked" && pref.prefer === "none") {
    return classificationFromPref(pref, affordances, fp, null);
  }

  if (pref.prefer === "signup" && (pref.step === "signup" || pref.step === "signup_entry")) {
    ensureAccount(context, hostname);
    return classificationFromPref(pref, affordances, fp, snap.signUpCandidates?.[0] || null);
  }

  if (pref.prefer === "auth" && pref.step === "auth") {
    ensureAccount(context, hostname);
    return classificationFromPref(pref, affordances, fp, snap.signInCandidates?.[0] || null);
  }

  return null;
}
