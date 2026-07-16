import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it } from "node:test";
import { withFixturePage } from "./helpers/fixtures.js";
import { inspectPage } from "../src/layers/formDiscovery.js";
import { fillCustomControls } from "../src/fillCustomControls.js";
import { resolveApplicationAnswer } from "../src/fillApplicationAnswers.js";
import { resolveIdentityFillValue } from "../src/fillProfile.js";
import { compareApplyFillOrder, requiredPriorityRank, sortApplyFields } from "../src/fieldMapper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SMART_FILL_JS = fs.readFileSync(path.join(__dirname, "../src/smart_fill.js"), "utf8");

async function runSmartFillOnPage(page, config, siteMappings = {}) {
  return page.evaluate(
    ({ js, config: cfg, siteMappings: maps }) => {
      // eslint-disable-next-line no-eval
      eval(js);
      return runSmartFill(cfg, maps);
    },
    { js: SMART_FILL_JS, config, siteMappings },
  );
}

describe("field mapping (Lever-style)", () => {
  it("maps postalCode config to zip and does not put email in street", async () => {
    await withFixturePage("lever-application-snippet", async (page) => {
      const result = await runSmartFillOnPage(page, {
        fullName: "Isaac Boadi",
        email: "isaacb@tutanota.com",
        phone: "+44 7700 900123",
        linkedinUrl: "https://linkedin.com/in/example",
        websiteUrl: "https://example.com",
        addressLine1: "10 Example Street",
        city: "London",
        state: "England",
        postalCode: "E1 6AN",
        country: "GB",
      });

      const types = Object.fromEntries((result.filled || []).map((f) => [f.type, f]));
      assert.ok(types.email || (await page.inputValue('input[name="email"]')) === "isaacb@tutanota.com");
      assert.equal(await page.inputValue('input[name="cards[x][field3]"]'), "10 Example Street");
      assert.equal(await page.inputValue('input[name="cards[x][field4]"]'), "London, England, E1 6AN");
      assert.notEqual(await page.inputValue('input[name="cards[x][field3]"]'), "isaacb@tutanota.com");
    });
  });

  it("discovers Lever EEOC selects and pronouns checkbox group", async () => {
    await withFixturePage("lever-application-snippet", async (page) => {
      const snap = await inspectPage(page);
      const mapped = (snap.customControls || []).map((c) => c.mappedTo);
      assert.ok(mapped.includes("eeocgender"), `expected eeocgender in ${mapped}`);
      assert.ok(mapped.includes("eeocrace"), `expected eeocrace in ${mapped}`);
      assert.ok(mapped.includes("eeocveteran"), `expected eeocveteran in ${mapped}`);
      assert.ok(mapped.includes("pronouns"), `expected pronouns in ${mapped}`);
    });
  });

  it("fills EEOC decline + pronouns from application answers", async () => {
    await withFixturePage("lever-application-snippet", async (page) => {
      const snap = await inspectPage(page);
      const ctx = {
        preferences: { eeocDecline: true, pronouns: "He/him", needsVisaSponsorship: false },
        applicant: {},
      };
      const result = await fillCustomControls(page, ctx, { snap });
      assert.ok(result.ok, "expected custom controls fill to succeed");
      assert.equal(await page.inputValue('select[name="eeo[gender]"]'), "Decline to self-identify");
      assert.equal(await page.inputValue('select[name="eeo[race]"]'), "Decline to self-identify");
      assert.equal(await page.inputValue('select[name="eeo[veteran]"]'), "Decline to self-identify");
      assert.equal(await page.locator('input[type="checkbox"][value="He/him"]').isChecked(), true);
    });
  });

  it("never falls back address to email-looking values", () => {
    const ctx = { applicant: { email: "isaacb@tutanota.com" } };
    assert.equal(resolveIdentityFillValue("Complete Street Address", "isaacb@tutanota.com", ctx), "");
    assert.equal(resolveApplicationAnswer("pronouns", "Pronouns", { preferences: { pronouns: "They/them" } }), "They/them");
  });

  it("orders identity before required salary", () => {
    const name = { type: "chosenname", label: "Chosen name", required: false, top: 200 };
    const salary = { type: "salary", label: "Salary expectations *", required: true, top: 100 };
    assert.ok(requiredPriorityRank(name) < requiredPriorityRank(salary) || requiredPriorityRank(name) === 0);
    assert.ok(compareApplyFillOrder(name, salary) < 0, "chosen name should sort before salary");
    assert.ok(compareApplyFillOrder({ type: "email", required: true }, salary) < 0);
  });

  it("sorts company required before voluntary EEOC", () => {
    const sorted = sortApplyFields(
      [
        { type: "eeocrace", label: "Race", name: "eeo[race]", top: 10 },
        {
          type: "volunteer",
          label: "Are you currently a volunteer? *",
          required: true,
          top: 900,
        },
        { type: "email", label: "Email *", required: true, top: 50 },
      ],
      {
        looksLikeApplyForm: true,
        pageText: "Equal Employment Opportunity Information Voluntary",
      },
    );
    assert.deepEqual(
      sorted.map((f) => f.type),
      ["email", "volunteer", "eeocrace"],
    );
  });
});
