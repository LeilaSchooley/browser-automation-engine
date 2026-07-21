import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateReadyForReview } from "../src/layers/agent/progressAndDone.js";
import { resolveTechSkills, looksLikeTechSkills } from "../src/patterns/applicationScreening.js";
import { isStepComplete } from "../src/layers/steppedForm.js";
import { stepLooksLikeTypeaheadCommit } from "../src/layers/wizardLoop.js";

describe("WaaS Skills step guards", () => {
  it("infers tech skills from founding product engineer title", () => {
    const skills = resolveTechSkills("", "Founding Product Engineer");
    assert.ok(skills.includes("TypeScript") || skills.includes("React"));
    assert.ok(skills.length >= 3);
  });

  it("detects technologies/skills question copy", () => {
    assert.equal(
      looksLikeTechSkills("Which technologies/skills are you most experienced and interested in"),
      true,
    );
    assert.equal(looksLikeTechSkills("engineering roles choose up to four"), false);
  });

  it("does not treat Skills as a city typeahead commit", () => {
    const snap = {
      url: "https://www.workatastartup.com/application/skills",
      customControls: [
        { mappedTo: "techskills", widgetType: "combobox", label: "Which technologies/skills", filled: false },
      ],
      fields: [{ type: "combobox", label: "Search ..." }],
    };
    assert.equal(stepLooksLikeTypeaheadCommit(snap), false);
  });

  it("blocks ready-for-review while Continue is still on Skills", () => {
    const snap = {
      url: "https://www.workatastartup.com/application/skills",
      continueCount: 1,
      continueCandidates: [{ text: "Continue", disabled: false }],
      pageKind: "form",
      fieldCount: 8,
      fields: [],
      customControls: [{ mappedTo: "techskills", widgetType: "combobox", filled: true }],
      waasValidation: { available: true, missing: [], visibleRequiredCount: 0 },
    };
    const r = evaluateReadyForReview({
      snapAfter: snap,
      fillResult: { filled: [{ mappedTo: "techskills" }, { mappedTo: "techskills" }] },
      history: [],
      progressed: true,
      ok: true,
    });
    assert.equal(r.readyForReview, false);
  });

  it("is incomplete on Skills when techskills control is unfilled", () => {
    const snap = {
      url: "https://www.workatastartup.com/application/skills",
      continueCount: 1,
      continueCandidates: [{ disabled: false }],
      fields: [{ type: "combobox", label: "Search ...", filled: false }],
      customControls: [
        {
          mappedTo: "techskills",
          widgetType: "combobox",
          filled: false,
          required: true,
          label: "Which technologies/skills",
        },
      ],
      waasValidation: { available: true, missing: [], visibleRequiredCount: 0 },
    };
    assert.equal(isStepComplete(snap), false);
  });
});
