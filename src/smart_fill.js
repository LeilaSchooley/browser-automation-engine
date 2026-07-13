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
    s = s.replace(/[[\]_-]+/g, " ");
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
    push(String(field.className || "").slice(0, 120));
    let hasOwnLabel = false;
    try {
      if (field.labels && field.labels.length) {
        hasOwnLabel = true;
        Array.from(field.labels).forEach((l) => { if (l && l.textContent) push(l.textContent); });
      }
    } catch (e) { /* */ }
    if (field.id) {
      try {
        const lab = document.querySelector('label[for="' + field.id.replace(/"/g, '\\"') + '"]');
        if (lab && lab.textContent) { hasOwnLabel = true; push(lab.textContent); }
      } catch (e) { /* */ }
    }
    // Only trust a wrapper label when the field has no label of its own AND the
    // wrapper label isn't for= some other field — otherwise a sibling's label
    // ("Email") poisons this field's clue and anti-keywords veto valid matches.
    if (!hasOwnLabel) {
      const wrap = field.parentElement;
      if (wrap) {
        const lbl = wrap.querySelector(":scope > label");
        if (lbl && (!lbl.htmlFor || lbl.htmlFor === field.id) && lbl.textContent) push(lbl.textContent);
      }
    }
    return joinClueTokens(...chunks);
  }

  function ownLabelText(field) {
    try {
      if (field.labels && field.labels.length) {
        return String(field.labels[0].textContent || "").replace(/[*:]/g, "").trim().toLowerCase();
      }
      if (field.id) {
        const lab = document.querySelector('label[for="' + field.id.replace(/"/g, '\\"') + '"]');
        if (lab) return String(lab.textContent || "").replace(/[*:]/g, "").trim().toLowerCase();
      }
    } catch (e) { /* */ }
    return "";
  }

  function hasUserValue(el) {
    // A select always reports its default first option as "value" — only a
    // non-first selection counts as user input.
    if ((el.tagName || "") === "SELECT") return el.selectedIndex > 0;
    return !!(el.value && String(el.value).trim());
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
    try {
      const cs = window.getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      // 1x1 clip-hidden helper inputs (dropzone validation fields etc.) are not
      // real fields — typing into them corrupts the fill.
      return r.width > 2 && r.height > 2;
    } catch (e) {
      return false;
    }
  }

  /** WPForms/Dropzone fake text inputs used for upload validation — not real fields. */
  function isDropzoneCompanionInput(el) {
    if (!el) return false;
    if ((el.type || "").toLowerCase() === "file") return false;
    if ((el.className || "").includes("dropzone-input")) return true;
    try {
      return !!el.closest(".wpforms-uploader, .dz-clickable, [class*='uploader' i][data-field-id]");
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
    // Never fall back to a bare tag selector — querying "input" later resolves
    // to the FIRST input on the page and fills the wrong field. Build a
    // positional path instead.
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && depth < 6) {
      let sel = (node.tagName || "").toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = parent;
      depth += 1;
    }
    return parts.join(" > ") || tag;
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
      keywords: ["first name", "firstname", "given name", "forename", "name first"],
      antiKeywords: ["last", "surname", "company", "username"],
      exactLabels: ["first", "first name", "given name", "forename"],
      points: { autocomplete: 100, keyword: 60 },
    },
    lastname: {
      autocomplete: ["family-name"],
      keywords: ["last name", "lastname", "surname", "family name", "name last"],
      antiKeywords: ["first", "given", "company", "username"],
      exactLabels: ["last", "last name", "surname", "family name"],
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
      // inputType text is nearly meaningless for linkedin — keyword must carry it
      points: { keyword: 70, inputType: 5 },
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
        "why interested", "why are you",
        "message to hiring", "motivation",
      ],
      antiKeywords: [
        "company", "website", "upload", "attach", "drag", "drop", "file",
        "additional information", "anything else", "other information",
        "tell us about yourself", "salary", "desired job", "location",
      ],
      points: { keyword: 70, inputType: 30 },
    },
    additionalinfo: {
      inputType: ["textarea"],
      keywords: [
        "additional information", "anything else", "other information",
        "comments or questions", "optional message", "notes",
      ],
      antiKeywords: ["cover letter", "upload", "attach", "resume", "cv"],
      points: { keyword: 80, inputType: 20 },
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
    address1: {
      autocomplete: ["address-line1", "street-address"],
      keywords: ["address line 1", "address1", "street address", "address"],
      antiKeywords: ["line 2", "address2", "email", "ip address"],
      points: { autocomplete: 100, keyword: 60 },
    },
    address2: {
      autocomplete: ["address-line2"],
      keywords: ["address line 2", "address2", "apt", "suite", "unit number"],
      antiKeywords: ["line 1", "address1"],
      points: { autocomplete: 100, keyword: 60 },
    },
    city: {
      autocomplete: ["address-level2"],
      keywords: ["city", "town", "locality"],
      antiKeywords: ["state", "country", "postal"],
      points: { autocomplete: 100, keyword: 60 },
    },
    state: {
      autocomplete: ["address-level1"],
      keywords: ["state", "province", "region", "state province"],
      antiKeywords: ["country", "city", "united"],
      points: { autocomplete: 100, keyword: 55 },
    },
    zip: {
      autocomplete: ["postal-code"],
      keywords: ["postal code", "zip code", "zip", "postcode", "postal"],
      antiKeywords: ["city", "country"],
      points: { autocomplete: 100, keyword: 60 },
    },
    country: {
      autocomplete: ["country", "country-name"],
      keywords: ["country"],
      antiKeywords: ["country code", "dial", "location"],
      points: { autocomplete: 100, keyword: 60 },
    },
    location: {
      autocomplete: ["address-level2"],
      keywords: ["location", "where are you", "based in", "your location", "city region"],
      antiKeywords: ["job location", "office location", "company location"],
      points: { autocomplete: 80, keyword: 65 },
    },
    desiredtitle: {
      inputType: ["text"],
      keywords: [
        "desired job title", "job title", "desired role", "position sought",
        "role you want", "target role", "preferred role",
      ],
      antiKeywords: ["current job", "previous job", "company name", "employer"],
      points: { keyword: 70, inputType: 20 },
    },
    salary: {
      keywords: [
        "salary", "salary expectations", "compensation", "pay expectation",
        "expected salary", "desired salary", "expected pay",
      ],
      antiKeywords: ["job salary", "posted salary", "salary range"],
      points: { keyword: 75 },
    },
  };

  function scoreFieldForType(field, fieldType) {
    const rules = FIELD_TYPE_RULES[fieldType];
    if (!rules) return 0;
    // Sublabel patterns ("First"/"Last" under a Name legend) identify the field
    // outright — check before anti-keywords, which sibling text can trip.
    if (rules.exactLabels) {
      const own = ownLabelText(field);
      if (own && rules.exactLabels.indexOf(own) !== -1) return 90;
    }
    const className = String(field.className || "");
    if (fieldType === "firstname" && /wpforms-field-name-first/i.test(className)) return 95;
    if (fieldType === "lastname" && /wpforms-field-name-last/i.test(className)) return 95;
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

  function isSiteSearchField(el) {
    if ((el.type || "").toLowerCase() === "search") return true;
    if ((el.getAttribute && (el.getAttribute("role") || "").toLowerCase()) === "searchbox") return true;
    const blob = `${el.name || ""} ${el.id || ""} ${el.placeholder || ""} ${(el.getAttribute && el.getAttribute("aria-label")) || ""}`.toLowerCase();
    if (/\bsearch\b|\bquery\b/.test(blob)) return true;
    try {
      return !!el.closest("[role='search'], form[action*='search' i]");
    } catch (e) {
      return false;
    }
  }

  function scanDomFields() {
    const all = getAllFillable();
    const activeTypes = Object.keys(FIELD_TYPE_RULES);
    const best = {};
    for (const el of all) {
      if (hasUserValue(el)) continue;
      if (el.disabled || el.readOnly) continue;
      if (isDropzoneCompanionInput(el)) continue;
      const isFile = (el.type || "").toLowerCase() === "file";
      // File inputs are legitimately hidden behind dropzones — keep them.
      if (!isFile && !isLikelyVisibleField(el)) continue;
      if (!isFile && isSiteSearchField(el)) continue;
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

  function applyPreferencesPositionHeuristic(bestMap) {
    const blob = (document.body?.innerText || "").toLowerCase();
    if (!/tell us about yourself|salary expectations|desired job title/i.test(blob)) return;
    if (bestMap.salary) return;
    const candidates = getAllFillable().filter((el) => {
      if (hasUserValue(el) || el.disabled || el.readOnly) return false;
      if (!isLikelyVisibleField(el) || isSiteSearchField(el)) return false;
      const clue = buildFieldClueBlob(el).toLowerCase();
      if (/email|password|phone|first name|last name/.test(clue)) return false;
      return true;
    });
    const emptySelect = candidates.find((el) => (el.tagName || "").toLowerCase() === "select");
    if (emptySelect) {
      bestMap.salary = { score: 75, selector: generateStableSelector(emptySelect) };
      return;
    }
    const unlabeled = candidates.find((el) => {
      const label = ownLabelText(el) || String(el.placeholder || "").trim();
      return !label || label === "?" || /salary|compensation/i.test(buildFieldClueBlob(el));
    });
    if (unlabeled) {
      bestMap.salary = { score: 70, selector: generateStableSelector(unlabeled) };
    }
  }

  function setFieldValue(el, value) {
    if (!el || value == null) return false;
    const str = String(value);
    if (el.tagName === "SELECT") {
      const opts = Array.from(el.options || []);
      const lower = str.toLowerCase();
      // Exact value/text match first — substring matching alone picks
      // "Australia" for "us" because of the embedded letters.
      const match =
        opts.find((o) => o.value.toLowerCase() === lower || o.text.trim().toLowerCase() === lower) ||
        (lower.length >= 3 ? opts.find((o) => o.text.toLowerCase().includes(lower)) : null);
      if (match) {
        el.value = match.value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      if (/salary|compensation|pay/i.test(buildFieldClueBlob(el))) {
        const parseNums = (t) => {
          const nums = [];
          const s = String(t || "").toLowerCase().replace(/,/g, "");
          let m;
          const reK = /[$£€]?\s*(\d+(?:\.\d+)?)\s*k\b/gi;
          while ((m = reK.exec(s))) nums.push(Math.round(parseFloat(m[1]) * 1000));
          const reFull = /[$£€]\s*(\d{2,3})(\d{3})\b/g;
          while ((m = reFull.exec(s))) nums.push(parseInt(m[1] + m[2], 10));
          return nums.filter((n) => n >= 1000);
        };
        const picked = typeof __pickClosestSalaryOption === "function"
          ? __pickClosestSalaryOption(opts, str)
          : null;
        if (picked) {
          el.value = picked.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
        const targetNumsLegacy = parseNums(str);
        const mid = targetNumsLegacy.length
          ? (Math.min.apply(null, targetNumsLegacy) + Math.max.apply(null, targetNumsLegacy)) / 2
          : 0;
        if (mid) {
          let best = null;
          let bestDist = Infinity;
          for (let i = 0; i < opts.length; i += 1) {
            const o = opts[i];
            if (!String(o.text || "").trim()) continue;
            const nums = parseNums(o.text);
            if (!nums.length) continue;
            const lo = Math.min.apply(null, nums);
            const hi = Math.max.apply(null, nums);
            if (mid >= lo && mid <= hi) {
              el.value = o.value;
              el.dispatchEvent(new Event("change", { bubbles: true }));
              return true;
            }
            const dist = mid < lo ? lo - mid : mid - hi;
            if (dist < bestDist) {
              bestDist = dist;
              best = o;
            }
          }
          if (best) {
            el.value = best.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
            return true;
          }
        }
        const fallback = opts.find((o, i) => i > 0 && String(o.text || "").trim());
        if (fallback) {
          el.value = fallback.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return true;
        }
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
    location: "location",
    desiredJobTitle: "desiredtitle",
    desiredTitle: "desiredtitle",
    salary: "salary",
    salaryExpectation: "salary",
    salaryExpectations: "salary",
  };

  const TYPE_VALUE = {
    email: config.email,
    firstname: config.firstName,
    lastname: config.lastName,
    fullname: config.fullName || [config.firstName, config.lastName].filter(Boolean).join(" "),
    tel: config.phone,
    coverletter: config.coverLetter,
    additionalinfo: config.fillAdditionalInfo ? config.coverLetter : "",
    linkedinurl: config.linkedinUrl,
    website: config.websiteUrl,
    resume: config.resumePath,
    address1: config.addressLine1,
    address2: config.addressLine2,
    city: config.city,
    state: config.state,
    zip: config.postalCode,
    country: config.country,
    location: config.location,
    desiredtitle: config.desiredJobTitle || config.desiredTitle,
    salary: config.salary || config.salaryExpectation || config.salaryExpectations,
  };

  const MIN_SCORE = {
    email: 40, firstname: 50, lastname: 50, fullname: 50, tel: 50,
    coverletter: 50, additionalinfo: 55, linkedinurl: 60, website: 50, resume: 70, description: 40,
    address1: 50, address2: 60, city: 50, state: 50, zip: 50, country: 50,
    location: 55, desiredtitle: 55, salary: 55,
  };

  const DEFERRED_TYPES = ["coverletter", "additionalinfo"];
  const LONG_TEXT_TYPES = new Set(DEFERRED_TYPES);

  function isAdditionalInfoBlob(blob) {
    return /additional\s*information|anything\s*else|other\s*information|comments\s*or\s*questions/i.test(blob || "");
  }

  function shouldDeferFill(fieldType, el) {
    if (LONG_TEXT_TYPES.has(fieldType)) return true;
    if (!config.deferTextFill) return false;
    if (!el) return false;
    if (el.tagName === "SELECT") return false;
    if ((el.type || "").toLowerCase() === "file") return false;
    return true;
  }

  function fieldPosition(el) {
    if (!el) return { top: 1e9, left: 0 };
    try {
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top + (window.scrollY || 0)),
        left: Math.round(r.left + (window.scrollX || 0)),
      };
    } catch (e) {
      return { top: 1e9, left: 0 };
    }
  }

  function withPosition(entry, el) {
    const pos = fieldPosition(el || (entry.selector ? findElement(entry.selector) : null));
    entry.top = pos.top;
    entry.left = pos.left;
    return entry;
  }

  function pushFilled(entry, el) {
    filled.push(withPosition(entry, el));
  }

  function resolveHostMappings(mappings, hostname) {
    const key = String(hostname || "").toLowerCase().replace(/^www\./, "");
    if (!key || !mappings || typeof mappings !== "object") return {};
    if (mappings[key]) return mappings[key];
    const parts = key.split(".");
    while (parts.length > 2) {
      parts.shift();
      const parent = parts.join(".");
      if (mappings[parent]) return mappings[parent];
    }
    return {};
  }

  const filled = [];
  const siteMapped = [];

  // Site-specific mappings (from autofill Field Mapper export + learnings)
  const hostMappings = resolveHostMappings(siteMappings, window.location.hostname);
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
      filled.push(withPosition({ type: fieldType, selector, score: 100, file: true }, el));
      return;
    }
    if (fieldType === "additionalinfo" && !config.fillAdditionalInfo) return;
    if (shouldDeferFill(fieldType, el)) {
      pushFilled({ type: fieldType, selector, score: 100, source: "site_mapping", deferred: true }, el);
      siteMapped.push(selector);
      return;
    }
    if (setFieldValue(el, value)) {
      pushFilled({ type: fieldType, selector, score: 100, source: "site_mapping" }, el);
      siteMapped.push(selector);
    }
  });

  const domMap = scanDomFields();
  applyPreferencesPositionHeuristic(domMap);
  for (const [fieldType, best] of Object.entries(domMap)) {
    if (fieldType === "additionalinfo" && !config.fillAdditionalInfo) continue;
    const value = String(TYPE_VALUE[fieldType] || "").trim();
    if (!value) continue;
    const minScore = MIN_SCORE[fieldType] || 50;
    if (best.score < minScore) continue;
    if (filled.some((f) => f.type === fieldType)) continue;
    const el = findElement(best.selector);
    if (!el) continue;
    if (el.type === "file") {
      // Only file-path types may target file inputs; a text value never goes here.
      if (fieldType === "resume") {
        filled.push(withPosition({ type: fieldType, selector: best.selector, score: best.score, file: true }, el));
      }
      continue;
    }
    // Never type a filesystem path into a text field.
    if (fieldType === "resume") continue;
    if (shouldDeferFill(fieldType, el)) {
      pushFilled(
        {
          type: fieldType,
          selector: best.selector,
          score: best.score,
          source: "dom_scan",
          deferred: true,
        },
        el,
      );
      continue;
    }
    if (setFieldValue(el, value)) {
      pushFilled({ type: fieldType, selector: best.selector, score: best.score, source: "dom_scan" }, el);
    }
  }

  // File-upload targets with a human-readable clue so the caller can route the
  // right document (resume vs cover letter).
  const fileTargets = [];
  function wpformsUploaderClue(u) {
    const field = u.closest("[id*='field'][class*='container'], [class*='wpforms-field'][class*='container']");
    const label = field?.querySelector(".wpforms-field-label");
    const labelText = label?.textContent?.replace(/\s+/g, " ").trim() || "";
    const fieldId = u.getAttribute("data-field-id") || field?.getAttribute("data-field-id") || "";
    return [labelText, fieldId ? `field_${fieldId}` : ""].filter(Boolean).join(" ");
  }
  function containerClue(c) {
    if (!c) return "";
    const wpformsLabel = c.closest("[class*='wpforms-field'][class*='container']")?.querySelector(".wpforms-field-label");
    if (wpformsLabel?.textContent) return wpformsLabel.textContent.replace(/\s+/g, " ").trim();
    const scope = c.closest("[class*='field' i], [class*='form-group' i]") || c;
    const dn = (c.getAttribute && (c.getAttribute("data-input-name") || "")) || "";
    const t = (scope.innerText || "").replace(/\s+/g, " ").trim().slice(0, 120);
    return [dn, t].filter(Boolean).join(" ");
  }
  function upsertFileTarget(selector, clue, el) {
    if (!selector) return;
    const existing = fileTargets.find((t) => t.selector === selector);
    const pos = fieldPosition(el);
    if (existing) {
      if ((clue || "").length > (existing.clue || "").length) existing.clue = clue;
      if (pos.top < (existing.top ?? 1e9)) {
        existing.top = pos.top;
        existing.left = pos.left;
      }
      return;
    }
    fileTargets.push({ selector, clue: clue || "", top: pos.top, left: pos.left });
  }

  const formRoot = document.querySelector("form.wpforms-form, form[id^='wpforms-form']");
  if (formRoot) {
    const uploaders = Array.from(formRoot.querySelectorAll(".wpforms-uploader"));
    const formFiles = Array.from(formRoot.querySelectorAll('input[type="file"]'));
    uploaders.forEach((u, idx) => {
      const embedded = u.querySelector('input[type="file"]');
      const fileEl = embedded || formFiles[idx];
      if (!fileEl || fileEl.disabled) return;
      upsertFileTarget(generateStableSelector(fileEl), wpformsUploaderClue(u), fileEl);
    });
  }

  if (!fileTargets.length) {
    const fileEls = [];
    collectElementsDeep(document, 'input[type="file"]', fileEls);
    const containers = [];
    collectElementsDeep(document, "[class*='uploader' i], [class*='dropzone' i]:not(input)", containers);
    const visibleContainers = containers.filter((c) => {
      try {
        const r = c.getBoundingClientRect();
        return r.width > 10 && r.height > 10;
      } catch (e) {
        return false;
      }
    });
    function fileOwnClue(el) {
      const parts = [el.id, el.name, el.getAttribute("aria-label")];
      try {
        if (el.labels && el.labels.length) parts.push(el.labels[0].textContent);
      } catch (e) { /* */ }
      return parts.filter(Boolean).join(" ").trim();
    }
    let detachedIdx = 0;
    for (const el of fileEls) {
      if (el.disabled) continue;
      let clue = fileOwnClue(el);
      if (!clue) {
        const inContainer = visibleContainers.find((c) => c.contains(el));
        if (inContainer) {
          clue = containerClue(inContainer);
        } else if (visibleContainers[detachedIdx]) {
          clue = containerClue(visibleContainers[detachedIdx]);
          detachedIdx += 1;
        }
      }
      upsertFileTarget(generateStableSelector(el), clue || "", el);
    }
  }

  const hasCoverLetterUpload = fileTargets.some((t) => /cover\s*letter|upload your cover/i.test(t.clue || ""));

  // Fallback: lone empty textarea → cover letter (skip additional-info boxes and when cover upload exists)
  if (config.coverLetter && !hasCoverLetterUpload && !filled.some((f) => f.type === "coverletter")) {
    const textareas = getAllFillable().filter((el) => el.tagName === "TEXTAREA" && !el.value);
    if (textareas.length === 1 && isLikelyVisibleField(textareas[0])) {
      const el = textareas[0];
      const blob = buildFieldClueBlob(el);
      if (isAdditionalInfoBlob(blob)) {
        if (config.fillAdditionalInfo) {
          pushFilled(
            {
              type: "additionalinfo",
              selector: generateStableSelector(el),
              score: 40,
              source: "textarea_fallback",
              deferred: true,
            },
            el,
          );
        }
      } else {
        pushFilled(
          {
            type: "coverletter",
            selector: generateStableSelector(el),
            score: 30,
            source: "textarea_fallback",
            deferred: true,
          },
          el,
        );
      }
    }
  }

  const filledSelectors = new Set(filled.map((f) => f.selector));
  const unfilled = [];
  for (const el of getAllFillable()) {
    if (hasUserValue(el)) continue;
    if (el.disabled || el.readOnly) continue;
    if (isDropzoneCompanionInput(el)) continue;
    if ((el.type || "").toLowerCase() === "file") continue;
    if (!isLikelyVisibleField(el)) continue;
    if (isSiteSearchField(el)) continue;
    const selector = generateStableSelector(el);
    if (filledSelectors.has(selector)) continue;
    const clue = buildFieldClueBlob(el);
    if (!clue && el.tagName !== "SELECT") continue;
    const entry = withPosition(
      {
        selector,
        clue,
        tagName: el.tagName.toLowerCase(),
        inputType: (el.type || "").toLowerCase(),
        required: el.required || el.getAttribute("aria-required") === "true",
      },
      el,
    );
    if (el.tagName === "SELECT") {
      entry.options = Array.from(el.options || []).slice(0, 20).map((o) => o.text.trim()).filter(Boolean);
    }
    unfilled.push(entry);
  }

  const visibleUnfilled =
    config.fillAdditionalInfo
      ? unfilled
      : unfilled.filter((u) => !isAdditionalInfoBlob(u.clue));

  return { filled, unfilled: visibleUnfilled, siteMapped, fileTargets, hasCoverLetterUpload, hostname: window.location.hostname };
}
