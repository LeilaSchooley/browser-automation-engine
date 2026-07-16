import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isJobApplicationField,
  isNoiseApplicationField,
  sortApplyFields,
  detectRequiredUnfilled,
  buildRequiredFieldsInstruction,
  compareApplyFillOrder,
  looksRequiredField,
  isTrulyRequired,
  isVoluntaryField,
  requiredPriorityRank,
  isEarlyCustomControl,
} from "../src/fieldMapper.js";

describe("fieldMapper (omni)", () => {
  it("rejects footer newsletter / subscribe email noise", () => {
    assert.equal(
      isNoiseApplicationField({
        clue: "email newsletter",
        name: "email",
        selector: "footer form input[type=email]",
      }),
      true,
    );
    assert.equal(
      isJobApplicationField({
        clue: "email",
        name: "email",
        selector: "footer input",
        inFooter: true,
      }),
      false,
    );
  });

  it("keeps Lever apply fields including custom cards and required marks", () => {
    assert.equal(
      isJobApplicationField({
        clue: "Complete Street Address ✱",
        name: "cards[x][field3]",
        required: true,
      }),
      true,
    );
    assert.equal(
      isJobApplicationField({
        clue: "How did you hear about us",
        name: "cards[x][field9]",
        selector: ".application-question input",
      }),
      true,
    );
  });

  it("sorts required before optional and identity before EEOC", () => {
    const sorted = sortApplyFields(
      [
        { type: "eeocgender", label: "Gender", top: 400, left: 0 },
        { type: "email", label: "Email", top: 100, left: 0, required: true },
        { type: "website", label: "Other website", top: 50, left: 0 },
        { type: "pronouns", label: "Pronouns", top: 90, left: 0 },
        { type: "fullname", label: "Chosen name", top: 200, left: 0 },
      ],
      { looksLikeApplyForm: true },
    );
    assert.deepEqual(
      sorted.map((f) => f.type),
      ["fullname", "pronouns", "email", "website", "eeocgender"],
    );
  });

  it("treats chosen name / pronouns as soft-required priority", () => {
    assert.equal(looksRequiredField({ label: "Chosen name", type: "fullname" }), true);
    assert.equal(looksRequiredField({ label: "Pronouns", mappedTo: "pronouns" }), true);
    assert.equal(looksRequiredField({ label: "Other website", type: "website" }), false);
  });

  it("deprioritizes voluntary EEOC behind truly required company questions", () => {
    const ctx = {
      pageText: "U.S. Equal Employment Opportunity Information Voluntary Self-Identification",
    };
    const eeoc = { type: "eeocgender", label: "Gender", name: "eeo[gender]", top: 10 };
    const company = {
      type: "formeremployee",
      label: "Are you a current or former employee of the Trevor Project? *",
      required: true,
      top: 500,
    };
    assert.equal(isVoluntaryField(eeoc, ctx), true);
    assert.equal(isTrulyRequired(eeoc, ctx), false);
    assert.equal(isTrulyRequired(company, ctx), true);
    assert.ok(requiredPriorityRank(company, ctx) < requiredPriorityRank(eeoc, ctx));
    assert.ok(compareApplyFillOrder(company, eeoc, ctx) < 0);
    assert.equal(isEarlyCustomControl(eeoc, ctx), false);
    assert.equal(isEarlyCustomControl(company, ctx), true);
    assert.equal(detectRequiredUnfilled([eeoc, company], ctx).length, 1);
  });

  it("builds required-only Stagehand instruction", () => {
    const fields = [
      { clue: "Email ✱", required: true },
      { clue: "Website", required: false },
      { clue: "Complete Street Address ✱", required: true },
    ];
    assert.equal(detectRequiredUnfilled(fields).length, 2);
    const instr = buildRequiredFieldsInstruction(fields);
    assert.match(instr, /Email/);
    assert.match(instr, /Street Address/);
    assert.doesNotMatch(instr, /Website/);
    assert.match(instr, /skip footer/i);
  });

  it("compareApplyFillOrder boosts required", () => {
    assert.ok(
      compareApplyFillOrder({ required: true, top: 500 }, { required: false, top: 10 }) < 0,
    );
  });
});
