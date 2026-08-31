(async function () {
  // --- Tab Routing Engine ---
  const optTabs = document.querySelectorAll(".opt-tab");
  const tabPanes = document.querySelectorAll(".tab-pane");

  optTabs.forEach(tab => {
    tab.addEventListener("click", () => {
      optTabs.forEach(t => t.classList.remove("active"));
      tabPanes.forEach(p => p.hidden = true);
      tab.classList.add("active");
      document.getElementById(tab.dataset.target).hidden = false;
    });
  });

  const autoDetectEl = document.getElementById("autoDetect");
  const autoPromptEl = document.getElementById("autoPrompt");
  const includeSensitiveEl = document.getElementById("includeSensitive");
  const mergeFillEl = document.getElementById("mergeFill");
  const retentionDaysEl = document.getElementById("retentionDays");

  const exportBtn = document.getElementById("exportBtn");
  const exportCsvBtn = document.getElementById("exportCsvBtn");
  const importInput = document.getElementById("importInput");
  const clearAllBtn = document.getElementById("clearAllBtn");
  const dataStatus = document.getElementById("dataStatus");

  const siteGroupsEl = document.getElementById("siteGroups");
  const profileGroupsEl = document.getElementById("profileGroups");
  const siteGroupTemplate = document.getElementById("siteGroupTemplate");
  const dataEntryTemplate = document.getElementById("dataEntryTemplate");
  const fieldRowTemplate = document.getElementById("fieldRowTemplate");
  const browseSearch = document.getElementById("browseSearch");

  // ---------- settings ----------

  async function loadSettings() {
    const s = await FormKeeperStorage.getSettings();
    autoDetectEl.checked = s.autoDetect;
    autoPromptEl.checked = s.autoPrompt;
    includeSensitiveEl.checked = s.includeSensitive;
    mergeFillEl.checked = !!s.mergeFill;
    retentionDaysEl.value = String(s.retentionDays || 0);
  }

  function wireSetting(el, key, transform = (v) => v) {
    el.addEventListener("change", async () => {
      const value = el.type === "checkbox" ? el.checked : el.value;
      await FormKeeperStorage.saveSettings({ [key]: transform(value) });
    });
  }

  wireSetting(autoDetectEl, "autoDetect");
  wireSetting(autoPromptEl, "autoPrompt");
  wireSetting(includeSensitiveEl, "includeSensitive");
  wireSetting(mergeFillEl, "mergeFill");
  wireSetting(retentionDaysEl, "retentionDays", (v) => parseInt(v, 10));

  // ---------- export / import / clear ----------

  function getTimestampedFilename(extension) {
    const d = new Date();
    const date = d.toISOString().slice(0, 10);
    const time = d.toTimeString().replace(/:/g, '-').split(' ')[0];
    return `form-keeper-backup-${date}_${time}.${extension}`;
  }

  exportBtn.addEventListener("click", async () => {
    const payload = await FormKeeperStorage.exportAll();
    
    let dataRoot = payload.data || payload.fk_data || {};
    if (dataRoot && typeof dataRoot === 'object') {
      for (const host of Object.keys(dataRoot)) {
        if (Array.isArray(dataRoot[host])) {
          dataRoot[host] = dataRoot[host].filter(e => !e.auto);
          if (dataRoot[host].length === 0) delete dataRoot[host];
        }
      }
    }

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = getTimestampedFilename("json");
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Exported as JSON.");
  });

  exportCsvBtn.addEventListener("click", async () => {
    const data = await FormKeeperStorage.getAllData();
    let csv = "Site,Entry ID,Form Label,Date Saved,Field Name,Field Key,Field Value,Semantic Anchor\n";

    const escapeCsv = (str) => {
       if (str == null) return '""';
       const s = String(str).replace(/"/g, '""');
       return `"${s}"`;
    };

    for (const host of Object.keys(data)) {
      const displayHost = host === "__PROFILES__" ? "Global Profiles" : host;
      for (const entry of data[host]) {
        if (entry.auto) continue;

        const entryId = entry.id || "";
        const formLabel = entry.label || "Untitled form";
        const dateSaved = new Date(entry.savedAt || Date.now()).toISOString();

        for (const [key, field] of Object.entries(entry.fields || {})) {
           const fieldName = field.label || key;
           let val = field.value;
           if (typeof val === "boolean") val = val ? "checked" : "unchecked";
           else if (Array.isArray(val)) val = val.join(", ");
           else val = String(val ?? "");

           csv += `${escapeCsv(displayHost)},${escapeCsv(entryId)},${escapeCsv(formLabel)},${escapeCsv(dateSaved)},${escapeCsv(fieldName)},${escapeCsv(key)},${escapeCsv(val)},${escapeCsv(field.semantic || "")}\n`;
        }
      }
    }

    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = getTimestampedFilename("csv");
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus("Exported as CSV.");
  });

  function parseCSV(text) {
    const rows = [];
    let row = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (i + 1 < text.length && text[i + 1] === '"') {
            cur += '"';
            i++; 
          } else {
            inQuotes = false;
          }
        } else {
          cur += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          row.push(cur);
          cur = '';
        } else if (c === '\n' || c === '\r') {
          row.push(cur);
          rows.push(row);
          row = [];
          cur = '';
          if (c === '\r' && text[i + 1] === '\n') i++; 
        } else {
          cur += c;
        }
      }
    }
    if (cur !== '' || row.length > 0) {
      row.push(cur);
      rows.push(row);
    }
    return rows;
  }

  importInput.addEventListener("change", async () => {
    const file = importInput.files[0];
    if (!file) return;
    try {
      const text = await file.text();

      if (file.name.toLowerCase().endsWith(".csv")) {
        const rows = parseCSV(text);
        if (rows.length < 2) throw new Error("Empty CSV");
        
        const headers = rows[0].map(h => h.trim());
        if (!headers.includes("Site") || !headers.includes("Form Label")) {
          throw new Error("Invalid CSV format");
        }

        const dataRoot = {};

        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          if (row.length < 2) continue; 
          
          const getCol = (name) => {
            const idx = headers.indexOf(name);
            return idx !== -1 && idx < row.length ? row[idx] : "";
          };

          let host = getCol("Site");
          if (host === "Global Profiles") host = "__PROFILES__";
          const entryId = getCol("Entry ID");
          const formLabel = getCol("Form Label");
          const dateSavedStr = getCol("Date Saved");
          const fieldName = getCol("Field Name");
          const fieldKey = getCol("Field Key") || ("lbl:" + fieldName.toLowerCase().trim().replace(/\s+/g, "-"));
          const fieldValue = getCol("Field Value");
          const fieldSemantic = getCol("Semantic Anchor"); 
          
          if (!host) continue;
          if (!dataRoot[host]) dataRoot[host] = [];
          
          let savedAt = Date.parse(dateSavedStr);
          if (isNaN(savedAt)) savedAt = Date.now();

          let entry;
          if (entryId) {
             entry = dataRoot[host].find(e => e.id === entryId);
          }
          if (!entry) {
             entry = dataRoot[host].find(e => e.label === formLabel && Math.abs((e.savedAt || 0) - savedAt) < 60000);
          }

          if (!entry) {
            const fallbackStr = (host + formLabel + dateSavedStr).replace(/\s+/g, '');
            const deterministicId = entryId || ("csv-" + btoa(unescape(encodeURIComponent(fallbackStr))).replace(/[^a-zA-Z0-9]/g, '').slice(0, 16));
            
            entry = {
              id: deterministicId,
              label: formLabel || "Untitled form",
              savedAt: savedAt,
              updatedAt: savedAt,
              auto: false,
              formId: host === "__PROFILES__" ? `profile-${Date.now()}` : "csv-import",
              signature: host === "__PROFILES__" ? "profile" : "csv-import",
              path: host === "__PROFILES__" ? "*" : "/",
              isProfile: host === "__PROFILES__",
              fields: {}
            };
            dataRoot[host].push(entry);
          }

          let parsedValue = fieldValue;
          let fieldType = "text";
          if (parsedValue === "checked" || parsedValue === "true") {
            parsedValue = true;
            fieldType = "checkbox";
          } else if (parsedValue === "unchecked" || parsedValue === "false") {
            parsedValue = false;
            fieldType = "checkbox";
          } else if (parsedValue.includes(", ")) {
            parsedValue = parsedValue.split(", ");
            fieldType = "select-multiple";
          }

          entry.fields[fieldKey] = {
            label: fieldName,
            value: parsedValue,
            type: fieldType,
            semantic: fieldSemantic || null
          };
        }
        
        for (const host of Object.keys(dataRoot)) {
          for (const entry of dataRoot[host]) {
            if (entry.signature === "csv-import") {
              entry.signature = Object.keys(entry.fields).sort().join("::");
              entry.formId = ""; 
            }
            await FormKeeperStorage.saveEntry(host, entry);
          }
        }
        
      } else {
        const payload = JSON.parse(text);
        await FormKeeperStorage.importAll(payload, true);
      }

      setStatus("Import complete.");
      await loadSettings();
      await renderBrowser();
    } catch (e) {
      setStatus("That file couldn't be imported — is it a valid Form Keeper backup?");
    } finally {
      importInput.value = "";
    }
  });

  clearAllBtn.addEventListener("click", async () => {
    if (!confirm("Delete every saved form on every site? This can't be undone.")) return;
    await FormKeeperStorage.clearAll();
    setStatus("All saved form data deleted.");
    await renderBrowser();
  });

  function setStatus(msg) {
    dataStatus.textContent = msg;
    setTimeout(() => {
      if (dataStatus.textContent === msg) dataStatus.textContent = "";
    }, 4000);
  }

  browseSearch.addEventListener("input", () => renderBrowser());

  function formatDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) +
      " at " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  async function renderBrowser() {
    const term = browseSearch.value.trim().toLowerCase();
    
    // Capture currently expanded groups to maintain state across re-renders
    const expandedGroups = new Set();
    document.querySelectorAll(".site-group:not(.collapsed) .site-name").forEach(el => {
      expandedGroups.add(el.textContent);
    });

    const data = await FormKeeperStorage.getAllData();
    siteGroupsEl.innerHTML = "";
    profileGroupsEl.innerHTML = "";

    let hosts = Object.keys(data).filter((host) => data[host].some((e) => !e.auto)).sort();
    if (term) {
      hosts = hosts.filter(
        (host) =>
          host.toLowerCase().includes(term) ||
          data[host].some((e) => !e.auto && (e.label || "").toLowerCase().includes(term))
      );
    }

    let hasProfiles = false;
    let hasSites = false;

    for (const host of hosts) {
      let entries = data[host]
        .filter((e) => !e.auto)
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      if (term) {
        entries = entries.filter(
          (e) => host.toLowerCase().includes(term) || (e.label || "").toLowerCase().includes(term)
        );
      }
      if (entries.length === 0) continue;

      const group = siteGroupTemplate.content.cloneNode(true);
      const isProfile = host === "__PROFILES__";
      const displayHost = isProfile ? "Global Profiles" : host;
      
      group.querySelector(".site-name").textContent = displayHost;
      group.querySelector(".site-count").textContent = `${entries.length} saved`;
      
      const groupEl = group.querySelector(".site-group");
      
      // Re-expand the group if it was open before the render
      if (expandedGroups.has(displayHost)) {
        groupEl.classList.remove("collapsed");
      }
      
      const headerEl = group.querySelector(".site-group-header");
      headerEl.addEventListener("click", (e) => {
        if (e.target.closest(".site-clear-btn")) return;
        groupEl.classList.toggle("collapsed");
      });

      const clearBtn = group.querySelector(".site-clear-btn");
      if (isProfile) {
        clearBtn.textContent = "Clear Profiles";
      }
      
      clearBtn.addEventListener("click", async () => {
        if (!confirm(`Delete all saved forms for ${displayHost}?`)) return;
        await FormKeeperStorage.clearHost(host);
        renderBrowser();
      });

      const entriesContainer = group.querySelector(".site-entries");
      for (const entry of entries) {
        entriesContainer.appendChild(buildEntryNode(host, entry));
      }
      
      if (isProfile) {
        profileGroupsEl.appendChild(group);
        hasProfiles = true;
      } else {
        siteGroupsEl.appendChild(group);
        hasSites = true;
      }
    }

    if (!hasProfiles) {
      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = "No global profiles yet.";
      profileGroupsEl.appendChild(empty);
    }

    if (!hasSites) {
      const empty = document.createElement("p");
      empty.className = "empty-note";
      empty.textContent = "No saved site forms yet.";
      siteGroupsEl.appendChild(empty);
    }
  }

  function buildEntryNode(host, entry) {
    const node = dataEntryTemplate.content.cloneNode(true);
    const labelEl = node.querySelector(".data-entry-label");
    labelEl.textContent = entry.label || "Untitled form";

    const toggleBtn = node.querySelector(".toggle-fields-btn");
    const showAllBtn = node.querySelector(".show-all-btn");
    const renameEntryBtn = node.querySelector(".rename-entry-btn");
    const panel = node.querySelector(".fields-panel");
    const metaEl = node.querySelector(".data-entry-meta");
    const deleteEntryBtn = node.querySelector(".delete-entry-btn");

    let allRevealed = false;

    const updateMeta = () => {
      const fieldCount = Object.keys(entry.fields || {}).length;
      const autoTag = entry.auto ? " · auto-saved backup" : "";
      metaEl.textContent = `${fieldCount} field${fieldCount === 1 ? "" : "s"} · saved ${formatDate(entry.savedAt)}${autoTag}`;
    };
    updateMeta();

    renameEntryBtn.addEventListener("click", () => {
      const input = document.createElement("input");
      input.value = entry.label || "";
      input.style.cssText = "flex: 1; background: #0c1114; color: #ecf1f3; border: 1px solid #263038; border-radius: 4px; padding: 2px 6px; font-size: 14px; font-weight: 600; font-family: inherit; margin-right: 15px;";
      
      labelEl.replaceWith(input);
      input.focus();
      input.select();

      const commit = async () => {
        const newLabel = input.value.trim() || "Untitled form";
        await FormKeeperStorage.saveEntry(host, { id: entry.id, label: newLabel });
        entry.label = newLabel;
        labelEl.textContent = newLabel;
        input.replaceWith(labelEl);
      };

      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") input.replaceWith(labelEl);
      });
    });

    showAllBtn.addEventListener("click", () => {
      allRevealed = !allRevealed;
      showAllBtn.textContent = allRevealed ? "Hide inputs" : "Show inputs";
      
      const values = panel.querySelectorAll(".field-value");
      const revealBtns = panel.querySelectorAll(".reveal-btn");
      
      values.forEach(v => {
        if (allRevealed) v.classList.remove("masked");
        else v.classList.add("masked");
      });
      
      revealBtns.forEach(btn => {
        btn.textContent = allRevealed ? "hide" : "show";
      });
    });

    toggleBtn.addEventListener("click", () => {
      const willShow = panel.hidden;
      panel.hidden = !willShow;
      toggleBtn.textContent = willShow ? "Hide fields" : "View fields";
      showAllBtn.hidden = !willShow; 
      renameEntryBtn.hidden = !willShow; 
      
      if (willShow && panel.childElementCount === 0) {
        for (const [key, field] of Object.entries(entry.fields || {})) {
          const row = fieldRowTemplate.content.cloneNode(true);
          const nameEl = row.querySelector(".field-name");
          nameEl.textContent = field.label || key;
          const valueEl = row.querySelector(".field-value");
          
          const getDisplayValue = (val) => {
            if (typeof val === "boolean") return val ? "checked" : "unchecked";
            if (Array.isArray(val)) return val.join(", ");
            return String(val ?? "");
          };

          valueEl.textContent = getDisplayValue(field.value);

          const revealBtn = row.querySelector(".reveal-btn");
          revealBtn.addEventListener("click", () => {
            const masked = valueEl.classList.toggle("masked");
            revealBtn.textContent = masked ? "show" : "hide";
          });

          const copyBtn = row.querySelector(".copy-btn");
          copyBtn.addEventListener("click", async () => {
            try {
              const valToCopy = Array.isArray(field.value) ? field.value.join(", ") : String(field.value ?? "");
              await navigator.clipboard.writeText(valToCopy);
              const orig = copyBtn.textContent;
              copyBtn.textContent = "copied!";
              setTimeout(() => copyBtn.textContent = orig, 1500);
            } catch (err) {}
          });

          const renameFieldBtn = row.querySelector(".rename-field-btn");
          renameFieldBtn.addEventListener("click", () => {
            const input = document.createElement("input");
            input.value = field.label || key;
            input.style.cssText = "flex: 1; background: #0c1114; color: #ecf1f3; border: 1px solid #4fd1b0; border-radius: 4px; padding: 2px 6px; font-size: 12px; font-weight: 600; font-family: inherit; margin-right: 15px;";
            
            nameEl.replaceWith(input);
            input.focus();
            input.select();

            const commit = async () => {
              const newLabel = input.value.trim() || field.label || key;
              field.label = newLabel;
              nameEl.textContent = newLabel;
              input.replaceWith(nameEl);
              
              const updatedFields = { ...entry.fields };
              updatedFields[key] = field;
              entry.fields = updatedFields;
              await FormKeeperStorage.saveEntry(host, { id: entry.id, fields: updatedFields });
            };

            input.addEventListener("blur", commit);
            input.addEventListener("keydown", (e) => {
              if (e.key === "Enter") input.blur();
              if (e.key === "Escape") input.replaceWith(nameEl);
            });
          });

          const editBtn = row.querySelector(".edit-btn");
          editBtn.addEventListener("click", () => {
            const input = document.createElement("input");
            input.value = Array.isArray(field.value) ? field.value.join(", ") : String(field.value ?? "");
            input.style.cssText = "flex: 1; background: #0c1114; color: #ecf1f3; border: 1px solid #263038; border-radius: 4px; padding: 2px 6px; font-size: 12px; font-family: inherit;";
            
            valueEl.replaceWith(input);
            input.focus();

            const commit = async () => {
              let newVal = input.value;
              
              if (typeof field.value === "boolean") {
                newVal = newVal.toLowerCase() === "true" || newVal === "checked";
              } else if (Array.isArray(field.value)) {
                newVal = input.value.split(",").map(s => s.trim()).filter(Boolean);
              }
              
              field.value = newVal;
              valueEl.textContent = getDisplayValue(field.value);
              valueEl.classList.remove("masked");
              revealBtn.textContent = "hide";
              input.replaceWith(valueEl);
              
              const updatedFields = { ...entry.fields };
              updatedFields[key] = field;
              entry.fields = updatedFields;
              await FormKeeperStorage.saveEntry(host, { id: entry.id, fields: updatedFields });
            };

            input.addEventListener("blur", commit);
            input.addEventListener("keydown", (e) => {
              if (e.key === "Enter") input.blur();
              if (e.key === "Escape") input.replaceWith(valueEl);
            });
          });

          const deleteFieldBtn = row.querySelector(".delete-field-btn");
          const rowEl = row.querySelector(".field-row");
          deleteFieldBtn.addEventListener("click", async () => {
            if (deleteFieldBtn.dataset.confirm !== "1") {
              deleteFieldBtn.dataset.confirm = "1";
              deleteFieldBtn.textContent = "confirm?";
              setTimeout(() => {
                deleteFieldBtn.dataset.confirm = "0";
                deleteFieldBtn.textContent = "delete";
              }, 2500);
              return;
            }
            const updatedFields = { ...entry.fields };
            delete updatedFields[key];
            entry.fields = updatedFields;
            await FormKeeperStorage.saveEntry(host, { id: entry.id, fields: updatedFields });
            rowEl.remove();
            updateMeta();
          });
          panel.appendChild(row);
        }
      }
    });

    deleteEntryBtn.addEventListener("click", async (e) => {
      const btn = e.currentTarget;
      if (btn.dataset.confirm !== "1") {
        btn.dataset.confirm = "1";
        btn.textContent = "Confirm?";
        setTimeout(() => {
          btn.dataset.confirm = "0";
          btn.textContent = "Delete";
        }, 2500);
        return;
      }
      await FormKeeperStorage.deleteEntry(host, entry.id);
      renderBrowser();
    });

    return node;
  }

  await loadSettings();
  await renderBrowser();
})();