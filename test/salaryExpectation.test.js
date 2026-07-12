import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSalaryFromText,
  parseSalaryNumbers,
  pickClosestSalaryOption,
  resolveSalaryExpectation,
} from "../src/salaryExpectation.js";
import { getPreferencesFromContext } from "../src/fillPreferences.js";

describe("salaryExpectation", () => {
  it("parses range from description", () => {
    const text = "We offer competitive pay. Salary: $90,000 - $110,000 per year plus benefits.";
    assert.equal(parseSalaryFromText(text), "$90,000 - $110,000");
  });

  it("parses $120k style ranges", () => {
    assert.match(parseSalaryFromText("Compensation $120k - $150k remote"), /\$120k/i);
  });

  it("resolveSalaryExpectation prefers listing over description", () => {
    const s = resolveSalaryExpectation({
      job: {
        salary: "$100,000 - $130,000",
        description: "Salary: $50,000 - $60,000",
      },
    });
    assert.equal(s, "$100,000 - $130,000");
  });

  it("resolveSalaryExpectation parses description when listing empty", () => {
    const s = resolveSalaryExpectation({
      job: {
        salary: "",
        description: "Package: $85,000 - $95,000 annually",
      },
    });
    assert.ok(s.includes("85"));
  });

  it("pickClosestSalaryOption matches bracket containing target", () => {
    const opts = [
      { value: "1", text: "Less than $50,000" },
      { value: "2", text: "$50,000 - $75,000" },
      { value: "3", text: "$75,000 - $100,000" },
      { value: "4", text: "$100,000+" },
    ];
    const pick = pickClosestSalaryOption(opts, "$90,000 - $110,000");
    assert.equal(pick?.text, "$75,000 - $100,000");
  });

  it("getPreferencesFromContext uses job listing salary", () => {
    const prefs = getPreferencesFromContext({
      job: { salary: "$95,000 - $115,000", title: "Engineer" },
    });
    assert.equal(prefs.salary, "$95,000 - $115,000");
  });
});
