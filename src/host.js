/**
 * Shared hostname helpers — single source for host keys across stores/layers.
 */

export function normalizeHost(hostnameOrUrl = "") {
  const raw = String(hostnameOrUrl || "").trim();
  if (!raw || /^about:/i.test(raw) || /^data:/i.test(raw)) return "";
  try {
    const host = raw.includes("://") || raw.startsWith("//")
      ? new URL(raw.includes("://") ? raw : `https:${raw}`).hostname
      : raw;
    return String(host || "")
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    return raw.toLowerCase().replace(/^www\./, "");
  }
}

/** Alias used by session/auth stores. */
export function hostKey(hostname = "") {
  return normalizeHost(hostname);
}

export function hostnameFromUrl(url = "") {
  if (!url) return "";
  return normalizeHost(String(url).includes("://") ? url : `https://${url}`);
}

export function hostnameFromPage(page) {
  try {
    return normalizeHost(page.url());
  } catch {
    return "";
  }
}

/**
 * Resolve site-mapping entry for a hostname, walking parent domains if needed.
 * @param {Record<string, unknown>} mappings
 * @param {string} hostname
 */
export function resolveHostMapping(mappings = {}, hostname = "") {
  const key = normalizeHost(hostname);
  if (!key || !mappings || typeof mappings !== "object") return null;
  if (mappings[key]) return mappings[key];

  const parts = key.split(".");
  while (parts.length > 2) {
    parts.shift();
    const parent = parts.join(".");
    if (mappings[parent]) return mappings[parent];
  }
  return null;
}

/**
 * Whether the flow may legitimately hop across hosts (apply/redirect chains).
 * Directory-submission flows pin a submitUrl and must stay on the target site;
 * apply flows without one are expected to chain through external hosts.
 */
export function allowsHostHop(context = {}) {
  if (context.allowHostHop === true) return true;
  if (context.allowHostHop === false) return false;
  return !context.submitUrl;
}

export function targetHostFromContext(context = {}, fallbackUrl = "") {
  return (
    normalizeHost(context.targetHost) ||
    normalizeHost(context.submitUrl) ||
    normalizeHost(context.startUrl) ||
    normalizeHost(fallbackUrl)
  );
}
