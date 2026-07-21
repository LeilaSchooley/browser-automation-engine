/**
 * Name-attribute → mappedTo vocabulary.
 * Prefer `name=` over label text — stable across ATS boards; labels change copy often.
 */

/** Canonical HTML `name` (brackets stripped) → engine mappedTo. */
export const STRONG_NAME_MAP = {
  role: { mappedTo: "jobfunction", type: "jobfunction", widgetType: "radio" },
  job_function: { mappedTo: "jobfunction", type: "jobfunction", widgetType: "radio" },
  job_type: { mappedTo: "employmenttype", type: "employmenttype", widgetType: "checkbox" },
  in_school: { mappedTo: "fulltimestudent", type: "fulltimestudent", widgetType: "yesno" },
  student: { mappedTo: "fulltimestudent", type: "fulltimestudent", widgetType: "yesno" },
  eng_type: { mappedTo: "engroles", type: "engroles", widgetType: "combobox" },
  school_name: { mappedTo: "schoolname", type: "schoolname", widgetType: "text" },
  school: { mappedTo: "schoolname", type: "schoolname", widgetType: "text" },
  role_interest: { mappedTo: "roleinterest", type: "roleinterest", widgetType: "radio" },
  experience: { mappedTo: "experienceyears", type: "experienceyears", widgetType: "text" },
  github: { mappedTo: "githuburl", type: "githuburl", widgetType: "text" },
};

/** Normalize `job_type[]` / `job_type[0]` → `job_type`. */
export function normalizeFieldName(name = "") {
  return String(name || "")
    .trim()
    .replace(/\[\d*\]$/, "")
    .toLowerCase();
}

/**
 * @param {string} name
 * @returns {{ mappedTo: string, type: string, widgetType?: string }|null}
 */
export function mapByFieldName(name) {
  const key = normalizeFieldName(name);
  if (!key) return null;
  return STRONG_NAME_MAP[key] || null;
}

/** Serializable for page.evaluate injection. */
export function serializeFieldNameMap() {
  return Object.entries(STRONG_NAME_MAP).map(([name, meta]) => ({
    name,
    mappedTo: meta.mappedTo,
    type: meta.type,
    widgetType: meta.widgetType || "",
  }));
}
