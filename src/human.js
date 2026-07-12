import { getSettings } from "./runtime.js";

function sleepMs(minMs, maxMs) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function humanPause(minMs = 300, maxMs = 1200) {
  if (getSettings().browser_human_behavior) {
    await sleepMs(minMs, maxMs);
  }
}

/** Pause in small chunks so shouldStop can interrupt without killing the browser mid-wait. */
export async function humanPauseInterruptible(minMs = 300, maxMs = 1200, shouldStop = null, chunkMs = 200) {
  const ms = getSettings().browser_human_behavior
    ? Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs
    : 0;
  let elapsed = 0;
  while (elapsed < ms) {
    if (typeof shouldStop === "function" && shouldStop()) return true;
    const step = Math.min(chunkMs, ms - elapsed);
    await new Promise((resolve) => setTimeout(resolve, step));
    elapsed += step;
  }
  return typeof shouldStop === "function" && shouldStop();
}

function viewport(page) {
  const size = page.viewportSize();
  return size || { width: 1280, height: 720 };
}

export async function humanMoveMouse(page, x, y, { steps = null } = {}) {
  if (!getSettings().browser_human_behavior) {
    await page.mouse.move(x, y);
    return;
  }

  const vp = viewport(page);
  let startX = Math.random() * vp.width * 0.6 + vp.width * 0.2;
  let startY = Math.random() * vp.height * 0.55 + vp.height * 0.2;
  const n = steps ?? Math.floor(Math.random() * 17) + 12;

  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const cx = startX + (x - startX) * ease + (Math.random() * 3 - 1.5);
    const cy = startY + (y - startY) * ease + (Math.random() * 3 - 1.5);
    await page.mouse.move(cx, cy);
    await new Promise((r) => setTimeout(r, Math.random() * 14 + 4));
  }
}

export async function humanScroll(page, { direction = "down", amount = null } = {}) {
  if (!getSettings().browser_human_behavior) {
    await page.mouse.wheel(0, amount || 300);
    return;
  }

  let total = amount ?? Math.floor(Math.random() * 301) + 120;
  if (direction === "up") total = -total;

  const stepCount = Math.floor(Math.random() * 5) + 3;
  const perStep = Math.floor(total / stepCount);
  for (let i = 0; i < stepCount; i++) {
    await page.mouse.wheel(0, perStep + Math.floor(Math.random() * 17) - 8);
    await new Promise((r) => setTimeout(r, Math.random() * 100 + 40));
  }
}

export async function humanReadPage(page) {
  if (!getSettings().browser_human_behavior) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    return;
  }

  await humanPause(700, 2200);

  if (Math.random() < 0.75) await humanScroll(page, { direction: "down" });
  if (Math.random() < 0.45) {
    await humanScroll(page, { direction: "down", amount: Math.floor(Math.random() * 141) + 80 });
  }
  if (Math.random() < 0.25) {
    await humanScroll(page, { direction: "up", amount: Math.floor(Math.random() * 101) + 40 });
  }

  if (Math.random() < 0.5) {
    const vp = viewport(page);
    await humanMoveMouse(
      page,
      Math.random() * vp.width * 0.7 + vp.width * 0.15,
      Math.random() * vp.height * 0.55 + vp.height * 0.2,
    );
  }

  await humanPause(400, 1400);
}

export async function humanFocus(locator, page) {
  const box = await locator.boundingBox();
  if (box && getSettings().browser_human_behavior) {
    const tx = box.x + box.width * (Math.random() * 0.5 + 0.25);
    const ty = box.y + box.height * (Math.random() * 0.4 + 0.3);
    await humanMoveMouse(page, tx, ty);
    await humanPause(80, 350);
  }

  await locator.click({ timeout: 8000 });
  await humanPause(150, 500);
}

async function typeChars(locator, text) {
  const { human_type_delay_min: lo, human_type_delay_max: hi } = getSettings();
  for (const char of text) {
    await locator.pressSequentially(char, { delay: 0 });
    await new Promise((r) => setTimeout(r, Math.floor(Math.random() * (hi - lo + 1)) + lo));
    if (" .,!?\n".includes(char) && Math.random() < 0.12) {
      await humanPause(120, 650);
    }
  }
}

async function typeWords(locator, text) {
  const { human_type_delay_min: lo, human_type_delay_max: hi } = getSettings();
  const words = text.split(" ");
  for (let i = 0; i < words.length; i++) {
    const chunk = i === words.length - 1 ? words[i] : `${words[i]} `;
    await locator.pressSequentially(chunk, { delay: Math.floor(Math.random() * (hi - lo + 1)) + lo });
    if (Math.random() < 0.07) {
      await humanPause(250, 1100);
    }
  }
}

export async function humanType(locator, text, page) {
  if (!text) return;

  if (!getSettings().browser_human_behavior) {
    await locator.fill(text);
    return;
  }

  await humanFocus(locator, page);
  try {
    await locator.press("Control+A");
    await humanPause(40, 120);
    await locator.press("Backspace");
    await humanPause(80, 250);
  } catch {
    // ignore
  }

  if (text.length <= getSettings().human_long_text_threshold) {
    await typeChars(locator, text);
  } else {
    await typeWords(locator, text);
  }

  await humanPause(200, 600);
}

export async function humanGoto(page, url) {
  await humanPause(200, 800);
  await page.goto(url, { waitUntil: "load", timeout: 45000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await humanReadPage(page);
}
