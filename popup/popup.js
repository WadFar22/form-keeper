(async function () {
  const listContainer = document.getElementById("listContainer");
  const entryTemplate = document.getElementById("entryTemplate");
  const emptyTemplate = document.getElementById("emptyTemplate");
  
  const tabs = document.querySelectorAll(".tab");
  const allSearchWrap = document.getElementById("allSearchWrap");
  const searchInput = document.getElementById("searchInput");
  const manageLink = document.getElementById("manageLink");
  const openOptionsBtn = document.getElementById("openOptions");
  const openGuideBtn = document.getElementById("openGuide");
  const saveCurrentBtn = document.getElementById("saveCurrentBtn");
  const siteToggle = document.getElementById("siteToggle");
  const siteToggleHost = document.getElementById("siteToggleHost");
  const btnWrapper = document.getElementById("btnWrapper");
  const saveHint = document.getElementById("saveHint");

  let activeTabMode = "site";
  let currentHost = "";
  let searchTerm = "";

  openOptionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  openGuideBtn.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("guide.html") }));
  manageLink.addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  saveCurrentBtn.addEventListener("click", () => doManualSave(saveCurrentBtn));

  function doManualSave(triggerBtn) {
    if (triggerBtn.dataset.locked === "true") return;

    const originalText = triggerBtn.textContent;
    triggerBtn.disabled = true;
    triggerBtn.textContent = "Saving\u2026";
    
    const isProfile = activeTabMode === "profiles";
    
    chrome.runtime.sendMessage({ type: "FK_MANUAL_SAVE_ON_ACTIVE_TAB", isProfile }, (response) => {
      triggerBtn.textContent = originalText;
      if (response?.ok && response.result?.ok) {
        showToast(
          response.result.count > 1
            ? `Saved ${response.result.count} forms as new entries \u2713`
            : "Saved successfully \u2713"
        );
        currentHost = ""; 
        render();
        loadPageStatus();
      } else {
        showToast(response?.result?.error || response?.error || "Nothing to save on this page.");
        loadPageStatus();
      }
    });
  }

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      activeTabMode = tab.dataset.tab;
      allSearchWrap.hidden = activeTabMode !== "all";
      
      if (activeTabMode === "profiles") {
        saveCurrentBtn.textContent = "+ Save current form as a Profile";
      } else {
        saveCurrentBtn.textContent = "+ Save current form as new entry";
      }
      
      render();
    });
  });

  searchInput.addEventListener("input", () => {
    searchTerm = searchInput.value.trim().toLowerCase();
    render();
  });

  async function getCurrentHost() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url) return "";

      if (tab.id) {
        try {
          const exactHost = await new Promise((resolve) => {
            chrome.tabs.sendMessage(tab.id, { type: "FK_GET_EXACT_HOST" }, { frameId: 0 }, (res) => {
              if (chrome.runtime.lastError) resolve(null);
              else resolve(res?.host);
            });
          });
          if (exactHost) return exactHost;
        } catch(e) {}
      }

      const url = new URL(tab.url);
      const baseHost = url.hostname;
      
      const firstDir = url.pathname.split('/').filter(Boolean)[0];
      if (firstDir && /^[a-z]{2}(-[a-z]{2})?$/i.test(firstDir)) {
        return `${baseHost}/${firstDir.split('-')[0].toLowerCase()}`;
      }
      
      const params = new URLSearchParams(url.search);
      const langParam = params.get("lang") || params.get("locale");
      if (langParam && /^[a-z]{2}(-[a-z]{2})?$/i.test(langParam)) {
        return `${baseHost}/[${langParam.split('-')[0].toLowerCase()}]`;
      }
      
      return baseHost;
    } catch {
      return "";
    }
  }

  async function loadSiteToggle() {
    if (!currentHost) {
      siteToggle.disabled = true;
      siteToggle.checked = false;
      siteToggleHost.textContent = "Open a regular web page";
      return;
    }
    siteToggle.disabled = false;
    siteToggleHost.textContent = currentHost;
    siteToggle.checked = await FormKeeperStorage.getSiteEnabled(currentHost);
  }

  siteToggle.addEventListener("change", async () => {
    if (!currentHost) return;
    await FormKeeperStorage.setSiteEnabled(currentHost, siteToggle.checked);
    showToast(siteToggle.checked ? `Recording on for ${currentHost} \u2713` : `Recording off for ${currentHost}`);
  });

  function formatDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
      " · " + d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function fieldCount(entry) {
    const n = Object.keys(entry.fields || {}).length;
    return `${n} field${n === 1 ? "" : "s"}`;
  }

  async function buildSiteList() {
    const entries = await FormKeeperStorage.getHostEntries(currentHost);
    const manualEntries = entries.filter((e) => !e.auto).map((e) => ({ ...e, host: currentHost }));
    
    const autoEntries = entries.filter((e) => e.auto).sort((a, b) => (b.updatedAt || b.savedAt || 0) - (a.updatedAt || a.savedAt || 0));
    if (autoEntries.length > 0) {
      const latestAuto = { ...autoEntries[0], host: currentHost, isAutoDraft: true };
      return [latestAuto, ...manualEntries];
    }
    return manualEntries;
  }

  async function buildProfilesList() {
    const entries = await FormKeeperStorage.getHostEntries("__PROFILES__");
    return entries.map((e) => ({ ...e, host: "__PROFILES__" }));
  }

  async function buildAllList() {
    const data = await FormKeeperStorage.getAllData();
    const flat = [];
    for (const host of Object.keys(data)) {
      if (host === "__PROFILES__") continue; 
      for (const entry of data[host]) {
        if (entry.auto) continue;
        flat.push({ ...entry, host });
      }
    }
    return flat;
  }

function showToast(msg) {
    // Disabled: Bottom popups removed from the extension.
    return;
  }

  async function loadPageStatus() {
    chrome.runtime.sendMessage({ type: "FK_GET_PAGE_STATUS_ON_ACTIVE_TAB" }, (response) => {
      const status = response?.ok ? response.result?.status : null;
      applyPageStatus(status);
    });
  }

  function applyPageStatus(status) {
    const hasData = !!status?.hasTouchedData;
    
    if (!hasData) {
      saveCurrentBtn.dataset.locked = "true";
      saveCurrentBtn.disabled = false; 
      saveCurrentBtn.style.opacity = "1"; 
      saveCurrentBtn.style.pointerEvents = "none"; 
      btnWrapper.style.cursor = "not-allowed";
      btnWrapper.title = "Fill in a field on this page first";
    } else {
      saveCurrentBtn.dataset.locked = "false";
      saveCurrentBtn.disabled = false;
      saveCurrentBtn.style.opacity = "1";
      saveCurrentBtn.style.pointerEvents = "auto";
      btnWrapper.style.cursor = "auto";
      btnWrapper.title = "";
    }
    
    saveHint.style.display = hasData ? "none" : "block";
  }

  async function updateTabBadges() {
    const data = await FormKeeperStorage.getAllData();
    let siteCount = 0;
    let profilesCount = 0;
    let allCount = 0;

    for (const h of Object.keys(data)) {
      if (h === "__PROFILES__") {
        profilesCount = data[h].length;
      } else {
        const manualCount = data[h].filter(e => !e.auto).length;
        allCount += manualCount;
        if (h === currentHost) {
          const hasDraft = data[h].some(e => e.auto);
          siteCount = manualCount + (hasDraft ? 1 : 0);
        }
      }
    }

    document.querySelectorAll(".tab").forEach(tab => {
      const mode = tab.dataset.tab;
      let text = mode === "site" ? "This site" : mode === "profiles" ? "Profiles" : "All sites";
      let count = mode === "site" ? siteCount : mode === "profiles" ? profilesCount : allCount;
      
      if (count > 0) {
        tab.innerHTML = `${text} <span style="background: rgba(79, 209, 176, 0.15); color: #4fd1b0; padding: 2px 6px; border-radius: 12px; font-size: 11px; margin-left: 6px; font-weight: 700;">${count}</span>`;
      } else {
        tab.textContent = text;
      }
    });
  }

  async function render() {
    currentHost = currentHost || (await getCurrentHost());
    listContainer.innerHTML = "";

    let entries = [];
    if (activeTabMode === "site") entries = await buildSiteList();
    else if (activeTabMode === "profiles") entries = await buildProfilesList();
    else entries = await buildAllList();

    if (searchTerm && activeTabMode === "all") {
      entries = entries.filter(
        (e) =>
          (e.label || "").toLowerCase().includes(searchTerm) ||
          (e.host || "").toLowerCase().includes(searchTerm)
      );
    }

    if (activeTabMode === "site" && entries.length > 0 && entries[0].isAutoDraft) {
      const draft = entries.shift();
      entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      entries.unshift(draft);
    } else {
      entries.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }

    if (entries.length === 0) {
      const empty = emptyTemplate.content.cloneNode(true);
      if (activeTabMode === "site" && !currentHost) {
        empty.querySelector(".empty-body").textContent = "Open a regular web page to see saved forms for that site.";
      } else if (activeTabMode === "profiles") {
        empty.querySelector(".empty-body").textContent = "No profiles yet. Fill out your common details on any form and save them as a Profile here.";
      } else if (activeTabMode === "site") {
        empty.querySelector(".empty-body").textContent = `No saved forms for ${currentHost} yet. Fill something out and Form Keeper will offer to remember it.`;
      }
      listContainer.appendChild(empty);
      
      await updateTabBadges();
      return;
    }

    for (const entry of entries) {
      const node = entryTemplate.content.cloneNode(true);
      const labelEl = node.querySelector(".entry-label");
      const metaEl = node.querySelector(".entry-meta");
      const fillBtn = node.querySelector(".fill-btn");
      const renameBtn = node.querySelector(".rename-btn");
      const deleteBtn = node.querySelector(".delete-btn");

      if (entry.isAutoDraft) {
        labelEl.textContent = "↻ Unsaved Draft (Recovery)";
        labelEl.title = "Auto-saved backup from your last session";
        labelEl.style.color = "#4fd1b0"; 
        renameBtn.remove(); 
        deleteBtn.textContent = "Dismiss";
        fillBtn.textContent = "Restore";
      } else {
        labelEl.textContent = entry.label || "Untitled form";
        labelEl.title = entry.label || "Untitled form";
      }

      const metaBits = [fieldCount(entry), formatDate(entry.updatedAt || entry.savedAt)];
      if (activeTabMode === "all") metaBits.unshift(entry.host);
      metaEl.textContent = metaBits.join(" · ");

      fillBtn.addEventListener("click", () => handleFill(entry));
      if (!entry.isAutoDraft) renameBtn.addEventListener("click", () => handleRename(entry, labelEl));
      deleteBtn.addEventListener("click", () => handleDelete(entry, deleteBtn));

      listContainer.appendChild(node);
    }
    
    await updateTabBadges();
  }

  async function handleFill(entry) {
    const activeHost = await getCurrentHost();
    if (entry.host !== activeHost && entry.host !== "__PROFILES__") {
      showToast(`Open a page on ${entry.host} first.`);
      return;
    }
    
    entry.isProfile = entry.host === "__PROFILES__";
    
    chrome.runtime.sendMessage(
      { type: "FK_FILL_ENTRY_ON_ACTIVE_TAB", entry },
      (response) => {
        if (response?.ok && response.result?.ok) {
          setTimeout(() => window.close(), 100);
        } else {
          showToast(response?.result?.error || response?.error || "Couldn't fill that form.");
        }
      }
    );
  }

  function handleRename(entry, labelEl) {
    const input = document.createElement("input");
    input.value = entry.label || "";
    input.style.cssText =
      "width:100%;background:#0c1114;color:#ecf1f3;border:1px solid #263038;border-radius:6px;padding:4px 6px;font-size:13px;font-family:inherit;";
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    const commit = async () => {
      const newLabel = input.value.trim() || "Untitled form";
      await FormKeeperStorage.saveEntry(entry.host, { id: entry.id, label: newLabel });
      render();
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") render();
    });
  }

  function handleDelete(entry, btn) {
    if (btn.dataset.confirm !== "1") {
      btn.dataset.confirm = "1";
      const original = btn.textContent;
      btn.textContent = "Sure?";
      setTimeout(() => {
        btn.dataset.confirm = "0";
        btn.textContent = original;
      }, 2500);
      return;
    }
    FormKeeperStorage.deleteEntry(entry.host, entry.id).then(render);
  }

  currentHost = await getCurrentHost();
  loadSiteToggle();
  render();
  loadPageStatus();
})();