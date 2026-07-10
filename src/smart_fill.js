/**
 * Smart form fill engine — ported from Smart AutoFill (autofill extension).
 * Runs inside Playwright page.evaluate() with (config, siteMappings).
 */
function runSmartFill(config, siteMappings) {
  config = config || {};
  siteMappings = siteMappings || {};

  function normalizeNamingToTokens(raw) {
    if (raw == null) return "";
    let s = String(raw).trim();
    if (!s) return "";
    s = s.replace(/[_-]+/g, " ");
    s = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2");
    return s.toLowerCase().replace(/\s+/g, " ").trim();
  }

  function expandNamingVariants(raw) {
    const norm = normalizeNamingToTokens(raw);
    if (!norm) return [];
    const set = new Set([norm, norm.replace(/\s+/g, ""), norm.replace(/\s+/g, "_"), norm.replace(/\s+/g, "-")]);
    norm.split(" ").forEach((w) => { if (w.length > 1) set.add(w); });
    return [...set];
  }

  function joinClueTokens(...parts) {
    const bag = new Set();
    parts.forEach((p) => {
      if (p == null || p === "") return;
      const chunk = String(p).trim().slice(0, 160);
      if (!chunk) return;
      expandNamingVariants(chunk).forEach((t) => bag.add(t));
      normalizeNamingToTokens(chunk).split(" ").forEach((w) => { if (w.length > 1) bag.add(w); });
    });
    return Array.from(bag).join(" ");
  }

  function buildFieldClueBlob(field) {
    if (!field) return "";
    const chunks = [];
    const push = (v) => { if (v != null && v !== "") chunks.push(String(v).trim().slice(0, 200)); };
    push(field.id);
    push(field.name);
    push(field.getAttribute("autocomplete"));
    push(field.placeholder);
    push(field.getAttribute("aria-label"));
    push(field.getAttribute("title"));
    ["data-test", "data-testid", "data-cy", "data-field", "ng-model"].forEach((a) => push(field.getAttribute(a)));
    try {
      if (field.labels && field.labels.length) {
        Array.from(field.labels).forEach((l) => { if (l && l.textContent) push(l.textContent); });
      }
    } catch (e) { /* */ }
    if (field.id) {
      try {
        const lab = document.querySelector('label[for="' + field.id.replace(/"/g, '\\"') + '"]');
        if (lab && lab.textContent) push(lab.textContent);
      } catch (e) { /* */ }
    }
    const wrap = field.parentElement;
    if (wrap) {
      const lbl = wrap.querySelector(":scope > label");
      if (lbl && lbl.textContent) push(lbl.textContent);
    }
    return joinClueTokens(...chunks);
  }

  function collectElementsDeep(root, selector, bucket) {
    if (!root) return;
    try { root.querySelectorAll(selector).forEach((el) => bucket.push(el)); } catch (e) { /* */ }
    let nodes;
    try { nodes = root.querySelectorAll("*"); } catch (e) { return; }
    for (const host of nodes) {
      if (host.shadowRoot) collectElementsDeep(host.shadowRoot, selector, bucket);
    }
  }

  function isLikelyVisibleField(el) {
    if (!el) return false;
    if (el.offsetParent !== null) return true;
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    } catch (e) {
      return false;
    }
  }

  function generateStableSelector(el) {
    if (!el) return null;
    const tag = (el.tagName || "input").toLowerCase();
    if (el.id) {
      try {
        const esc = el.id.replace(/[^\w-]/g, "\\$&");
        if (document.querySelectorAll("#" + esc).length === 1) return "#" + esc;
        return tag + '[id="' + el.id + '"]';
      } catch (e) { /* */ }
    }
    if (el.name) {
      try {
        const sel = tag + '[name="' + el.name + '"]';
        if (document.querySelectorAll(sel).length === 1) return sel;
      } catch (e) { /* */ }
    }
    for (const attr of ["data-testid", "data-test", "data-cy", "data-field"]) {
      const val = el.getAttribute(attr);
      if (val) {
        try {
          const sel = tag + "[" + attr + '="' + val + '"]';
          if (document.querySelectorAll(sel).length === 1) return sel;
        } catch (e) { /* */ }
      }
    }
    return tag + (el.name ? '[name="' + el.name + '"]' : "");
  }

  const FIELD_TYPE_RULES = {
    email: {
      autocomplete: ["email"],
      inputType: ["email"],
      keywords: ["email", "e mail", "emailaddress", "email address"],
      antiKeywords: ["confirm", "repeat", "firstname", "lastname", "phone"],
      points: { autocomplete: 100, inputType: 80, keyword: 40 },
    },
    fullname: {
      autocomplete: ["name"],
      keywords: ["full name", "fullname", "applicant name", "legal name", "your name"],
      antiKeywords: ["username", "company", "email", "phone", "first name", "last name"],
      points: { autocomplete: 35, keyword: 70 },
    },
    firstname: {
      autocomplete: ["given-name"],
      keywords: ["first name", "firstname", "given name", "forename"],
      antiKeywords: ["last", "surname", "company", "username"],
      points: { autocomplete: 100, keyword: 60 },
    },
    lastname: {
      autocomplete: ["family-name"],
      keywords: ["last name", "lastname", "surname", "family name"],
      antiKeywords: ["first", "given", "company", "username"],
      points: { autocomplete: 100, keyword: 60 },
    },
    tel: {
      autocomplete: ["tel", "tel-national"],
      inputType: ["tel"],
      keywords: ["phone", "telephone", "mobile", "cell", "contact number"],
      antiKeywords: ["email", "fax"],
      points: { autocomplete: 100, inputType: 70, keyword: 50 },
    },
    linkedinurl: {
      inputType: ["url", "text"],
      keywords: ["linkedin", "linkedin url", "linkedin profile"],
      antiKeywords: ["email", "twitter", "github"],
      points: { keyword: 70 },
    },
    website: {
      autocomplete: ["url"],
      inputType: ["url"],
      keywords: ["website", "portfolio", "personal site"],
      antiKeywords: ["linkedin", "github"],
      points: { autocomplete: 80, inputType: 70, keyword: 50 },
    },
    coverletter: {
      inputType: ["textarea"],
      keywords: [
        "cover letter", "coverletter", "cover_letter",
        "why interested", "why are you", "tell us about yourself",
        "additional information", "message to hiring", "motivation",
        "introduction", "about you",
      ],
      antiKeywords: ["company", "website"],
      points: { keyword: 70, inputType: 30 },
    },
    resume: {
      inputType: ["file"],
      keywords: ["resume", "cv", "curriculum", "upload file", "attach"],
      antiKeywords: ["photo", "picture", "avatar"],
      points: { keyword: 80, inputType: 100 },
    },
    description: {
      keywords: ["description", "summary", "bio", "details"],
      antiKeywords: ["job description"],
      points: { keyword: 40 },
    },
  };

  function scoreFieldForType(field, fieldType) {
    const rules = FIELD_TYPE_RULES[fieldType];
    if (!rules) return 0;
    const blob = buildFieldClueBlob(field);
    const inputType = (field.type || "").toLowerCase();
    const tagName = (field.tagName || "").toLowerCase();
    const autocomplete = (field.getAttribute("autocomplete") || "").toLowerCase().trim();
    if (rules.antiKeywords) {
      for (const anti of rules.antiKeywords) {
        const escaped = anti.replace(/[-_ ]/g, "[-_ ]?");
        if (new RegExp("(^|[\\s_\\-|])(" + escaped + ")([\\s_\\-|]|$)", "i").test(blob)) return -1;
      }
    }
    let score = 0;
    if (rules.autocomplete && autocomplete) {
      for (const ac of rules.autocomplete) {
        if (autocomplete === ac || autocomplete.startsWith(ac + " ")) {
          score += rules.points.autocomplete || 80;
          break;
        }
      }
    }
    if (rules.inputType) {
      for (const t of rules.inputType) {
        if (t === "textarea" ? tagName === "textarea" : inputType === t) {
          score += rules.points.inputType || 40;
          break;
        }
      }
    }
    if (rules.keywords) {
      for (const kw of rules.keywords) {
        const escaped = kw.replace(/[-_ ]/g, "[-_ ]?");
        if (new RegExp("(^|[\\s_\\-|])(" + escaped + ")([\\s_\\-|]|$)", "i").test(blob)) {
          score += rules.points.keyword || 40;
          break;
        }
      }
    }
    return score;
  }

  const FILLABLE_SELECTOR =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea, select';

  function getAllFillable() {
    const all = [];
    collectElementsDeep(document, FILLABLE_SELECTOR, all);
    document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        if (iframe.contentDocument) collectElementsDeep(iframe.contentDocument, FILLABLE_SELECTOR, all);
      } catch (e) { /* cross-origin */ }
    });
    return all;
  }

  function scanDomFields() {
    const all = getAllFillable();
    const activeTypes = Object.keys(FIELD_TYPE_RULES);
    const best = {};
    for (const el of all) {
      if (el.value && String(el.value).trim()) continue;
      if (el.disabled || el.readOnly) continue;
      if (!isLikelyVisibleField(el)) continue;
      for (const fieldType of activeTypes) {
        const score = scoreFieldForType(el, fieldType);
        if (score <= 0) continue;
        if (!best[fieldType] || score > best[fieldType].score) {
          best[fieldType] = { score, selector: generateStableSelector(el) };
        }
      }
    }
    return best;
  }

  function setFieldValue(el, value) {
    if (!el || value == null) return false;
    const str = String(value);
    if (el.tagName === "SELECT") {
      const opts = Array.from(el.options || []);
      const match = opts.find((o) => o.text.toLowerCase().includes(str.toLowerCase()) || o.value.toLowerCase() === str.toLowerCase());
      if (match) {
        el.value = match.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      return false;
    }
    el.focus();
    el.value = str;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function findElement(selector) {
    if (!selector) return null;
    try {
      let el = document.querySelector(selector);
      if (el) return el;
    } catch (e) { /* */ }
    const bucket = [];
    collectElementsDeep(document, selector, bucket);
    return bucket[0] || null;
  }

  const CONFIG_KEY_MAP = {
    firstName: "firstname",
    lastName: "lastname",
    fullName: "fullname",
    email: "email",
    phone: "tel",
    coverLetter: "coverletter",
    linkedinUrl: "linkedinurl",
    websiteUrl: "website",
    resumePath: "resume",
  };

  const TYPE_VALUE = {
    email: config.email,
    firstname: config.firstName,
    lastname: config.lastName,
    fullname: config.fullName || [config.firstName, config.lastName].filter(Boolean).join(" "),
    tel: config.phone,
    coverletter: config.coverLetter,
    linkedinurl: config.linkedinUrl,
    website: config.websiteUrl,
    resume: config.resumePath,
  };

  const MIN_SCORE = {
    email: 40, firstname: 50, lastname: 50, fullname: 50, tel: 50,
    coverletter: 50, linkedinurl: 60, website: 50, resume: 70, description: 40,
  };

  const filled = [];
  const siteMapped = [];

  // Site-specific mappings (from autofill Field Mapper export)
  const hostMappings = siteMappings[window.location.hostname] || {};
  Object.keys(hostMappings).forEach((selector) => {
    const mapping = hostMappings[selector];
    const mappedTo = mapping.mappedTo || mapping;
    const fieldType = CONFIG_KEY_MAP[mappedTo] || mappedTo;
    const valueKey = mappedTo;
    let value = config[valueKey];
    if (mappedTo === "fullName") value = TYPE_VALUE.fullname;
    if (!value) return;
    const el = findElement(selector);
    if (!el || (el.value && String(el.value).trim())) return;
    if (el.type === "file") {
      filled.push({ type: fieldType, selector, score: 100, file: true });
      return;
    }
    if (setFieldValue(el, value)) {
      filled.push({ type: fieldType, selector, score: 100, source: "site_mapping" });
      siteMapped.push(selector);
    }
  });

  const domMap = scanDomFields();
  for (const [fieldType, best] of Object.entries(domMap)) {
    const value = String(TYPE_VALUE[fieldType] || "").trim();
    if (!value) continue;
    const minScore = MIN_SCORE[fieldType] || 50;
    if (best.score < minScore) continue;
    if (filled.some((f) => f.type === fieldType)) continue;
    const el = findElement(best.selector);
    if (!el) continue;
    if (el.type === "file") {
      filled.push({ type: fieldType, selector: best.selector, score: best.score, file: true });
      continue;
    }
    if (setFieldValue(el, value)) {
      filled.push({ type: fieldType, selector: best.selector, score: best.score, source: "dom_scan" });
    }
  }

  // Fallback: lone empty textarea → cover letter
  if (config.coverLetter && !filled.some((f) => f.type === "coverletter")) {
    const textareas = getAllFillable().filter((el) => el.tagName === "TEXTAREA" && !el.value);
    if (textareas.length === 1 && isLikelyVisibleField(textareas[0])) {
      const el = textareas[0];
      if (setFieldValue(el, config.coverLetter)) {
        filled.push({
          type: "coverletter",
          selector: generateStableSelector(el),
          score: 30,
          source: "textarea_fallback",
        });
      }
    }
  }

  const filledSelectors = new Set(filled.map((f) => f.selector));
  const unfilled = [];
  for (const el of getAllFillable()) {
    if (el.value && String(el.value).trim()) continue;
    if (el.disabled || el.readOnly) continue;
    if (!isLikelyVisibleField(el)) continue;
    const selector = generateStableSelector(el);
    if (filledSelectors.has(selector)) continue;
    const clue = buildFieldClueBlob(el);
    if (!clue && el.tagName !== "SELECT") continue;
    const entry = {
      selector,
      clue,
      tagName: el.tagName.toLowerCase(),
      inputType: (el.type || "").toLowerCase(),
      required: el.required || el.getAttribute("aria-required") === "true",
    };
    if (el.tagName === "SELECT") {
      entry.options = Array.from(el.options || []).slice(0, 20).map((o) => o.text.trim()).filter(Boolean);
    }
    unfilled.push(entry);
  }

  return { filled, unfilled, siteMapped, hostname: window.location.hostname };
}
