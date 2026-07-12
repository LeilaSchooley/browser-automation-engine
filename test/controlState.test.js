import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hasEmptyRequiredControls, controlCount, shouldBlockDismissForControls } from "../src/controlState.js";

describe("controlState", () => {
  it("hasEmptyRequiredControls true for incomplete preferences gate", () => {
    const snap = {
      fieldCount: 2,
      passwordFieldCount: 0,
      title: "Tell us about yourself",
      pageText: "Tell us about yourself salary expectations location",
      fields: [
        { label: "Location", filled: true },
        { label: "Desired job title", filled: true },
      ],
      customControls: [{ label: "Salary expectations", widgetType: "combobox", filled: false }],
      customControlCount: 1,
    };
    assert.equal(hasEmptyRequiredControls(snap, { filled: [], unfilled: [{ type: "salary" }] }), true);
  });

  it("controlCount sums native fields and custom controls", () => {
    assert.equal(controlCount({ controlCount: 5 }), 5);
    assert.equal(controlCount({ fieldCount: 2, customControlCount: 1 }), 3);
  });

  it("shouldBlockDismissForControls when empty salary combobox", () => {
    const snap = {
      fieldCount: 2,
      passwordFieldCount: 0,
      pageText: "Tell us about yourself",
      customControls: [{ filled: false }],
      customControlCount: 1,
    };
    assert.equal(shouldBlockDismissForControls(snap, { filled: [] }), true);
  });
});
