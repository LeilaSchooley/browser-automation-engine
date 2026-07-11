import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it } from "node:test";
import { splitName } from "../src/smartFill.js";
import { withFixturePage, readFixture } from "./helpers/fixtures.js";

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

describe("smartFill", () => {
  it("splits full names", () => {
    assert.deepEqual(splitName("Ada Lovelace"), ["Ada", "Lovelace"]);
    assert.deepEqual(splitName("Prince"), ["Prince", ""]);
  });

  it("fills directory intake fields from config", async () => {
    await withFixturePage("simple-form", async (page) => {
      const result = await runSmartFillOnPage(page, {
        fullName: "Acme Labs",
        email: "founder@acme.dev",
        websiteUrl: "https://acme.dev",
        coverLetter: "AI tooling for founders.",
        startupName: "Acme Labs",
        tagline: "Ship faster",
        description: "We help startups list everywhere.",
      });

      assert.ok(result.filled.length >= 3, `expected >=3 fills, got ${result.filled.length}`);

      const email = await page.inputValue("#email");
      const website = await page.inputValue("#website");
      assert.equal(email, "founder@acme.dev");
      assert.equal(website, "https://acme.dev");
    });
  });

  it("leaves required empty fields in unfilled list", async () => {
    await withFixturePage("simple-form", async (page) => {
      const result = await runSmartFillOnPage(page, {
        email: "only@email.com",
      });
      assert.ok(result.unfilled.length >= 1);
    });
  });

  it("runs against fixture HTML without network", () => {
    const html = readFixture("simple-form");
    assert.match(html, /startup_name|email|website/i);
  });
});
