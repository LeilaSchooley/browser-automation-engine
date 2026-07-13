import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sortByVisualOrder } from "../src/fillOrder.js";

describe("fillOrder", () => {
  it("sortByVisualOrder sorts top-to-bottom then left-to-right", () => {
    const ordered = sortByVisualOrder([
      { type: "linkedinurl", top: 400, left: 10 },
      { type: "fullname", top: 100, left: 10 },
      { type: "email", top: 200, left: 10 },
      { type: "address1", top: 300, left: 10 },
    ]);
    assert.deepEqual(
      ordered.map((e) => e.type),
      ["fullname", "email", "address1", "linkedinurl"],
    );
  });
});
