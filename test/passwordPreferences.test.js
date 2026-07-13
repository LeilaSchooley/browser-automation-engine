import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_PASSWORD_RULES,
  generatePasswordWithPolicy,
  parsePasswordRequirementsFromText,
  passwordMeetsRules,
} from "../src/passwordPolicy.js";
import {
  getPreferencesFromContext,
  hasPreferencesGateFields,
  preferencesGateIncomplete,
  resolvePreferenceFillValue,
} from "../src/fillPreferences.js";

describe("passwordPolicy", () => {
  it("parses checklist text from page copy", () => {
    const text = `Password
One lowercase character
One uppercase character
One number
One special character
Minimum of 8 characters`;
    const rules = parsePasswordRequirementsFromText(text);
    assert.equal(rules.lowercase, true);
    assert.equal(rules.uppercase, true);
    assert.equal(rules.digit, true);
    assert.equal(rules.special, true);
    assert.equal(rules.minLength, 8);
  });

  it("generatePasswordWithPolicy always satisfies default rules", () => {
    for (let i = 0; i < 20; i += 1) {
      const pwd = generatePasswordWithPolicy(DEFAULT_PASSWORD_RULES, 12);
      assert.ok(passwordMeetsRules(pwd, DEFAULT_PASSWORD_RULES), pwd);
    }
  });

  it("rejects passwords missing a digit", () => {
    assert.equal(passwordMeetsRules("Abcdefgh!", DEFAULT_PASSWORD_RULES), false);
    const fixed = generatePasswordWithPolicy(DEFAULT_PASSWORD_RULES);
    assert.ok(/\d/.test(fixed));
  });

  it("parses numbers-and-letters policy (Jobright-style)", () => {
    const rules = parsePasswordRequirementsFromText(
      "Your password should contain both numbers and letters with 8 minimum length",
    );
    assert.equal(rules.digit, true);
    assert.equal(rules.lowercase, true);
    assert.equal(rules.special, false);
    assert.equal(rules.minLength, 8);
    const pwd = generatePasswordWithPolicy(rules, 10);
    assert.ok(passwordMeetsRules(pwd, rules), pwd);
  });
});

describe("fillPreferences", () => {
  it("builds preferences from context job + applicant", () => {
    const prefs = getPreferencesFromContext({
      applicant: { city: "Berlin", country: "Germany" },
      job: { title: "Platform Engineer", location: "Remote" },
      preferences: { salary: "$120k" },
    });
    assert.equal(prefs.location, "Berlin, Germany");
    assert.equal(prefs.desiredTitle, "Platform Engineer");
    assert.equal(prefs.salary, "$120k");
  });

  it("does not treat Ashby board filters as preferences gate", () => {
    const snap = {
      passwordFieldCount: 0,
      fieldCount: 4,
      fileInputCount: 0,
      url: "https://jobs.ashbyhq.com/ditto",
      pageText: "Open Positions Department Employment Location",
      fields: [
        { name: "departmentId", label: "Department", type: "select-one" },
        { name: "employmentType", label: "Employment Type", type: "select-one" },
        { name: "locationId", label: "Location", type: "select-one" },
        { name: "workplaceType", label: "Location Type", type: "select-one" },
      ],
    };
    assert.equal(hasPreferencesGateFields(snap), false);
  });

  it("detects tell-us-about-yourself preferences gate", () => {
    const snap = {
      passwordFieldCount: 0,
      fieldCount: 3,
      applyModalTitle: "Tell us about yourself",
      pageText: "Salary expectations Desired job title Location",
      fields: [
        { label: "Location", type: "text", filled: true },
        { label: "Salary expectations", type: "select", filled: false },
        { label: "Desired job title", type: "text", filled: true },
      ],
    };
    assert.equal(hasPreferencesGateFields(snap), true);
    assert.equal(preferencesGateIncomplete(snap), true);
  });

  it("resolvePreferenceFillValue maps salary field", () => {
    const value = resolvePreferenceFillValue("Salary expectations", "", {
      preferences: { salary: "Negotiable" },
    });
    assert.equal(value, "Negotiable");
  });
});
