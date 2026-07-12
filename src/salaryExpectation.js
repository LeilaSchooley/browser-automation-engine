/**
 * Salary expectation resolution — site-agnostic parsing from listing/context.
 * Apps may add LLM research when this returns empty.
 */

/** Extract a salary/range string from free text (description, listing blob). */
export function parseSalaryFromText(text) {
  const s = String(text || "").replace(/\s+/g, " ");
  if (!s.trim()) return "";

  const patterns = [
    /\$[\d,]+(?:\.\d+)?\s*k?\s*[-–—to]+\s*\$?[\d,]+(?:\.\d+)?\s*k?/gi,
    /£[\d,]+(?:\.\d+)?\s*k?\s*[-–—to]+\s*£?[\d,]+(?:\.\d+)?\s*k?/gi,
    /€[\d,]+(?:\.\d+)?\s*k?\s*[-–—to]+\s*€?[\d,]+(?:\.\d+)?\s*k?/gi,
    /(?:salary|compensation|pay|package)[:\s]*\$[\d,]+(?:k)?(?:\s*[-–—]\s*\$?[\d,]+(?:k)?)?/gi,
    /\$[\d]{2,3},?\d{3}\s*[-–—]\s*\$[\d,]+/g,
    /\$[\d]+k\s*[-–—]\s*\$?[\d]+k/gi,
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[0]) return m[0].replace(/\s+/g, " ").trim();
  }

  const annual = s.match(/\b(\d{2,3}),?(\d{3})\s*(?:per year|\/year|annually|pa)\b/i);
  if (annual) return `$${annual[1]},${annual[2]}`;

  return "";
}

/** Parse numeric salary values from a string (handles $120k, $120,000). */
export function parseSalaryNumbers(text) {
  const nums = [];
  const s = String(text || "").toLowerCase().replace(/,/g, "");
  const re = /[$£€]?\s*(\d+(?:\.\d+)?)\s*k\b/gi;
  let m;
  while ((m = re.exec(s))) {
    nums.push(Math.round(parseFloat(m[1]) * 1000));
  }
  const re2 = /[$£€]\s*(\d{2,3})(\d{3})\b/g;
  while ((m = re2.exec(s))) {
    nums.push(parseInt(m[1] + m[2], 10));
  }
  return [...new Set(nums.filter((n) => n >= 1000))];
}

/**
 * Pick the dropdown option closest to a target salary string.
 * @param {Array<{ value: string, text: string }>} options
 * @param {string} target
 */
export function pickClosestSalaryOption(options, target) {
  const opts = (options || []).filter((o) => o && String(o.text || "").trim());
  if (!opts.length) return null;

  const targetNums = parseSalaryNumbers(target);
  const mid = targetNums.length
    ? (Math.min(...targetNums) + Math.max(...targetNums)) / 2
    : 0;

  const lowerTarget = String(target || "").toLowerCase().trim();
  if (lowerTarget) {
    const exact =
      opts.find((o) => o.text.trim().toLowerCase() === lowerTarget) ||
      opts.find((o) => o.value.toLowerCase() === lowerTarget) ||
      (lowerTarget.length >= 3 ? opts.find((o) => o.text.toLowerCase().includes(lowerTarget)) : null);
    if (exact) return exact;
  }

  if (!mid) return null;

  let best = null;
  let bestDist = Infinity;
  for (const o of opts) {
    const nums = parseSalaryNumbers(o.text);
    if (!nums.length) continue;
    const lo = Math.min(...nums);
    const hi = Math.max(...nums);
    if (mid >= lo && mid <= hi) return o;
    const dist = mid < lo ? lo - mid : mid - hi;
    if (dist < bestDist) {
      bestDist = dist;
      best = o;
    }
  }
  return best;
}

/**
 * Resolve salary for form fill: explicit preferences → job listing → description.
 * @param {object} context
 * @param {{ userDefault?: string }} [opts]
 */
export function resolveSalaryExpectation(context = {}, opts = {}) {
  const userDefault = String(opts.userDefault || "").trim();
  if (userDefault) return userDefault;

  const p = context.preferences || {};
  const explicit = String(
    p.salary || p.salaryExpectation || p.salaryExpectations || context.salaryExpectation || "",
  ).trim();
  if (explicit) return explicit;

  const job = context.job || {};
  const listing = String(job.salary || "").trim();
  if (listing) return listing;

  const fromDesc = parseSalaryFromText(job.description || "");
  if (fromDesc) return fromDesc;

  const fromTitle = parseSalaryFromText(`${job.title || ""} ${job.company || ""}`);
  if (fromTitle) return fromTitle;

  return "";
}
