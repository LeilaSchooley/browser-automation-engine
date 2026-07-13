/**
 * Adopt a large iframe that holds the real form when the main frame is empty.
 * Prefer same-origin contentDocument field counts; otherwise navigate to https iframe src.
 */
export async function tryAdoptFormIframe(page, snap, log) {
  const weakMain =
    ((snap?.fieldCount || 0) === 0 &&
      (snap?.fileInputCount || 0) === 0 &&
      (snap?.entryCount || 0) === 0 &&
      !(snap?.hasApplyModal)) ||
    ((snap?.fieldCount || 0) <= 1 && (snap?.customControlCount || 0) === 0 && !(snap?.hasApplyModal));
  if (!weakMain) return { page, adopted: false };

  let info = null;
  try {
    info = await page.evaluate(() => {
      const iframes = [...document.querySelectorAll("iframe")].filter((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 200 && r.height > 180 && getComputedStyle(el).visibility !== "hidden";
      });
      for (const iframe of iframes) {
        const src = iframe.getAttribute("src") || "";
        try {
          const doc = iframe.contentDocument;
          if (doc) {
            const n = doc.querySelectorAll(
              'input:not([type="hidden"]), textarea, select, input[type="file"], button, [role="button"]',
            ).length;
            if (n >= 2 && /^https?:/i.test(src)) {
              return { src, fields: n, sameOrigin: true };
            }
          }
        } catch {
          /* cross-origin */
        }
        if (/^https?:/i.test(src) && !/ads?|doubleclick|googlesyndication|facebook|twitter/i.test(src)) {
          return { src, fields: 0, sameOrigin: false };
        }
      }
      return null;
    });
  } catch {
    return { page, adopted: false };
  }

  if (!info?.src || !/^https?:/i.test(info.src)) return { page, adopted: false };

  // Same-origin with fields is best; cross-origin embeds are adopted only when the
  // iframe URL path suggests an application surface (generic path tokens, not hosts).
  if (!info.sameOrigin && !info.fields) {
    try {
      const u = new URL(info.src);
      if (!/apply|application|job|jobs|career|form|embed|portal|candidate/i.test(`${u.pathname}${u.search}`)) {
        return { page, adopted: false };
      }
    } catch {
      return { page, adopted: false };
    }
  }

  log?.layer("agent", `adopting form iframe → ${info.src.slice(0, 120)}`, "info");
  try {
    await page.goto(info.src, { waitUntil: "domcontentloaded", timeout: 35000 });
    return { page, adopted: true };
  } catch (err) {
    log?.layer("agent", `iframe adopt failed: ${err?.message || err}`, "warn");
    return { page, adopted: false };
  }
}
