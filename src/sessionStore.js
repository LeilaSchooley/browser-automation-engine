/**
 * Persistent Playwright storageState per hostname.
 */
import fs from "fs";
import path from "path";
import { getSettings } from "./runtime.js";
import { normalizeHost } from "./host.js";

function sessionsDir() {
  return getSettings().browser_sessions_dir || "";
}

function sessionFileKey(hostname) {
  return normalizeHost(hostname).replace(/[^a-z0-9.-]/g, "_");
}

export function sessionPathForHost(hostname) {
  const dir = sessionsDir();
  if (!dir || !hostname) return "";
  return path.join(dir, `${sessionFileKey(hostname)}.json`);
}

export function loadStorageState(hostname) {
  const filePath = sessionPathForHost(hostname);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function saveStorageState(context, hostname) {
  const filePath = sessionPathForHost(hostname);
  if (!filePath || !context) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  await context.storageState({ path: filePath });
  return true;
}

export async function applyStorageStateToContext(browser, hostname) {
  const state = loadStorageState(hostname);
  if (!state) return browser.newContext();
  return browser.newContext({ storageState: state });
}
