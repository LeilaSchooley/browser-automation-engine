import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { chromium } from "playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "../fixtures");

export function fixturePath(name) {
  const file = name.endsWith(".html") ? name : `${name}.html`;
  return path.join(FIXTURES_DIR, file);
}

export function readFixture(name) {
  return fs.readFileSync(fixturePath(name), "utf8");
}

/** Load static HTML into a headless page for DOM inspection tests. */
export async function withFixturePage(name, run) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.setContent(readFixture(name), { waitUntil: "domcontentloaded" });
    return await run(page);
  } finally {
    await browser.close();
  }
}
