import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyApplyStep, stepToPlan } from "../src/layers/applyStep.js";
import {
  looksLikeAuthFailure,
  looksLikeHardGate,
  looksLikeOAuthOnly,
  hasEmailAuthPath,
  resolveSameSiteSignInUrl,
  looksLikePasswordlessLoginSurface,
} from "../src/layers/authActions.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initTestRuntime } from "./helpers/runtime.js";

const credentials = {
  auth: { email: "founder@testco.example", password: "test-password-123" },
  profile: { email: "founder@testco.example" },
};

const pendingStoredAccount = {
  auth: { email: "founder@testco.example", password: "test-password-123", provisioned: true },
  profile: { email: "founder@testco.example", startupName: "TestCo" },
};

describe("auth flow (BetaList-style login)", () => {
  it("resolves same-site login links but rejects social and unrelated destinations", () => {
    const current = "https://weworkremotely.com/job-seekers/account/register";
    assert.equal(
      resolveSameSiteSignInUrl("/job-seekers/account/login", current),
      "https://weworkremotely.com/job-seekers/account/login",
    );
    assert.equal(
      resolveSameSiteSignInUrl("https://www.linkedin.com/uas/login", current),
      "",
    );
    assert.equal(resolveSameSiteSignInUrl("/jobs", current), "");
  });

  it("detects auth form from HTML snapshot", async () => {
    await withFixturePage("betalist-login", async (page) => {
      const snap = await inspectPage(page);
      assert.equal(snap.authForm, true);
      assert.ok(snap.passwordFieldCount >= 1);
      assert.ok(snap.emailFieldCount >= 1);
      assert.ok(snap.signInCount >= 1);
    });
  });

  it("classifies as auth when credentials are configured", async () => {
    await withFixturePage("betalist-login", async (page) => {
      const snap = await inspectPage(page);
      const c = classifyApplyStep(snap, { filled: [] }, [], credentials);
      assert.equal(c.step, "auth");
      assert.equal(stepToPlan(c, snap, [])?.type, "auth_login");
    });
  });

  it("classifies as blocked when login form has no credentials and auto-signup off", async () => {
    initTestRuntime({ settings: { auto_signup_enabled: false } });
    await withFixturePage("betalist-login", async (page) => {
      const snap = await inspectPage(page);
      const c = classifyApplyStep(snap, { filled: [] }, [], null);
      assert.equal(c.step, "blocked");
      assert.match(c.reason, /configure account|auto-signup/i);
    });
  });

  it("detects login rejection copy", async () => {
    await withFixturePage("betalist-login-failed", async (page) => {
      const snap = await inspectPage(page);
      assert.equal(looksLikeAuthFailure(snap), true);
    });
  });

  it("switches to signup after failed login attempts for unverified account", async () => {
    initTestRuntime();
    await withFixturePage("betalist-login", async (page) => {
      const snap = await inspectPage(page);
      const history = [
        { action: "auth_login", ok: false },
        { action: "auth_login", ok: false },
      ];
      const c = classifyApplyStep(snap, { filled: [] }, history, pendingStoredAccount);
      assert.equal(c.step, "signup_entry");
      assert.equal(stepToPlan(c, snap, history)?.type, "click_signup");
    });
  });
});

describe("passwordless login surface (YC magic-link / OTP)", () => {
  const ycSnap = {
    title: "Log in to access the YC Application",
    headings: "Log in to access the YC Application",
    hostname: "account.ycombinator.com",
    fieldCount: 1,
    passwordFieldCount: 0,
    emailFieldCount: 0,
    usernameFieldCount: 1,
    continueCandidates: [{ text: "Continue" }],
    signInCount: 0,
    signUpCount: 1,
    signUpCandidates: [{ text: "Create an account" }],
  };

  it("detects a passwordless login wall (no password, login title, identity field)", () => {
    assert.equal(looksLikePasswordlessLoginSurface(ycSnap), true);
  });

  it("ignores multi-field application forms and password logins", () => {
    assert.equal(looksLikePasswordlessLoginSurface({ ...ycSnap, passwordFieldCount: 1 }), false);
    assert.equal(looksLikePasswordlessLoginSurface({ ...ycSnap, fieldCount: 6 }), false);
    assert.equal(
      looksLikePasswordlessLoginSurface({ ...ycSnap, title: "Apply", headings: "Apply" }),
      false,
    );
  });

  it("prefers Create an account when no saved account and provisioning is on", () => {
    initTestRuntime({ settings: { auto_signup_enabled: true, account_email_base: "founder@agency.example" } });
    const provisionCtx = { profile: { email: "founder@agency.example", startupName: "TestCo" } };
    const c = classifyApplyStep(ycSnap, { filled: [] }, [], provisionCtx);
    assert.equal(c.step, "signup_entry");
    assert.match(c.reason, /create an account|passwordless login/i);
  });
});

describe("Indeed email auth vs Continue with Apple", () => {
  const indeedEmailSnap = {
    url: "https://secure.indeed.com/auth?from=indapply-login-SmartApply",
    hostname: "secure.indeed.com",
    title: "Sign In | Indeed Accounts",
    pageText: "Email address Continue Continue with Apple Continue with Google Sign in",
    pageKind: "content",
    fieldCount: 1,
    emailFieldCount: 1,
    passwordFieldCount: 0,
    continueCount: 2,
    fields: [{ type: "email", label: "Email address *" }],
    continueCandidates: [
      { text: "Continue", score: 105 },
      { text: "Continue with Apple", score: 55 },
    ],
  };

  it("has an email auth path when Apple SSO is also present", () => {
    assert.equal(hasEmailAuthPath(indeedEmailSnap), true);
    assert.equal(looksLikeOAuthOnly(indeedEmailSnap), false);
    assert.equal(looksLikeHardGate(indeedEmailSnap).hard, false);
  });

  it("does not classify Indeed email Continue as blocked OAuth-only", () => {
    const c = classifyApplyStep(indeedEmailSnap, { filled: [] }, [], null);
    assert.notEqual(c.step, "blocked");
    assert.notEqual(c.hardStop, true);
  });
});
