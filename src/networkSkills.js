/**
 * Network skill spike (Unbrowse-inspired, directory-first).
 *
 * Captures XHR/fetch POSTs during a browser session and stores reusable API
 * shapes under data/api_skills.json. Optional: shell out to `unbrowse` CLI when
 * UNBROWSE_ENABLED / settings.unbrowse_enabled is set — never required.
 *
 * NOT used as the primary job-apply path (uploads / ATS wizards stay browser).
 */
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { normalizeHost } from "./host.js";
import { getSettings } from "./runtime.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SKIP_HOST =
  /google-analytics|googletagmanager|facebook\.net|doubleclick|sentry\.io|segment\.io|hotjar|clarity\.ms|cdn\.|static\./i;

function skillsPath() {
  const configured = getSettings().api_skills_path || "";
  if (configured) return configured;
  return path.join(process.cwd(), "data", "api_skills.json");
}

export function loadApiSkills() {
  const filePath = skillsPath();
  if (!fs.existsSync(filePath)) return { hosts: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw?.hosts ? raw : { hosts: raw || {} };
  } catch {
    return { hosts: {} };
  }
}

export function saveApiSkill(hostname, skill) {
  const host = normalizeHost(hostname);
  if (!host || !skill?.url || !skill?.method) return null;
  const filePath = skillsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const store = loadApiSkills();
  if (!store.hosts[host]) store.hosts[host] = { skills: [] };
  const skills = store.hosts[host].skills || [];
  const key = `${skill.method} ${skill.path || skill.url}`;
  const existing = skills.find((s) => `${s.method} ${s.path || s.url}` === key);
  if (existing) {
    existing.successCount = (existing.successCount || 0) + 1;
    existing.lastSeen = new Date().toISOString();
  } else {
    skills.push({
      ...skill,
      successCount: 1,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    });
  }
  store.hosts[host].skills = skills.slice(-40);
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2));
  return store.hosts[host];
}

export function findApiSkill(hostname, intentHint = "submit") {
  const host = normalizeHost(hostname);
  const skills = loadApiSkills().hosts[host]?.skills || [];
  const hint = String(intentHint || "").toLowerCase();
  return (
    skills.find((s) => String(s.intent || "").toLowerCase().includes(hint)) ||
    skills.find((s) => /submit|apply|listing|post/i.test(`${s.path || ""} ${s.url || ""}`)) ||
    null
  );
}

/**
 * Attach Playwright request listener — harvest mutating XHR/fetch.
 * @param {import('playwright').Page} page
 * @param {{ hostname?: string, log?: object }} [opts]
 */
export function attachNetworkSkillCapture(page, opts = {}) {
  const log = opts.log || null;
  const captured = [];

  const onRequest = (req) => {
    try {
      const method = req.method();
      if (!MUTATING.has(method)) return;
      const url = req.url();
      const host = normalizeHost(url);
      if (!host || SKIP_HOST.test(host)) return;
      const resource = req.resourceType();
      if (resource !== "xhr" && resource !== "fetch") return;
      let pathname = "";
      try {
        pathname = new URL(url).pathname;
      } catch {
        pathname = url;
      }
      if (/\/(telemetry|analytics|log|beacon|pixel)/i.test(pathname)) return;

      const skill = {
        method,
        url: url.slice(0, 500),
        path: pathname.slice(0, 200),
        intent: guessIntent(pathname, method),
        contentType: req.headers()["content-type"] || "",
      };
      captured.push(skill);
      saveApiSkill(opts.hostname || host, skill);
      log?.layer("network_skills", `captured ${method} ${pathname.slice(0, 80)}`, "debug");
    } catch {
      /* ignore */
    }
  };

  page.on("request", onRequest);
  return {
    stop: () => {
      try {
        page.off("request", onRequest);
      } catch {
        /* ignore */
      }
    },
    captured: () => captured.slice(),
  };
}

function guessIntent(pathname, method) {
  const p = String(pathname || "").toLowerCase();
  if (/apply|application/.test(p)) return "submit_application";
  if (/submit|listing|post/.test(p)) return "submit_listing";
  if (/signup|register|auth/.test(p)) return "auth";
  return method === "POST" ? "mutate" : "mutate";
}

/**
 * Try optional Unbrowse CLI if installed — never blocks apply failure.
 * @param {{ intent: string, url?: string, log?: object }} opts
 */
export async function tryUnbrowseHole(opts = {}) {
  const settings = getSettings();
  if (!(settings.unbrowse_enabled || process.env.UNBROWSE_ENABLED === "1")) {
    return { ok: false, reason: "unbrowse_disabled" };
  }

  const intent = String(opts.intent || "").trim();
  if (!intent) return { ok: false, reason: "no_intent" };

  return new Promise((resolve) => {
    const args = [intent];
    if (opts.url) args.push("--url", opts.url);
    const child = spawn("unbrowse", args, { timeout: 45000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", (err) => {
      opts.log?.layer("unbrowse", `CLI missing: ${err.message}`, "debug");
      resolve({ ok: false, reason: "cli_missing" });
    });
    child.on("close", (code) => {
      if (code === 0 && stdout.trim()) {
        opts.log?.layer("unbrowse", "hole fill ok", "info");
        resolve({ ok: true, stdout: stdout.slice(0, 4000) });
      } else {
        resolve({ ok: false, reason: stderr.slice(0, 200) || `exit_${code}` });
      }
    });
  });
}

/**
 * Directory fast-path attempt: known API skill or optional Unbrowse.
 * @returns {Promise<{ ok: boolean, via?: string, reason?: string }>}
 */
export async function tryDirectoryApiFastPath(context = {}, opts = {}) {
  const settings = getSettings();
  if (!(settings.listing_mode || settings.network_skills_enabled || process.env.NETWORK_SKILLS_ENABLED === "1")) {
    return { ok: false, reason: "directory_fast_path_off" };
  }

  const host = normalizeHost(context.targetHost || context.hostname || context.url || "");
  if (!host) return { ok: false, reason: "no_host" };

  const skill = findApiSkill(host, opts.intent || "submit");
  if (skill && (skill.successCount || 0) >= 2) {
    opts.log?.layer(
      "network_skills",
      `fast-path candidate ${skill.method} ${skill.path} (successCount=${skill.successCount}) — browser still required for first authenticated replay spike`,
      "info",
    );
    // Spike only records + surfaces candidates; authenticated replay needs cookies from the live session.
    return { ok: false, via: "recorded_skill", reason: "replay_needs_session_cookies", skill };
  }

  const unbrowse = await tryUnbrowseHole({
    intent: opts.intent || `submit listing on ${host}`,
    url: context.url,
    log: opts.log,
  });
  if (unbrowse.ok) return { ok: true, via: "unbrowse", detail: unbrowse.stdout };

  return { ok: false, reason: "no_fast_path" };
}
