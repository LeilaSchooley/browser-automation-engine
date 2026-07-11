import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyApplyStep, stepToPlan } from "../src/layers/applyStep.js";
import { looksLikeAuthFailure } from "../src/layers/authActions.js";
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
