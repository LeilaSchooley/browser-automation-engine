import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, before, after } from "node:test";
import { discoverVisibleFormFields, fillSignupFormFromDom } from "../src/layers/signupFieldFill.js";
import { attemptAuthSignup } from "../src/layers/signupActions.js";
import { classifyApplyStep } from "../src/layers/applyStep.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { withFixturePage } from "./helpers/fixtures.js";
import { initTestRuntime } from "./helpers/runtime.js";
import { quietLog } from "./helpers/log.js";

let accountsFile = "";

before(() => {
  accountsFile = path.join(os.tmpdir(), `ql-signup-fill-${process.pid}.json`);
  initTestRuntime({
    settings: {
      auto_signup_enabled: true,
      site_accounts_path: accountsFile,
      account_email_base: "founder@agency.example",
    },
  });
});

after(() => {
  if (accountsFile && fs.existsSync(accountsFile)) fs.unlinkSync(accountsFile);
});

describe("signup field fill (DOM-driven)", () => {
  it("discovers visible signup fields and ignores hidden login inputs", async () => {
    await withFixturePage("betalist-register", async (page) => {
      const fields = await discoverVisibleFormFields(page);
      const kinds = fields.map((f) => f.kind);
      assert.ok(kinds.includes("username"));
      assert.ok(kinds.includes("email"));
      assert.ok(kinds.filter((k) => k === "password").length >= 1);
      assert.ok(kinds.includes("confirm_password"));
      assert.equal(kinds.filter((k) => k === "email").length, 1);
    });
  });

  it("fills username, email, password, and confirmation", async () => {
    initTestRuntime();
    await withFixturePage("betalist-register", async (page) => {
      const result = await fillSignupFormFromDom(
        page,
        {
          email: "founder+test@agency.example",
          username: "testco",
          password: "Str0ng!Pass",
          fullName: "TestCo",
        },
        { log: quietLog() },
      );
      assert.equal(result.complete, true);
      assert.equal(await page.locator("#email").inputValue(), "founder+test@agency.example");
      assert.equal(await page.locator("#username").inputValue(), "testco");
      assert.equal(await page.locator("#password").inputValue(), "Str0ng!Pass");
      assert.equal(await page.locator("#confirm").inputValue(), "Str0ng!Pass");
    });
  });

  it("classifies registration surface as signup not login", async () => {
    initTestRuntime();
    await withFixturePage("betalist-register", async (page) => {
      const snap = await inspectPage(page);
      const context = {
        auth: { email: "a@b.c", username: "testco", password: "secret" },
        profile: { startupName: "TestCo", email: "a@b.c" },
      };
      const c = classifyApplyStep(snap, { filled: [] }, [], context);
      assert.equal(c.step, "signup");
    });
  });

  it("deep scan: finds inputs inside open shadow DOM", async () => {
    await withFixturePage("shadow-signup", async (page) => {
      const fields = await discoverVisibleFormFields(page);
      const kinds = fields.map((f) => f.kind);
      assert.ok(kinds.includes("email"), `kinds=${kinds}`);
      assert.ok(kinds.includes("password"), `kinds=${kinds}`);
      const result = await fillSignupFormFromDom(
        page,
        { email: "a@b.com", password: "Str0ng!Pass99" },
        { log: quietLog() },
      );
      assert.equal(result.filled.email, true);
      assert.equal(result.filled.password, true);
      const values = await page.evaluate(() => {
        const root = document.querySelector("#host").shadowRoot;
        return {
          email: root.querySelector("#email").value,
          password: root.querySelector("#password").value,
        };
      });
      assert.equal(values.email, "a@b.com");
      assert.equal(values.password, "Str0ng!Pass99");
    });
  });

  it("deep scan: finds inputs inside same-origin iframe", async () => {
    await withFixturePage("iframe-apply-form", async (page) => {
      // srcdoc iframe may need a tick to parse
      await page.waitForTimeout(50);
      const fields = await discoverVisibleFormFields(page);
      const kinds = fields.map((f) => f.kind);
      assert.ok(kinds.includes("email"), `kinds=${kinds}`);
      const email = fields.find((f) => f.kind === "email");
      const ok = await fillSignupFormFromDom(
        page,
        { email: "iframe@test.com", password: "x" },
        { log: quietLog() },
      );
      // password may be absent — just ensure email fill worked via stamp
      assert.equal(ok.filled.email, true);
      const value = await page.evaluate(() => {
        const frame = document.querySelector("#apply-frame");
        return frame.contentDocument.querySelector("#email")?.value || "";
      });
      assert.equal(value, "iframe@test.com");
      assert.ok(email?.qlId);
    });
  });

  it("YC floating labels: discovers + fills first/last/email without id/name", async () => {
    await withFixturePage("yc-signup-floating", async (page) => {
      const fields = await discoverVisibleFormFields(page);
      const kinds = fields.map((f) => f.kind);
      assert.deepEqual(kinds.slice(0, 5), ["first_name", "last_name", "email", "username", "password"]);

      const result = await fillSignupFormFromDom(
        page,
        {
          email: "isaacb@tutanota.com",
          username: "isaacb",
          password: "Str0ng!Pass99",
          fullName: "Isaac Boadi",
          firstName: "Isaac",
          lastName: "Boadi",
        },
        { log: quietLog() },
      );
      assert.equal(result.filled.first_name, true);
      assert.equal(result.filled.last_name, true);
      assert.equal(result.filled.email, true);
      assert.equal(result.filled.username, true);
      assert.equal(result.filled.password, true);
      assert.equal(result.missing.length, 0);

      const values = await page.evaluate(() =>
        [...document.querySelectorAll("input")].map((el) => el.value),
      );
      assert.equal(values[0], "Isaac");
      assert.equal(values[1], "Boadi");
      assert.equal(values[2], "isaacb@tutanota.com");
      assert.equal(values[3], "isaacb");
      assert.equal(values[4], "Str0ng!Pass99");
    });
  });

  it("attemptAuthSignup fills all fields via DOM scan", async () => {
    await withFixturePage("betalist-register", async (page) => {
      const context = {
        profile: { startupName: "TestCo", founderName: "TestCo", email: "founder@agency.example" },
        sessionId: "sub-1",
      };
      const snap = await inspectPage(page);
      await attemptAuthSignup(page, snap, context, quietLog());
      const email = await page.locator("#email").inputValue();
      assert.ok(email.includes("@"));
      assert.ok((await page.locator("#username").inputValue()).length > 0);
      assert.ok((await page.locator("#password").inputValue()).length > 0);
      assert.ok((await page.locator("#confirm").inputValue()).length > 0);
    });
  });
});
