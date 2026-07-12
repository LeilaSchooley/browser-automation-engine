/**
 * Detect and complete email/username signup surfaces.
 * Site-agnostic: shared patterns + optional host overrides from learnings.
 */
import {
  attachAccountToContext,
  canProvisionAccounts,
  markAccountVerified,
  resolveAccountForHost,
  saveAccountForHost,
} from "../accountStore.js";
import { getAuthCredentials, LOGIN_WALL_TEXT, looksLikeAuthFailure, looksLikeAuthForm } from "./authActions.js";
import {
  SIGNUP_TEXT,
  SIGNUP_FORM_TEXT,
  OAUTH_PROVIDER_TEXT,
  SIGNUP_SUBMIT_PATTERNS,
  REGISTRATION_CONTINUE_PATTERNS,
} from "../patterns/index.js";
import { clickRoleMatching, clickSubmitByPatterns } from "./fillPrimitives.js";
import { fillSignupFormFromDom } from "./signupFieldFill.js";
import { authSelectorsFromSignupFields } from "../learningRecorder.js";
import { inspectPage } from "./formDiscovery.js";
import { humanPause } from "../human.js";
import { getApplicantProfile, hasIdentityRegistrationFields } from "../fillProfile.js";
import { hasPreferencesGateFields } from "../fillPreferences.js";
import { shouldBlockAdvance } from "../gateComplete.js";

async function confirmSignupSucceeded(page, hostname, log, before = null) {
  await humanPause(1200, 2000);
  const after = await inspectPage(page);
  if (looksLikeAuthFailure(after)) {
    log?.layer("signup", "signup rejected by site", "warn");
    return false;
  }
  if (hasPreferencesGateFields(after)) {
    markAccountVerified(hostname);
    return true;
  }
  if (before && hasIdentityRegistrationFields(before) && !hasIdentityRegistrationFields(after)) {
    markAccountVerified(hostname);
    return true;
  }
  if (before && (after.applyModalTitle || "") !== (before.applyModalTitle || "")) {
    markAccountVerified(hostname);
    return true;
  }
  if (looksLikeAuthForm(after) && !looksLikeSignupForm(after)) {
    log?.layer("signup", "still on login wall after signup submit", "warn");
    return false;
  }
  markAccountVerified(hostname);
  return true;
}

/** Click Continue / Next on multi-step registration (generic + testid). */
export async function clickRegistrationContinue(page, log, layer = "signup") {
  try {
    const byTestId = page.locator('[data-testid="registration-form-confirm"]');
    if ((await byTestId.count()) > 0 && (await byTestId.first().isVisible().catch(() => false))) {
      await byTestId.first().click({ timeout: 8000 });
      log?.layer(layer, "clicked registration Continue (testid)", "info");
      return true;
    }
  } catch {
    /* next */
  }
  if (await clickRoleMatching(page, REGISTRATION_CONTINUE_PATTERNS, { log, layer, roles: ["button"] })) {
    return true;
  }
  if (await clickSubmitByPatterns(page, REGISTRATION_CONTINUE_PATTERNS, { log, layer, preferLast: false })) {
    return true;
  }
  return false;
}

export function looksLikeSignupForm(snap) {
  if (!snap) return false;
  if (snap.signupForm) return true;
  if (hasIdentityRegistrationFields(snap)) return true;

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
  if (!snap) return false;
  if (hasIdentityRegistrationFields(snap)) return true;
  if (!looksLikeSignupForm(snap)) return false;
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
  let account = resolveAccountForHost(context, hostname, { provision: false });
  if (!account) {
    account = resolveAccountForHost(context, hostname, { provision: canProvisionAccounts(context) });
  }
  if (!account) {
    log?.layer("signup", "could not provision account for host", "warn");
    return { ok: false };
  }

  attachAccountToContext(context, account);
  const { email, username, password } = getAuthCredentials(context);
  const applicant = getApplicantProfile(context);
  const fullName = applicant.fullName || "Applicant";

  log?.layer(
    "signup",
    `${account.isNew ? "creating" : "reusing"} account ${username || email} on ${hostname} as ${fullName}`,
    "info",
  );

  const fillResult = await fillSignupFormFromDom(
    page,
    {
      email: applicant.email || email,
      username,
      password,
      fullName,
      firstName: applicant.firstName,
      lastName: applicant.lastName,
    },
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

  if (fillResult.password && fillResult.password !== password) {
    context.auth = { ...(context.auth || {}), password: fillResult.password };
    saveAccountForHost(hostname, { ...account, password: fillResult.password });
    log?.layer("signup", "stored password that satisfies site policy", "debug");
  }

  if (fillResult.passwordPolicyOk === false) {
    log?.layer("signup", "password still fails site policy — not submitting", "warn");
    return { ok: false };
  }

  const freshSnap = await inspectPage(page);
  const advance = await shouldBlockAdvance(freshSnap, null, page);
  if (advance.block) {
    log?.layer("signup", `blocked submit — ${advance.reason}`, "warn");
    return { ok: false };
  }

  await checkTermsIfNeeded(page, log);

  const authSelectors = authSelectorsFromSignupFields(fillResult.fields);
  const learnings =
    Object.keys(authSelectors).length > 0 ? { authSelectors } : undefined;

  const beforeSnap = snap;

  if (await clickRegistrationContinue(page, log, "signup")) {
    const ok = await confirmSignupSucceeded(page, hostname, log, beforeSnap);
    return { ok, learnings: ok ? learnings : undefined };
  }

  if (await clickRoleMatching(page, SIGNUP_SUBMIT_PATTERNS, { log, layer: "signup", roles: ["button"] })) {
    const ok = await confirmSignupSucceeded(page, hostname, log, beforeSnap);
    return { ok, learnings: ok ? learnings : undefined };
  }
  if (await clickSubmitByPatterns(page, SIGNUP_SUBMIT_PATTERNS, { log, layer: "signup", preferLast: true })) {
    const ok = await confirmSignupSucceeded(page, hostname, log, beforeSnap);
    return { ok, learnings: ok ? learnings : undefined };
  }

  try {
    const submits = page.locator('input[type="submit"], button[type="submit"]');
    const count = await submits.count();
    if (count >= 2) {
      await submits.nth(count - 1).click({ timeout: 8000 });
      log?.layer("signup", "clicked last submit (register pair)", "info");
      const ok = await confirmSignupSucceeded(page, hostname, log, beforeSnap);
      return { ok, learnings: ok ? learnings : undefined };
    }
    if (count === 1) {
      await submits.first().click({ timeout: 8000 });
      const ok = await confirmSignupSucceeded(page, hostname, log, beforeSnap);
      return { ok, learnings: ok ? learnings : undefined };
    }
  } catch {
    /* ignore */
  }

  log?.layer("signup", "could not find signup/continue button", "warn");
  return { ok: false, filled: fillResult.complete };
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
