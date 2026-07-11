import fs from "fs";
import { getRuntime, getSettings } from "./runtime.js";
import { learningsAsSiteMappings, mergeSiteMappings } from "./siteLearnings.js";

export function loadSiteMappingsFromPath(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {};
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (data.domains && typeof data.domains === "object") {
      return data.domains;
    }
    if (data.siteMappings && typeof data.siteMappings === "object") {
      return data.siteMappings;
    }
    if (typeof data === "object" && Object.values(data).every((v) => typeof v === "object")) {
      return data;
    }
  } catch {
    return {};
  }
  return {};
}

export function loadSiteMappings() {
  const runtimeLoader = getRuntime().loadSiteMappings;
  if (runtimeLoader) {
    const loaded = runtimeLoader();
    if (loaded && typeof loaded === "object") {
      return mergeSiteMappings(loaded, learningsAsSiteMappings());
    }
  }
  const base = loadSiteMappingsFromPath(getSettings().site_mappings_path);
  return mergeSiteMappings(base, learningsAsSiteMappings());
}
