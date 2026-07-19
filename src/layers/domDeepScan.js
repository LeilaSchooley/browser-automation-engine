/**
 * Deep DOM scan: open shadow roots + same-origin / srcdoc iframes.
 * Stamps controls so signup/fill can resolve them without fragile nth indexes.
 */

/** Attribute stamped on discovered controls. */
export const QL_FIELD_ATTR = "data-ql-field";

/**
 * Collect visible form controls across light DOM, open shadow, and same-origin iframes.
 * @param {import('playwright').Page} page
 */
export async function collectVisibleFormControls(page) {
  return page.evaluate((attrName) => {
    function queryDeep(selector, root = document) {
      const out = [];
      try {
        out.push(...root.querySelectorAll(selector));
      } catch {
        /* ignore */
      }
      let hosts;
      try {
        hosts = root.querySelectorAll("*");
      } catch {
        return out;
      }
      for (const host of hosts) {
        if (host.shadowRoot) out.push(...queryDeep(selector, host.shadowRoot));
        if (host.tagName === "IFRAME" || host.tagName === "FRAME") {
          try {
            const doc = host.contentDocument;
            if (doc) out.push(...queryDeep(selector, doc));
          } catch {
            /* cross-origin */
          }
        }
      }
      return out;
    }

    function isVisible(el) {
      try {
        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 2 && r.height > 2;
      } catch {
        return false;
      }
    }

    function labelFor(el) {
      const parts = [];
      const push = (t) => {
        const s = String(t || "")
          .replace(/\s+/g, " ")
          .trim();
        if (s && s.length < 48 && !parts.includes(s)) parts.push(s);
      };
      if (el.labels?.length) {
        for (const lab of el.labels) push(lab.innerText);
        if (parts.length) {
          push(el.getAttribute("placeholder"));
          return parts.join(" ");
        }
      }
      push(el.getAttribute("aria-label"));
      const labelledBy = el.getAttribute("aria-labelledby");
      if (labelledBy) {
        const root = el.getRootNode?.() || document;
        for (const id of labelledBy.split(/\s+/)) {
          const n =
            (typeof root.getElementById === "function" && root.getElementById(id)) ||
            document.getElementById(id);
          if (n) push(n.innerText || n.textContent);
        }
      }
      const parent = el.parentElement;
      if (parent) {
        for (const lab of parent.querySelectorAll(":scope > label, :scope > span, :scope > legend")) {
          if (lab.contains(el)) continue;
          push(lab.innerText || lab.textContent);
        }
        let sib = el.previousElementSibling;
        while (sib) {
          if (!sib.querySelector?.("input, textarea, select")) push(sib.innerText || sib.textContent);
          sib = sib.previousElementSibling;
        }
        for (const err of parent.querySelectorAll(":scope > .err, :scope [class*='error' i]")) {
          push(err.innerText || err.textContent);
        }
      }
      push(el.getAttribute("placeholder"));
      return parts.join(" ").replace(/\s+/g, " ").trim();
    }

    for (const el of queryDeep(`[${attrName}]`)) {
      try {
        el.removeAttribute(attrName);
      } catch {
        /* ignore */
      }
    }

    const nodes = queryDeep("input, textarea, select").filter(isVisible);
    const out = [];
    let seq = 0;
    for (const el of nodes) {
      const type = (el.type || "").toLowerCase();
      if (["hidden", "submit", "button", "image", "reset"].includes(type)) continue;
      const qlId = `ql${seq++}`;
      try {
        el.setAttribute(attrName, qlId);
      } catch {
        /* ignore */
      }
      out.push({
        qlId,
        tag: el.tagName.toLowerCase(),
        type: type || el.tagName.toLowerCase(),
        name: el.name || "",
        id: el.id || "",
        autocomplete: (el.autocomplete || "").toLowerCase(),
        label: labelFor(el).slice(0, 80),
        placeholder: el.placeholder || "",
        value: String(el.value || "").slice(0, 200),
        required: Boolean(el.required || el.getAttribute("aria-required") === "true"),
      });
    }
    return out;
  }, QL_FIELD_ATTR);
}

/**
 * Set a stamped control's value (React-friendly native setter).
 * @param {import('playwright').Page} page
 * @param {string} qlId
 * @param {string} value
 */
export async function fillStampedControl(page, qlId, value) {
  return page.evaluate(
    ({ attrName, qlId: id, value: v }) => {
      function queryDeep(selector, root = document) {
        const out = [];
        try {
          out.push(...root.querySelectorAll(selector));
        } catch {
          /* ignore */
        }
        let hosts;
        try {
          hosts = root.querySelectorAll("*");
        } catch {
          return out;
        }
        for (const host of hosts) {
          if (host.shadowRoot) out.push(...queryDeep(selector, host.shadowRoot));
          if (host.tagName === "IFRAME" || host.tagName === "FRAME") {
            try {
              const doc = host.contentDocument;
              if (doc) out.push(...queryDeep(selector, doc));
            } catch {
              /* cross-origin */
            }
          }
        }
        return out;
      }
      const el = queryDeep(`[${attrName}="${id}"]`)[0];
      if (!el || el.disabled) return false;
      el.focus();
      const proto =
        el instanceof HTMLTextAreaElement
          ? window.HTMLTextAreaElement.prototype
          : el instanceof HTMLSelectElement
            ? window.HTMLSelectElement.prototype
            : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      desc?.set?.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return String(el.value || "") === String(v);
    },
    { attrName: QL_FIELD_ATTR, qlId, value },
  );
}
