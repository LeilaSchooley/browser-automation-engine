import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveAuthPreference,
  shouldEnterOtp,
  shouldPreferSignupPath,
} from "../src/layers/authFlowPolicy.js";
import { initTestRuntime } from "./helpers/runtime.js";

describe("authFlowPolicy", () => {
  it("passwordless login wall prefers signup when provisioning is on", () => {
    initTestRuntime({
      settings: { auto_signup_enabled: true, account_email_base: "founder@agency.example" },
    });
    const snap = {
      title: "Log in to access the YC Application",
      headings: "Log in to access the YC Application",
      hostname: "account.ycombinator.com",
      fieldCount: 1,
      passwordFieldCount: 0,
      usernameFieldCount: 1,
      continueCandidates: [{ text: "Continue" }],
      signUpCount: 1,
      signUpCandidates: [{ text: "Create an account" }],
    };
    const context = { profile: { email: "founder@agency.example", startupName: "TestCo" } };
    const pref = resolveAuthPreference(snap, [], context);
    assert.equal(pref.prefer, "signup");
    assert.equal(pref.step, "signup_entry");
    assert.equal(shouldPreferSignupPath(snap, [], context), true);
  });

  it("existsOnSite prefers signin over signup on passwordless wall", () => {
    initTestRuntime({
      settings: { auto_signup_enabled: true, account_email_base: "founder@agency.example" },
    });
    const snap = {
      title: "Log in to access the YC Application",
      headings: "Log in to access the YC Application",
      hostname: "account.ycombinator.com",
      fieldCount: 1,
      passwordFieldCount: 0,
      usernameFieldCount: 1,
      continueCandidates: [{ text: "Continue" }],
      signUpCount: 1,
      signUpCandidates: [{ text: "Create an account" }],
    };
    const context = {
      profile: { email: "founder@agency.example" },
      siteAccount: {
        email: "founder@agency.example",
        password: "x",
        existsOnSite: true,
        verified: false,
        hostname: "account.ycombinator.com",
      },
    };
    const pref = resolveAuthPreference(snap, [], context);
    assert.equal(pref.prefer, "signin");
    assert.equal(pref.step, "auth");
    assert.equal(shouldPreferSignupPath(snap, [], context), false);
  });

  it("soft OTP gate prefers otp", () => {
    const snap = {
      title: "Verify",
      pageText: "Enter the code from your email",
      headings: "Enter the code",
      fieldCount: 1,
      passwordFieldCount: 0,
      fields: [{ type: "text", label: "Or enter the code from your email:", name: "code" }],
      continueCandidates: [{ text: "Verify Code" }],
    };
    assert.equal(shouldEnterOtp(snap, [], {}), true);
    const pref = resolveAuthPreference(snap, [], {});
    assert.equal(pref.prefer, "otp");
    assert.equal(pref.step, "enter_otp");
  });

  it("existing-account signup history + open login form prefers auth", () => {
    const snap = {
      title: "Sign In",
      pageText: "Email Password Sign in",
      hostname: "jobs.example.com",
      fieldCount: 2,
      emailFieldCount: 1,
      passwordFieldCount: 1,
      authForm: true,
    };
    const history = [{ action: "auth_signup", ok: false, existingAccount: true }];
    const pref = resolveAuthPreference(snap, history, {
      auth: { email: "a@b.com", password: "x" },
    });
    assert.equal(pref.prefer, "auth");
    assert.equal(pref.step, "auth");
    assert.equal(shouldPreferSignupPath(snap, history, {}), false);
  });
});
