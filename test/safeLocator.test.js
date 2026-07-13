import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeRoleName,
  roleNameMatcher,
  shouldExactMatchName,
  safeRoleLocator,
} from "../src/primitives/safeLocator.js";

describe("safeLocator", () => {
  it("exact-matches short CTAs so Continue != Continue with Apple", () => {
    assert.equal(shouldExactMatchName("Continue"), true);
    assert.equal(shouldExactMatchName("Continue with Apple"), true); // ≤4 words → exact full label
    const cont = roleNameMatcher("Continue");
    assert.ok(cont.test("Continue"));
    assert.equal(cont.test("Continue with Apple"), false);
    assert.equal(cont.test("continue with google"), false);
  });

  it("anchors string and bare RegExp short CTAs", () => {
    assert.deepEqual(normalizeRoleName("Next").source, "^Next$");
    assert.equal(normalizeRoleName(/continue/i).source, "^continue$");
    assert.equal(normalizeRoleName(/^continue$/i).source, "^continue$");
  });

  it("leaves complex option patterns alone", () => {
    const complex = /create (an )?account/i;
    assert.equal(normalizeRoleName(complex), complex);
  });

  it("safeRoleLocator uses normalized name", () => {
    const calls = [];
    const fake = {
      getByRole(role, opts) {
        calls.push({ role, opts });
        return { kind: "locator" };
      },
    };
    safeRoleLocator(fake, "button", "Continue");
    assert.equal(calls[0].role, "button");
    assert.equal(calls[0].opts.name.source, "^Continue$");
    assert.equal(calls[0].opts.name.test("Continue with Apple"), false);
  });
});
