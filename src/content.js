/**
 * Form Keeper — content script.
 */
(function () {
  if (window.__formKeeperInjected) return;
  window.__formKeeperInjected = true;

  const SENSITIVE_PATTERN = /password|passwd|pwd|card.?number|cc.?num|cvv|cvc|security.?code|\bssn\b|social.?security|passport|\bpin\b/i;
  const ALWAYS_EXCLUDE_PATTERN = /recaptcha|h-?captcha|hcaptcha|turnstile|frc-?captcha|captcha[-_.]?response|\bcsrf\b|xsrf|authenticity_token|__requestverificationtoken|\bviewstate\b|\b_token\b/i;
  const EXCLUDED_TYPES = new Set(["password", "hidden", "submit", "button", "reset", "image", "file"]);

  const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

  let settings = null;
  let siteEnabled = false; 
  let isFilling = false; 
  let activeTopHost = null;
  const idleTimers = new WeakMap();

  // --- Iframe Parent Override Engine ---
  try {
    if (window !== window.top && window.parent && window.parent.postMessage) {
      window.parent.postMessage({ type: "FK_REQUEST_TOP_HOST" }, "*");
    }
  } catch(e) {}

  window.addEventListener("message", (e) => {
    if (e.data?.type === "FK_REQUEST_TOP_HOST" && window === window.top) {
      e.source.postMessage({ type: "FK_PROVIDE_TOP_HOST", host: getLanguageAwareHost(), enabled: siteEnabled }, "*");
    }
    if (e.data?.type === "FK_PROVIDE_TOP_HOST") {
      activeTopHost = e.data.host;
      if (e.data.enabled !== undefined) {
        siteEnabled = e.data.enabled;
        updateFloatingSaveButton();
      }
    }
  });

  const touchedElements = new WeakSet();
  function isFormControl(el) { return el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.isContentEditable); }
  function markTouched(e) { if (isFormControl(e.target)) touchedElements.add(e.target); }
  
  document.addEventListener("input", markTouched, true);
  document.addEventListener("change", markTouched, true);
  
  document.addEventListener("click", (e) => {
    if (!siteEnabled) return;

    const label = e.target.closest("label");
    if (label) {
      let targetInput = null;
      if (label.htmlFor) {
        try { targetInput = document.getElementById(label.htmlFor); } catch(err){}
      } else { targetInput = label.querySelector("input, select, textarea, [contenteditable='true']"); }
      
      if (targetInput && isFormControl(targetInput)) {
        touchedElements.add(targetInput);
        const watcher = fillWatchers.get(targetInput);
        if (watcher) setTimeout(() => evaluateWatchedField(targetInput, watcher), 150);
      }
    }
  }, true);

  let lastRightClickedElement = null;
  document.addEventListener("contextmenu", (e) => {
    if (isFormControl(e.target)) lastRightClickedElement = e.target;
  }, true);

  function getLanguageAwareHost() {
    if (activeTopHost) return activeTopHost;
    const baseHost = location.hostname;
    try {
      const firstDir = location.pathname.split('/').filter(Boolean)[0];
      if (firstDir && /^[a-z]{2}(-[a-z]{2})?$/i.test(firstDir)) return `${baseHost}/${firstDir.split('-')[0].toLowerCase()}`;
      const params = new URLSearchParams(location.search);
      const langParam = params.get("lang") || params.get("locale");
      if (langParam && /^[a-z]{2}(-[a-z]{2})?$/i.test(langParam)) return `${baseHost}/[${langParam.split('-')[0].toLowerCase()}]`;
      const htmlLang = (document.documentElement.lang || "").split('-')[0].toLowerCase();
      if (htmlLang && /^[a-z]{2}$/.test(htmlLang) && htmlLang !== "en") return `${baseHost}/[${htmlLang}]`;
    } catch(e) {}
    return baseHost;
  }

  function isAlwaysExcludedField(el) { return ALWAYS_EXCLUDE_PATTERN.test([el.name, el.id, el.getAttribute("formcontrolname"), el.className].filter(Boolean).join(" ")); }
  function isHiddenField(el) {
    if (el.tagName === "SELECT" || el.type === "checkbox" || el.type === "radio") return false;
    if (el.hidden) return true;
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && el.offsetParent === null) return true;
    const style = window.getComputedStyle(el);
    return style.visibility === "hidden" || style.display === "none";
  }
  function isSensitiveField(el) {
    if (el.type === "password") return true;
    return SENSITIVE_PATTERN.test([el.name, el.id, el.autocomplete, el.placeholder, el.getAttribute("aria-label"), el.getAttribute("formcontrolname")].filter(Boolean).join(" "));
  }

  function fieldLabel(el) {
    function getCleanText(node) {
      if (!node) return "";
      const clone = node.cloneNode(true);
      clone.querySelectorAll('select, input, textarea, button, script, style').forEach(n => n.remove());
      return clone.textContent.replace(/\s+/g, ' ').trim();
    }

    let text = "";
    if (el.type === 'radio' || el.type === 'checkbox') {
      if (el.name) {
        try {
          const ancestor = el.closest('fieldset, .group');
          if (ancestor) {
             const legend = ancestor.querySelector('legend');
             if (legend) text = getCleanText(legend);
          }
        } catch(e) {}
      }
    }
    
    if (!text && el.id) { try { const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (lbl) text = getCleanText(lbl); } catch(e){} }
    if (!text) { const wrap = el.closest('label'); if (wrap) text = getCleanText(wrap); }
    
    if (!text) {
      const container = el.closest('div, li, p, td, fieldset');
      if (container) {
        const strayLabel = container.querySelector('label');
        if (strayLabel) text = getCleanText(strayLabel);
        if (!text) {
           const straySpan = container.querySelector('.label, .form-label, .field-label');
           if (straySpan) text = getCleanText(straySpan);
        }
      }
    }

    if (!text && el.getAttribute('aria-label')) text = el.getAttribute('aria-label');
    if (text && text.length > 60) text = "";
    if (!text) {
       let fallbackName = el.name || el.id;
       if (fallbackName) {
          fallbackName = fallbackName.replace(/\[\]/g, '').split(/[._-]+/).pop();
          fallbackName = fallbackName.replace(/([A-Z])/g, ' $1').trim();
          text = fallbackName.charAt(0).toUpperCase() + fallbackName.slice(1);
       } else text = el.placeholder || "Field";
    }
    return text.substring(0, 60).trim();
  }

  const AUTOGEN_ID_PATTERN = /^(mat-|cdk-|mui-|ember|react-select-|radix-|ng-)[\w-]*\d/i;
  function fieldKey(el, fallbackIndex) {
    const formControlName = el.getAttribute("formcontrolname") || el.getAttribute("ng-reflect-name");
    if (formControlName) return `fc:${formControlName}`;
    if (el.name) return `name:${el.name}`;
    if (el.id && !AUTOGEN_ID_PATTERN.test(el.id)) return `id:${el.id}`;
    const label = fieldLabel(el);
    if (label && label !== "Field") return `lbl:${label.toLowerCase().trim().replace(/\s+/g, "-")}`;
    return `pos-${fallbackIndex}`;
  }

  function queryEligibleNodes(root) {
    const results = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null, false);
    let node;
    while ((node = walker.nextNode())) {
      if (node.tagName === "INPUT" || node.tagName === "SELECT" || node.tagName === "TEXTAREA" || node.isContentEditable) {
        results.push(node);
      }
      if (node.shadowRoot) {
        results.push(...queryEligibleNodes(node.shadowRoot));
      }
    }
    return results;
  }

  function collectEligibleFields(scope) {
    const nodeList = scope === document ? queryEligibleNodes(document.body || document.documentElement) : queryEligibleNodes(scope);
    const fields = new Map();
    let index = 0;
    for (const el of nodeList) {
      if (scope === document && el.form) continue; 
      const type = (el.type || el.tagName || (el.isContentEditable ? "contenteditable" : "")).toLowerCase();
      if (EXCLUDED_TYPES.has(type)) continue;
      if (el.disabled || el.getAttribute("aria-hidden") === "true") { index++; continue; }
      if (isAlwaysExcludedField(el)) { index++; continue; } 
      if (isHiddenField(el)) { index++; continue; } 
      if (isSensitiveField(el) && !settingsAllowSensitive()) continue;
      const key = fieldKey(el, index);
      index++;
      if (type === "radio" || type === "checkbox") {
        if (!fields.has(key)) fields.set(key, { type, elements: [], label: fieldLabel(el) });
        fields.get(key).elements.push(el);
      } else {
        fields.set(key, { type, elements: [el], label: fieldLabel(el) });
      }
    }
    return fields;
  }

  function settingsAllowSensitive() { return !!(settings && settings.includeSensitive); }
  function buildSignature(fieldsMap) { return Array.from(fieldsMap.keys()).sort().join("::"); }
  function getFormId(scope) {
    if (scope.__pseudo) return "page:" + location.pathname;
    const el = scope;
    if (el.id) return "id:" + el.id;
    if (el.name) return "name:" + el.name;
    return "idx:" + Array.from(document.forms).indexOf(el) + ":" + location.pathname;
  }

  function isMeaningfulValue(type, value) {
    if (Array.isArray(value)) return value.length > 0;
    if (type === "checkbox" || type === "radio") return value !== undefined && value !== null;
    return value !== undefined && value !== null && String(value).trim() !== "";
  }

  function readMeaningfulValues(fieldsMap, requireTouched = true) {
    const values = {};
    for (const [key, fieldEntry] of fieldsMap) {
      if (requireTouched) {
        const wasTouched = fieldEntry.elements.some((el) => touchedElements.has(el));
        if (!wasTouched) continue;
      }
      
      const v = readFieldValue(fieldEntry);
      if (isMeaningfulValue(fieldEntry.type, v)) {
        const semantic = getSemanticType(key, fieldEntry.label, fieldEntry.elements[0]);
        values[key] = { value: v, type: fieldEntry.type, label: fieldEntry.label, semantic: semantic };
      }
    }
    return values;
  }

  function readFieldValue(entry) {
    const { type, elements } = entry;
    if (elements[0].isContentEditable) return elements[0].innerText || elements[0].textContent;
    if (type === "checkbox") {
      if (elements.length === 1) return elements[0].checked;
      const checked = elements.filter((e) => e.checked).map((e) => e.value);
      return checked.length > 0 ? checked : undefined;
    }
    if (type === "radio") {
      const checked = elements.find((e) => e.checked);
      return checked ? checked.value : undefined;
    }
    if (elements[0].type === "select-multiple") {
      const selected = Array.from(elements[0].selectedOptions).map((o) => o.value);
      return selected.length > 0 ? selected : undefined;
    }
    return elements[0].value;
  }

  function findSelectValue(selectEl, desiredValue) {
    if (desiredValue == null) return "";
    const strVal = String(desiredValue).toLowerCase().trim();
    
    for (let i = 0; i < selectEl.options.length; i++) {
      if (selectEl.options[i].value.toLowerCase().trim() === strVal) return selectEl.options[i].value;
    }
    for (let i = 0; i < selectEl.options.length; i++) {
      if (selectEl.options[i].textContent.toLowerCase().trim() === strVal) return selectEl.options[i].value;
    }
    if (strVal.length > 2) {
      try {
        const regex = new RegExp(`\\b${strVal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        for (let i = 0; i < selectEl.options.length; i++) {
          if (regex.test(selectEl.options[i].textContent)) return selectEl.options[i].value;
        }
      } catch(e) {}
    }
    return desiredValue;
  }

  function setNativeValue(el, value) {
    const strVal = String(value ?? "");
    if (el.value === strVal) return; 

    const previousValue = el.value;
    try { el.focus(); } catch (e) {}
    
    try {
      const tagName = el.tagName;
      let setter = null;
      if (tagName === "INPUT") setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      else if (tagName === "TEXTAREA") setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      else if (tagName === "SELECT") setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")?.set;
      
      if (setter) setter.call(el, strVal); else el.value = strVal;

      if (el._valueTracker && typeof el._valueTracker.setValue === "function") {
        el._valueTracker.setValue(previousValue);
      }
    } catch(e) { el.value = strVal; }

    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }

  function writeFieldValue(entry, value) {
    const { type, elements } = entry;

    if (elements[0].isContentEditable) {
      elements[0].innerText = value != null ? value : "";
      elements[0].dispatchEvent(new Event("input", { bubbles: true, composed: true }));
      elements[0].dispatchEvent(new Event("blur", { bubbles: true, composed: true }));
      return;
    }

    if (type === "checkbox") {
      if (elements.length === 1) {
        elements[0].checked = !!value;
        elements[0].dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        const valArray = Array.isArray(value) ? value : (value != null ? [value] : []);
        elements.forEach((e) => {
          if (e.checked !== valArray.includes(e.value)) { 
             e.checked = valArray.includes(e.value); 
             e.dispatchEvent(new Event("change", { bubbles: true })); 
          }
        });
      }
    } else if (type === "radio") {
      if (value == null) { 
        elements.forEach((e) => { if (e.checked) { e.checked = false; e.dispatchEvent(new Event("change", { bubbles: true })); } });
      } else {
        const match = elements.find((e) => e.value === String(value));
        if (match && !match.checked) { match.checked = true; match.dispatchEvent(new Event("change", { bubbles: true })); }
      }
    } else if (elements[0].tagName === "SELECT") {
      const el = elements[0];
      if (el.multiple) {
        const valArray = Array.isArray(value) ? value : (value != null ? [value] : []);
        const mappedValues = valArray.map(v => findSelectValue(el, v));
        Array.from(el.options).forEach((o) => { o.selected = mappedValues.includes(o.value); });
        el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
        el.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      } else {
        const mappedVal = findSelectValue(el, value);
        if (el.value !== mappedVal) {
          setNativeValue(el, mappedVal);
        }
      }
    } else setNativeValue(elements[0], value != null ? value : "");
  }

  function getSemanticType(key, label, el = null) {
    let searchStr = `${key} ${label}`;
    if (el) {
      if (el.placeholder) searchStr += ` ${el.placeholder}`;
      if (el.title) searchStr += ` ${el.title}`;
      if (el.name) searchStr += ` ${el.name.replace(/[-_]/g, ' ')}`;
      if (el.id) searchStr += ` ${el.id.replace(/[-_]/g, ' ')}`;
      
      const type = (el.type || "").toLowerCase();
      if (type === "email") return "email";
      if (type === "tel") return "phone";
      
      const ac = (el.autocomplete || "").toLowerCase();
      if (ac.includes("email")) return "email";
      if (ac.includes("tel") || ac.includes("phone")) return "phone";
      if (ac.includes("given-name")) return "fname";
      if (ac.includes("family-name")) return "lname";
      if (ac.includes("address-line1")) return "address1";
      if (ac.includes("address-line2")) return "address2";
      if (ac.includes("locality")) return "city";
      if (ac.includes("region") || ac.includes("state")) return "state";
      if (ac.includes("postal-code") || ac.includes("zip")) return "zip";
      if (ac.includes("country")) return "country";
    }

    const cleanKey = searchStr.replace(/^(name|id|lbl|test|fc|pos)[-:]/i, '');
    const rawStr = cleanKey.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
    const str = rawStr.replace(/[^\p{L}\p{N}]/gu, ' ').replace(/\s+/g, ' ');

    if (/\b(email|correo|البريد|ايميل|e-mail|mail)\b/.test(str)) return "email";
    if (/\b(phone|mobile|tel|telephone|cell|contact|هاتف|جوال|موبايل|تليفون|رقم الهاتف|رقم)\b/.test(str)) return "phone";
    
    if (/\b(full name|fullname|nombre completo|الاسم بالكامل|الاسم الكامل|your name|customer name|buyer name|cardholder name|passenger name|patient name)\b/.test(str)) return "fullname";
    if (/\b(first name|first_name|fname|prenom|given name|first|الاسم الاول|الاسم الأول)\b/.test(str)) return "fname";
    if (/\b(last name|last_name|lname|surname|family name|last|الاسم الاخير|الاسم الأخير|اللقب|اسم العائلة)\b/.test(str)) return "lname";
    if (/\b(middle name|middle_name|mname|middle|initial|اسم اوسط|الاسم الاوسط|الاسم الأوسط|اسم الاب)\b/.test(str)) return "mname";
    if (/\b(name|nombre|الاسم)\b/.test(str) && !/\b(user|username|login|account|company|business|employer|school|org|brand|store|site|domain)\b/.test(str)) return "fullname";
    
    if (/\b(dob|birthdate|birth date|birthday|date of birth|تاريخ الميلاد|تاريخ الازدياد)\b/.test(str)) return "dob";
    if (/\b(company|organization|business|org|employer|empresa|school|university|college|شركة|مؤسسة|جهة العمل|مدرسة|جامعة|كلية)\b/.test(str)) return "company";
    if (/\b(ssn|social security|رقم الضمان|الضمان الاجتماعي)\b/.test(str)) return "ssn";
    if (/\b(a number|registration|national id|id number|رقم الهوية|الرقم القومي|رقم التسجيل|رقم الإقامة)\b/.test(str)) return "id_number";
    if (/\b(gender|sex|الجنس|النوع|الذكر أو الأنثى)\b/.test(str)) return "gender";
    
    if (/\b(address 1|address1|street|direccion|الشارع)\b/.test(str)) return "address1";
    if (/\b(address 2|address2|apt|suite|area|district|neighborhood|sector|حي|منطقة)\b/.test(str)) return "address2";
    if (/\b(city|town|ciudad|مدينة)\b/.test(str)) return "city";
    if (/\b(state|province|region|governorate|provincia|محافظة|مقاطعة|إقليم)\b/.test(str)) return "state";
    if (/\b(zip|postal|postcode|رمز بريدي|الرمز البريدي)\b/.test(str)) return "zip";
    if (/\b(country|nation|دولة|بلد)\b/.test(str)) return "country";

    return null;
  }

  function getSemVal(entry, sem) {
    for (const [key, f] of Object.entries(entry.fields)) {
      if ((f.semantic || getSemanticType(key, f.label, null)) === sem && f.value != null && String(f.value).trim() !== "") {
        return f.value;
      }
    }
    return null;
  }

  function getProfileValueForField(entry, pKey, pField, pSem) {
    if (pSem) {
      if (pSem === "fullname") {
        if (getSemVal(entry, "fullname")) return getSemVal(entry, "fullname");
        const f = getSemVal(entry, "fname"); 
        const m = getSemVal(entry, "mname"); 
        const l = getSemVal(entry, "lname");
        if (f || l) return [f, m, l].filter(Boolean).join(" ");
      }
      if (pSem === "fname") {
        if (getSemVal(entry, "fname")) return getSemVal(entry, "fname");
        const full = getSemVal(entry, "fullname");
        if (full) return full.split(" ")[0];
      }
      if (pSem === "mname") {
        if (getSemVal(entry, "mname")) return getSemVal(entry, "mname");
        const full = getSemVal(entry, "fullname");
        if (full) {
          const parts = full.split(" ");
          return parts.length > 2 ? parts.slice(1, -1).join(" ") : "";
        }
      }
      if (pSem === "lname") {
        if (getSemVal(entry, "lname")) return getSemVal(entry, "lname");
        const full = getSemVal(entry, "fullname");
        if (full) { 
          const parts = full.split(" "); 
          return parts.length > 1 ? parts[parts.length - 1] : parts[0]; 
        }
      }
      
      const val = getSemVal(entry, pSem);
      if (val != null) return val;
    }

    if (!pKey.startsWith("pos-") && entry.fields[pKey] && entry.fields[pKey].value != null) {
      return entry.fields[pKey].value;
    }

    const el = pField.elements[0];
    let nameStr = (el?.name || "").replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ');
    let idStr = (el?.id || "").replace(/([A-Z])/g, ' $1').replace(/[-_]/g, ' ');

    const targetTexts = [
      pField.label, 
      el?.placeholder, 
      el?.title,
      el?.getAttribute("aria-label"),
      nameStr,
      idStr
    ]
      .filter(Boolean)
      .map(s => s.toLowerCase().trim())
      .filter(s => s.length > 2);

    for (const tText of targetTexts) {
      for (const profField of Object.values(entry.fields)) {
        if (profField.label && profField.label.toLowerCase().trim() === tText && profField.value != null) return profField.value;
      }
    }

    const fuzzyTargets = targetTexts.filter(s => s.length > 3);
    for (const tText of fuzzyTargets) {
      for (const profField of Object.values(entry.fields)) {
        if (profField.label && profField.label.length > 3) {
          const l2 = profField.label.toLowerCase().trim();
          if ((tText.includes(l2) || l2.includes(tText)) && profField.value != null) return profField.value;
        }
      }
    }
    return null;
  }

  function getFormScopes() {
    const scopes = Array.from(document.forms);
    const outside = collectEligibleFields(document);
    if (outside.size >= 1) scopes.push({ __pseudo: true, fields: outside });
    return scopes;
  }
  function scopeFields(scope) { return scope.__pseudo ? scope.fields : collectEligibleFields(scope); }

  async function saveScope(scope, { mode = "backup", label, isProfile = false } = {}) {
    const fieldsMap = scopeFields(scope);
    if (fieldsMap.size === 0) return null;

    if (mode === "new" || isProfile) {
      let isScopeTouched = false;
      for (const fieldEntry of fieldsMap.values()) {
        if (fieldEntry.elements.some(el => touchedElements.has(el))) {
          isScopeTouched = true;
          break;
        }
      }
      if (!isScopeTouched) return null;
    }

    const currentValues = readMeaningfulValues(fieldsMap, mode === "backup");
    if (Object.keys(currentValues).length === 0) return null;

    const signature = buildSignature(fieldsMap);
    const formId = getFormId(scope);
    const host = isProfile ? "__PROFILES__" : getLanguageAwareHost();

    if (isProfile) {
      return await FormKeeperStorage.saveEntry(host, {
        label: label || `Profile ${new Date().toLocaleDateString()}`,
        path: "*", formId: `profile-${Date.now()}`, signature: "profile", fields: currentValues, auto: false, isProfile: true
      });
    }

    if (mode === "backup") {
      const hostEntries = await FormKeeperStorage.getHostEntries(host);
      const backupEntry = hostEntries.find(e => e.auto && (e.formId === formId || (!e.formId && e.signature === signature)));
      const editedValues = {};
      for (const [key, value] of Object.entries(currentValues)) {
        if (!isFieldUnchangedSinceFill(fieldsMap.get(key))) editedValues[key] = value;
      }
      if (Object.keys(editedValues).length === 0 && !backupEntry) return null;
      const mergedFields = { ...(backupEntry?.fields || {}), ...editedValues };
      return await FormKeeperStorage.saveEntry(host, {
        id: backupEntry?.id, label: backupEntry?.label || "Auto-saved backup", path: location.pathname,
        formId, signature, fields: mergedFields, auto: true,
      });
    }

    return await FormKeeperStorage.saveEntry(host, {
      label: label || `Saved ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
      path: location.pathname, formId, signature, fields: currentValues, auto: false,
    });
  }

  async function handleFormSubmit(scope) {
    const fieldsMap = scopeFields(scope);
    if (fieldsMap.size === 0) return;
    const currentValues = readMeaningfulValues(fieldsMap);
    if (Object.keys(currentValues).length === 0) return;

    const formId = getFormId(scope);
    const signature = buildSignature(fieldsMap);
    const host = getLanguageAwareHost();

    await saveScope(scope, { mode: "backup" }).catch(() => {});

    const hostEntries = await FormKeeperStorage.getHostEntries(host);
    const backupEntry = hostEntries.find(e => e.auto && (e.formId === formId || (!e.formId && e.signature === signature)));
    const mergedFields = { ...(backupEntry?.fields || {}), ...currentValues };
    const namedEntries = hostEntries.filter(e => !e.auto && (e.formId ? e.formId === formId : e.signature === signature));

    if (namedEntries.length === 0) {
      await FormKeeperStorage.saveEntry(host, {
        label: `Saved ${new Date().toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`,
        path: location.pathname, formId, signature, fields: mergedFields, auto: false,
      });
    } else {
      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({
            type: "FK_CONFIRM_SUBMIT", host, formId, signature, path: location.pathname, fields: mergedFields, existingCount: namedEntries.length,
          }).catch(() => {});
      }
    }
    reportStatus();
  }

  const fillWatchers = new WeakMap();
  const watchDebounce = new WeakMap();
  let activeWatchers = [];

  function isEqualFieldValue(a, b) {
    if (typeof a === "boolean" || typeof b === "boolean") return !!a === !!b;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      const sortedA = [...a].sort(); const sortedB = [...b].sort();
      return sortedA.every((val, index) => String(val) === String(sortedB[index]));
    }
    return String(a ?? "") === String(b ?? "");
  }

  function trackFilledFields(entry, fieldsMap) {
    for (const [key, fieldEntry] of fieldsMap) {
      const saved = entry.fields[key];
      const semantic = getSemanticType(key, fieldEntry.label, fieldEntry.elements[0]);
      const info = saved
        ? { kind: "replace", host: entry.isProfile ? "__PROFILES__" : getLanguageAwareHost(), entryId: entry.id, entryLabel: entry.label || "this saved entry", key, type: fieldEntry.type, label: fieldEntry.label, filledValue: saved.value, semantic }
        : { kind: "add", host: entry.isProfile ? "__PROFILES__" : getLanguageAwareHost(), entryId: entry.id, entryLabel: entry.label || "this saved entry", key, type: fieldEntry.type, label: fieldEntry.label, semantic };
      
      for (const el of fieldEntry.elements) {
        const watcher = { info, fieldEntry, el, lastSeenValue: readFieldValue(fieldEntry) };
        fillWatchers.set(el, watcher);
        activeWatchers.push(watcher);
      }
    }
  }

  function clearWatchersForFields(fieldsMap) {
    for (const [, fieldEntry] of fieldsMap) {
      for (const el of fieldEntry.elements) {
        fillWatchers.delete(el);
        clearTimeout(watchDebounce.get(el));
        watchDebounce.delete(el);
        if (fieldPopupState.activeElement === el) hideFieldPopup();
      }
    }
    const keysToClear = new Set(Array.from(fieldsMap.keys()));
    activeWatchers = activeWatchers.filter(w => !keysToClear.has(w.fieldEntry.key));
  }

  function handleWatchedInput(e) {
    if (isFilling || !siteEnabled) return; 
    const el = e.target;
    if (!isFormControl(el)) return;
    const watcher = fillWatchers.get(el);
    if (!watcher) return;
    clearTimeout(watchDebounce.get(el));
    const delay = e.type === "change" ? 0 : 500;
    watchDebounce.set(el, setTimeout(() => { watcher.lastSeenValue = readFieldValue(watcher.fieldEntry); evaluateWatchedField(el, watcher); }, delay));
  }
  
  document.addEventListener("input", handleWatchedInput, true);
  document.addEventListener("change", handleWatchedInput, true);

  function evaluateWatchedField(el, watcher) {
    const currentValue = readFieldValue(watcher.fieldEntry);
    if (watcher.info.kind === "add") {
      if (!isMeaningfulValue(watcher.fieldEntry.type, currentValue)) { if (fieldPopupState.activeElement === el) hideFieldPopup(); return; }
      showFieldPopup(el, watcher.info, currentValue); return;
    }
    if (isEqualFieldValue(currentValue, watcher.info.filledValue)) { if (fieldPopupState.activeElement === el) hideFieldPopup(); return; }
    showFieldPopup(el, watcher.info, currentValue);
  }

  async function updateFieldInSavedEntry(info, newValue) {
    const hostEntries = await FormKeeperStorage.getHostEntries(info.host);
    const entry = hostEntries.find((e) => e.id === info.entryId);
    if (!entry) return; 
    
    const existingField = entry.fields[info.key] || {};
    const updatedFields = { ...entry.fields, [info.key]: { ...existingField, value: newValue, type: info.type, label: info.label, semantic: existingField.semantic || info.semantic } };
    
    await FormKeeperStorage.saveEntry(info.host, { id: entry.id, fields: updatedFields });
  }

  const fieldPopupState = { host: null, shadow: null, el: null, activeElement: null, visible: false };

  function ensureFieldPopup() {
    if (fieldPopupState.host) return;
    const host = document.createElement("div");
    host.style.cssText = "all: initial; position: fixed; top: 0; left: 0; z-index: 2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      .fk-popup { display: none; position: fixed; background: #14191c; border: 1px solid #2b363d; border-radius: 8px; padding: 6px; font: 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.35); align-items: center; gap: 6px; direction: ltr !important; }
      .fk-popup.fk-visible { display: flex; }
      .fk-btn { border: none; border-radius: 5px; padding: 4px 10px; font-size: 12px; cursor: pointer; font-weight: 600; white-space: nowrap; }
      .fk-btn-replace { background: #4fd1b0; color: #0b1512; }
      .fk-btn-dismiss { background: #2a353c; color: #ecf1f3; }
      .fk-btn-dismiss:hover { background: #3a4750; }
    `;
    shadow.appendChild(style);
    const el = document.createElement("div"); el.className = "fk-popup"; shadow.appendChild(el);
    (document.documentElement || document.body).appendChild(host);
    fieldPopupState.host = host; fieldPopupState.shadow = shadow; fieldPopupState.el = el;
  }

  function getVisibleAnchor(el) {
    if (el.offsetWidth > 0 && el.offsetHeight > 0) return el;
    if (el.id) { try { const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (label && (label.offsetWidth > 0 || label.offsetHeight > 0)) return label; } catch(err){} }
    const wrapper = el.closest("label");
    if (wrapper && (wrapper.offsetWidth > 0 || wrapper.offsetHeight > 0)) return wrapper;
    return el.parentElement || el;
  }

  function positionFieldPopup() {
    const { el, activeElement } = fieldPopupState;
    if (!activeElement) return;
    const anchor = getVisibleAnchor(activeElement);
    const rect = anchor.getBoundingClientRect();
    const popupWidth = el.offsetWidth || 140;
    const left = Math.min(Math.max(rect.left, 8), Math.max(8, window.innerWidth - popupWidth - 8));
    const top = Math.min(rect.bottom + 6, window.innerHeight - 60);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  }

  function repositionFieldPopup() { if (!fieldPopupState.visible || !fieldPopupState.activeElement) return; positionFieldPopup(); }
  function handleOutsideFieldPopupClick(e) {
    if (!fieldPopupState.visible) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(fieldPopupState.el) || e.target === fieldPopupState.activeElement) return;
    hideFieldPopup();
  }

  function hideFieldPopup() {
    if (fieldPopupState.el) fieldPopupState.el.classList.remove("fk-visible");
    fieldPopupState.visible = false; fieldPopupState.activeElement = null;
    window.removeEventListener("scroll", repositionFieldPopup, true); window.removeEventListener("resize", repositionFieldPopup, true); document.removeEventListener("mousedown", handleOutsideFieldPopupClick, true);
  }

  function showFieldPopup(el, info, currentValue) {
    ensureFieldPopup(); fieldPopupState.activeElement = el;
    const popupEl = fieldPopupState.shadow.querySelector(".fk-popup"); popupEl.innerHTML = "";
    const actionBtn = document.createElement("button"); actionBtn.type = "button"; actionBtn.className = "fk-btn fk-btn-replace"; actionBtn.textContent = info.kind === "add" ? "Add" : "Replace";
    actionBtn.addEventListener("click", async () => {
      await updateFieldInSavedEntry(info, currentValue); info.kind = "replace"; info.filledValue = currentValue;
      const watcher = fillWatchers.get(el); if (watcher) watcher.lastSeenValue = currentValue; 
      hideFieldPopup(); updateFloatingSaveButton();
    });
    const dismissBtn = document.createElement("button"); dismissBtn.type = "button"; dismissBtn.className = "fk-btn fk-btn-dismiss"; dismissBtn.textContent = "Dismiss";
    dismissBtn.addEventListener("click", () => hideFieldPopup());
    popupEl.appendChild(actionBtn); popupEl.appendChild(dismissBtn); popupEl.classList.add("fk-visible"); fieldPopupState.visible = true; positionFieldPopup();
    setTimeout(() => { window.addEventListener("scroll", repositionFieldPopup, true); window.addEventListener("resize", repositionFieldPopup, true); document.addEventListener("mousedown", handleOutsideFieldPopupClick, true); }, 150);
  }

  function isFieldUnchangedSinceFill(fieldEntry) {
    const watcher = activeWatchers.find(w => w.fieldEntry.key === fieldEntry.key);
    if (!watcher) return false; 
    const currentValue = readFieldValue(fieldEntry); return isEqualFieldValue(currentValue, watcher.info.filledValue);
  }

  function anyScopeHasUnsavedUserEdits() {
    const scopes = getFormScopes();
    for (const scope of scopes) {
      const fieldsMap = scopeFields(scope); if (fieldsMap.size === 0) continue;
      const currentValues = readMeaningfulValues(fieldsMap);
      for (const key of Object.keys(currentValues)) {
        const fieldEntry = fieldsMap.get(key); if (!isFieldUnchangedSinceFill(fieldEntry)) return true;
      }
    }
    return false;
  }

  const floatingSaveState = { host: null, shadow: null, btn: null, label: null, visible: false };

  function ensureFloatingSaveButton() {
    if (floatingSaveState.host) return;
    const host = document.createElement("div"); host.style.cssText = "all: initial; position: fixed; top: 12px; right: 12px; z-index: 2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `.fk-save { display: none; align-items: center; gap: 7px; background: #14191c; color: #ecf1f3; border: 1px solid #2b363d; border-radius: 999px; padding: 8px 14px; font: 600 12px/1.3 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; box-shadow: 0 6px 20px rgba(0,0,0,.35); cursor: pointer; white-space: nowrap; } .fk-save.fk-visible { display: inline-flex; } .fk-save:hover { background: #1c2327; } .fk-save:disabled { cursor: default; opacity: 0.8; } .fk-save-dot { width: 8px; height: 8px; border-radius: 50%; background: #4fd1b0; flex: none; }`;
    shadow.appendChild(style);
    const btn = document.createElement("button"); btn.type = "button"; btn.className = "fk-save";
    const dot = document.createElement("span"); dot.className = "fk-save-dot";
    const label = document.createElement("span"); label.textContent = "Save this form's entries";
    btn.appendChild(dot); btn.appendChild(label); btn.addEventListener("click", handleFloatingSaveClick); shadow.appendChild(btn);
    (document.documentElement || document.body).appendChild(host);
    floatingSaveState.host = host; floatingSaveState.shadow = shadow; floatingSaveState.btn = btn; floatingSaveState.label = label;
  }

  async function handleFloatingSaveClick() {
    const { btn, label } = floatingSaveState; btn.disabled = true; label.textContent = "Saving\u2026";
    const scopes = getFormScopes(); let savedCount = 0;
    for (const scope of scopes) { const saved = await saveScope(scope, { mode: "new" }).catch(() => null); if (saved) savedCount++; }
    reportStatus();
    if (savedCount > 0) { label.textContent = "Saved \u2713"; setTimeout(hideFloatingSaveButton, 900); } 
    else { label.textContent = "Save this form's entries"; btn.disabled = false; }
  }

  function showFloatingSaveButton() { ensureFloatingSaveButton(); const { btn, label } = floatingSaveState; btn.disabled = false; label.textContent = "Save this form's entries"; btn.classList.add("fk-visible"); floatingSaveState.visible = true; }
  function hideFloatingSaveButton() { if (!floatingSaveState.btn) return; floatingSaveState.btn.classList.remove("fk-visible"); floatingSaveState.visible = false; }
  
  function updateFloatingSaveButton() {
    if (isFilling || !settings || !settings.autoDetect || !siteEnabled) { hideFloatingSaveButton(); return; }
    
    let hasEdits = false;
    const scopes = getFormScopes();
    for (const scope of scopes) {
        if (readMeaningfulValues(scopeFields(scope), true) && Object.keys(readMeaningfulValues(scopeFields(scope), true)).length > 0) {
            hasEdits = true; break;
        }
    }
    
    if (hasEdits) showFloatingSaveButton(); else hideFloatingSaveButton();
  }

  let floatingSaveDebounce = null;
  document.addEventListener("input", () => { clearTimeout(floatingSaveDebounce); floatingSaveDebounce = setTimeout(updateFloatingSaveButton, 300); }, true);
  document.addEventListener("change", () => { clearTimeout(floatingSaveDebounce); floatingSaveDebounce = setTimeout(updateFloatingSaveButton, 300); }, true);

  async function computeStatus() {
    settings = await FormKeeperStorage.getSettings();
    if (!settings.autoDetect) return { hasTouchedData: false, matchCount: 0, autoDetectOff: true };

    const scopes = getFormScopes();
    const host = getLanguageAwareHost();
    const allEntries = await FormKeeperStorage.getHostEntries(host);
    
    const manualCount = allEntries.filter(e => !e.auto).length;
    let hasTouchedData = false;

    for (const scope of scopes) {
      const fieldsMap = scopeFields(scope);
      if (fieldsMap.size === 0) continue;

      const currentValues = readMeaningfulValues(fieldsMap);
      if (Object.keys(currentValues).length > 0) {
        hasTouchedData = true;
        break;
      }
    }

    return { hasTouchedData, matchCount: manualCount };
  }

  let statusRequestId = 0;
  async function reportStatus() {
    if (window.top !== window) return;

    const requestId = ++statusRequestId;
    try {
      const settingsNow = await FormKeeperStorage.getSettings();
      const currentHost = getLanguageAwareHost();
      const enabledNow = window === window.top ? await FormKeeperStorage.getSiteEnabled(currentHost) : siteEnabled;
      if (requestId !== statusRequestId) return; 
      siteEnabled = enabledNow; 

      if (!settingsNow.autoDetect) {
        hideFloatingSaveButton();
        if (chrome.runtime?.sendMessage) chrome.runtime.sendMessage({ type: "FK_STATUS_UPDATE", matchCount: 0, hasTouchedData: false }).catch(() => {});
        return;
      }

      const status = await computeStatus();
      if (requestId !== statusRequestId) return; 
      updateFloatingSaveButton();

      if (chrome.runtime?.sendMessage) {
        chrome.runtime.sendMessage({ type: "FK_STATUS_UPDATE", matchCount: status.matchCount, hasTouchedData: enabledNow && status.hasTouchedData }).catch(() => {});
        
        const host = getLanguageAwareHost();
        const allEntries = await FormKeeperStorage.getHostEntries(host);
        const manualEntries = allEntries.filter(e => !e.auto);
        const profiles = await FormKeeperStorage.getHostEntries("__PROFILES__");
        chrome.runtime.sendMessage({ type: "FK_UPDATE_CONTEXT_MENU", entries: manualEntries, profiles: profiles }).catch(() => {});
      }
    } catch {}
  }

  function attachTrackingListeners(scope) {
    const target = scope.__pseudo ? document : scope;
    if (idleTimers.has(target)) return; 
    const handleInput = () => {
      if (isFilling || !siteEnabled) return; 
      clearTimeout(idleTimers.get(target));
      idleTimers.set(target, setTimeout(() => { saveScope(scope, { mode: "backup" }).then(() => reportStatus()).catch(() => {}); }, 1300));
    };
    target.addEventListener("input", handleInput, true); target.addEventListener("change", handleInput, true); idleTimers.set(target, null);
    if (!scope.__pseudo) scope.addEventListener("submit", () => { if (!siteEnabled) return; handleFormSubmit(scope).catch(() => {}); }, true);
  }

  async function scanPage() {
    settings = await FormKeeperStorage.getSettings();
    if (window === window.top) {
      siteEnabled = await FormKeeperStorage.getSiteEnabled(getLanguageAwareHost());
    }
    if (!settings.autoDetect) return;
    const scopes = getFormScopes();
    for (const scope of scopes) attachTrackingListeners(scope);
    reportStatus(); return scopes;
  }

  if (chrome.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes.fk_sites) return;
      if (window === window.top) {
         FormKeeperStorage.getSiteEnabled(getLanguageAwareHost()).then((enabled) => { siteEnabled = enabled; updateFloatingSaveButton(); reportStatus(); }).catch(() => {});
      }
    });
  }

  function findScopesByFormIdOrSignature(scopes, formId, signature) {
    let matches = scopes.filter((s) => getFormId(s) === formId || buildSignature(scopeFields(s)) === signature);
    if (matches.length > 0) return matches;
    const savedKeys = signature.split("::"); let bestScope = null; let bestScore = 0;
    for (const scope of scopes) {
      const currentKeys = new Set(scopeFields(scope).keys()); let score = 0;
      for (const key of savedKeys) { if (currentKeys.has(key)) score++; }
      if (score > bestScore && score >= Math.ceil(savedKeys.length / 2)) { bestScore = score; bestScope = scope; }
    }
    return bestScope ? [bestScope] : [];
  }

  async function fillScope(scope, entry, fieldsMap) {
    const map = fieldsMap || scopeFields(scope);
    const isMergeFill = settings && settings.mergeFill;

    for (const [key, fieldEntry] of map) {
      const saved = entry.fields[key];
      if (isMergeFill && !saved) continue;
      writeFieldValue(fieldEntry, saved ? saved.value : undefined);
      await sleep(150);
    }
    return map;
  }

  const executeFillPass = async (entry) => {
    const scopes = getFormScopes();
    let filledAny = false;

    if (entry.isProfile) {
      let bestScope = null;
      let maxMatches = 0;
      const scopeInstructions = new Map();

      for (const scope of scopes) {
        const map = scopeFields(scope);
        const pageFields = Array.from(map.entries());
        let matches = 0;
        let instructions = [];

        for (const [pKey, pField] of pageFields) {
           const pSem = getSemanticType(pKey, pField.label, pField.elements[0]);
           const injectedValue = getProfileValueForField(entry, pKey, pField, pSem);
           if (injectedValue != null) {
              matches++;
              instructions.push({ field: pField, value: injectedValue, profKey: pKey, profSem: pSem });
           }
        }
        
        const isVisible = scope.__pseudo || (scope.getBoundingClientRect && scope.getBoundingClientRect().height > 0);
        const weight = isVisible ? matches * 2 : matches;

        if (weight > maxMatches) {
          maxMatches = weight;
          bestScope = scope;
          scopeInstructions.set(scope, instructions);
        }
      }

      if (!bestScope) return false;

      const instructions = scopeInstructions.get(bestScope);
      const map = scopeFields(bestScope);
      clearWatchersForFields(map); 

      for (const inst of instructions) {
        writeFieldValue(inst.field, inst.value);
        filledAny = true;

        const info = { kind: "replace", host: "__PROFILES__", entryId: entry.id, key: inst.profKey, type: inst.field.type, label: inst.field.label, filledValue: inst.value, semantic: inst.profSem };
        for (const el of inst.field.elements) {
          const watcher = { info, fieldEntry: inst.field, el, lastSeenValue: inst.value };
          fillWatchers.set(el, watcher);
          activeWatchers.push(watcher);
        }
        await sleep(150);
      }
      return filledAny;
    }

    const targetScopes = findScopesByFormIdOrSignature(scopes, entry.formId, entry.signature);
    if (targetScopes.length === 0) return false;
    
    const scopeToFill = targetScopes[targetScopes.length - 1];
    const fieldsMap = scopeFields(scopeToFill);
    
    clearWatchersForFields(fieldsMap);
    await fillScope(scopeToFill, entry, fieldsMap);
    trackFilledFields(entry, fieldsMap);
    
    return true;
  };

  async function triggerFillSequence(entry, sendResponseCallback = null, isTopFrameWithIframes = false) {
    isFilling = true; hideFieldPopup();
    
    let success1 = await executeFillPass(entry);
    reportStatus();

    setTimeout(async () => {
      let success2 = await executeFillPass(entry);
      reportStatus();

      const globalSuccess = success1 || success2;

      if (sendResponseCallback) {
          if (globalSuccess || isTopFrameWithIframes) sendResponseCallback({ ok: true }); 
          else sendResponseCallback({ ok: false, error: "Couldn't find matching fields on this page." });
      }

      setTimeout(() => { 
        isFilling = false; 
        for(const watcher of activeWatchers) watcher.lastSeenValue = readFieldValue(watcher.fieldEntry);
      }, 300);
      
    }, 800);
  }

  window.addEventListener("message", (e) => {
    if (e.data?.fkBroadcast && e.data?.action === "triggerFill") {
      triggerFillSequence(e.data.entry);
    }
  });

  if (chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "FK_GET_EXACT_HOST") { 
          if (window === window.top) sendResponse({ host: getLanguageAwareHost() }); 
          return; 
      }
      if (message?.type === "FK_REQUEST_ENTRIES_FOR_MENU") {
        if (window === window.top) { 
            FormKeeperStorage.getHostEntries(getLanguageAwareHost()).then(entries => { sendResponse({ entries: entries.filter(e => !e.auto) }); }); 
            return true; 
        }
        return;
      }

      if (message?.type === "FK_FILL_ENTRY") {
        let hasIframes = false;
        if (window === window.top) {
           const frames = document.querySelectorAll('iframe');
           hasIframes = frames.length > 0;
           frames.forEach(f => {
              try { f.contentWindow.postMessage({ fkBroadcast: true, action: "triggerFill", entry: message.entry }, "*"); } catch(err){}
           });
        }
        triggerFillSequence(message.entry, sendResponse, hasIframes);
        return true;
      }

      if (message?.type === "FK_CONTEXT_FILL_FORM") {
        (async () => {
          const hostEntries = await FormKeeperStorage.getHostEntries(getLanguageAwareHost());
          const entry = hostEntries.find(e => e.id === message.entryId);
          if (!entry) return;
          if (window === window.top) {
             document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ fkBroadcast: true, action: "triggerFill", entry: entry }, "*"); } catch(err){}
             });
          }
          triggerFillSequence(entry);
        })();
        return;
      }
      
      if (message?.type === "FK_CONTEXT_FILL_PROFILE") {
        (async () => {
          const profiles = await FormKeeperStorage.getHostEntries("__PROFILES__");
          const entry = profiles.find(e => e.id === message.entryId);
          if (!entry) return;
          entry.isProfile = true; 
          if (window === window.top) {
             document.querySelectorAll('iframe').forEach(f => {
                try { f.contentWindow.postMessage({ fkBroadcast: true, action: "triggerFill", entry: entry }, "*"); } catch(err){}
             });
          }
          triggerFillSequence(entry);
        })();
        return;
      }

      if (message?.type === "FK_CONTEXT_FORCE_FILL_FORM") {
        (async () => {
          if (!lastRightClickedElement) { return; }
          const type = (lastRightClickedElement.type || lastRightClickedElement.tagName).toLowerCase();
          if (type === "radio" || type === "checkbox") { return; }
          const hostEntries = await FormKeeperStorage.getHostEntries(getLanguageAwareHost());
          const entry = hostEntries.find(e => e.id === message.entryId);
          if (!entry) return;

          const savedFieldData = entry.fields[message.fieldKey];
          if (!savedFieldData || savedFieldData.value === undefined || savedFieldData.value === null || savedFieldData.value === "") { 
             return; 
          }

          const scopes = getFormScopes(); let matchedFieldEntry = null; let matchedKey = null;
          for (const scope of scopes) {
            const map = scopeFields(scope);
            for (const [key, fieldData] of map) { if (fieldData.elements.includes(lastRightClickedElement)) { matchedFieldEntry = fieldData; matchedKey = key; break; } }
            if (matchedFieldEntry) break;
          }
          if (!matchedFieldEntry) { return; }

          isFilling = true; writeFieldValue(matchedFieldEntry, savedFieldData.value);
          const info = { kind: "replace", host: getLanguageAwareHost(), entryId: entry.id, key: matchedKey, type: matchedFieldEntry.type, label: matchedFieldEntry.label, filledValue: savedFieldData.value };
          const watcher = { info, fieldEntry: matchedFieldEntry, lastSeenValue: savedFieldData.value };
          fillWatchers.set(lastRightClickedElement, watcher); activeWatchers.push(watcher);
          setTimeout(() => isFilling = false, 300); reportStatus();
        })();
        return;
      }

      if (message?.type === "FK_CONTEXT_FORCE_FILL_PROFILE") {
        (async () => {
          if (!lastRightClickedElement) { return; }
          const type = (lastRightClickedElement.type || lastRightClickedElement.tagName).toLowerCase();
          if (type === "radio" || type === "checkbox") { return; }
          
          const profiles = await FormKeeperStorage.getHostEntries("__PROFILES__");
          const entry = profiles.find(e => e.id === message.entryId);
          if (!entry) return;

          const savedFieldData = entry.fields[message.fieldKey];
          if (!savedFieldData || savedFieldData.value === undefined || savedFieldData.value === null || savedFieldData.value === "") { 
             return; 
          }

          const scopes = getFormScopes(); let matchedFieldEntry = null; let matchedKey = null;
          for (const scope of scopes) {
            const map = scopeFields(scope);
            for (const [key, fieldData] of map) { if (fieldData.elements.includes(lastRightClickedElement)) { matchedFieldEntry = fieldData; matchedKey = key; break; } }
            if (matchedFieldEntry) break;
          }
          if (!matchedFieldEntry) { return; }

          isFilling = true; writeFieldValue(matchedFieldEntry, savedFieldData.value);
          const info = { kind: "replace", host: "__PROFILES__", entryId: entry.id, key: matchedKey, type: matchedFieldEntry.type, label: matchedFieldEntry.label, filledValue: savedFieldData.value };
          const watcher = { info, fieldEntry: matchedFieldEntry, lastSeenValue: savedFieldData.value };
          fillWatchers.set(lastRightClickedElement, watcher); activeWatchers.push(watcher);
          setTimeout(() => isFilling = false, 300); reportStatus();
        })();
        return;
      }

      if (message?.type === "FK_MANUAL_SAVE") {
        (async () => {
          const scopes = getFormScopes(); let savedCount = 0;
          for (const scope of scopes) {
            const saved = await saveScope(scope, { mode: "new", isProfile: message.isProfile }).catch(() => null);
            if (saved) savedCount++;
          }
          reportStatus();
          if (savedCount === 0) sendResponse({ ok: false, error: "No filled-in fields found on this page to save." });
          else sendResponse({ ok: true, count: savedCount });
        })();
        return true;
      }

      if (message?.type === "FK_GET_PAGE_STATUS") { 
          (async () => { const status = await computeStatus(); sendResponse({ ok: true, status }); })(); 
          return true; 
      }
      
      if (message?.type === "FK_PING") { 
          sendResponse({ ok: true }); 
          return; 
      }
    });
  }

  function boot() {
    scanPage().catch(() => {});
    for (const delay of [1000, 2500, 5000, 9000]) setTimeout(() => scanPage().catch(() => {}), delay);
    window.addEventListener("hashchange", () => scanPage().catch(() => {}));
    let rescanTimer = null;
    const observer = new MutationObserver(() => { clearTimeout(rescanTimer); rescanTimer = setTimeout(() => scanPage().catch(() => {}), 1500); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === "complete" || document.readyState === "interactive") setTimeout(boot, 300);
  else document.addEventListener("DOMContentLoaded", () => setTimeout(boot, 300));
})();