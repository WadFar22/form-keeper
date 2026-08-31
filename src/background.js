/**
 * Form Keeper — background service worker.
 */
importScripts("/src/storage-lib.js");

async function runRetentionCleanup() {
  try {
    await FormKeeperStorage.applyRetention();
  } catch (e) {
    console.warn("Form Keeper: retention cleanup failed", e);
  }
}

chrome.runtime.onInstalled.addListener(() => runRetentionCleanup());
chrome.runtime.onStartup.addListener(() => runRetentionCleanup());

// ---------- Context Menu Engine ----------
let currentRebuildId = 0;
let lastMenuHash = "";

function safeCreateMenu(options) {
  chrome.contextMenus.create(options, () => {
    const err = chrome.runtime.lastError; 
  });
}

function rebuildMenu(entries, profiles) {
  // Hash to prevent wiping and rebuilding the menu repeatedly on every keystroke
  const hash = "e:" + (entries || []).map(e => `${e.id}:${e.updatedAt}`).join(",") + 
               "|p:" + (profiles || []).map(p => `${p.id}:${p.updatedAt}`).join(",");

  if (hash === lastMenuHash) return;

  const rebuildId = ++currentRebuildId;

  chrome.contextMenus.removeAll(() => {
    if (rebuildId !== currentRebuildId) return;
    lastMenuHash = hash;

    if ((!entries || entries.length === 0) && (!profiles || profiles.length === 0)) return;

    safeCreateMenu({ id: "fk-root", title: "Form Keeper", contexts: ["all"] });

    // 1. Unified Profiles Tree
    if (profiles && profiles.length > 0) {
      safeCreateMenu({ id: "fk-fill-profile", parentId: "fk-root", title: "Fill from Saved Profile", contexts: ["all"] });
      profiles.forEach(p => {
        const profParentId = `prof-parent-${p.id}`;
        safeCreateMenu({ id: profParentId, parentId: "fk-fill-profile", title: p.label || "Untitled Profile", contexts: ["all"] });
        
        safeCreateMenu({ id: `fill-prof-action-${p.id}`, parentId: profParentId, title: "▶ Fill this Profile", contexts: ["all"] });
        safeCreateMenu({ id: `sep-prof-${p.id}`, parentId: profParentId, type: "separator", contexts: ["all"] });
        
        const fieldKeys = Object.keys(p.fields || {});
        if (fieldKeys.length === 0) {
           safeCreateMenu({ id: `view-prof-${p.id}-empty`, parentId: profParentId, title: "(No fields saved)", enabled: false, contexts: ["all"] });
        } else {
           fieldKeys.forEach((k) => {
             const f = p.fields[k];
             let displayVal = Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "");
             if (typeof f.value === "boolean") displayVal = f.value ? "Checked" : "Unchecked";
             if (displayVal.length > 30) displayVal = displayVal.substring(0, 30) + "..."; 
             safeCreateMenu({ id: `force-prof-action-${p.id}:::${k}`, parentId: profParentId, title: `${f.label}: ${displayVal}`, contexts: ["all"] });
           });
        }
      });
    }

    // 2. Unified Forms Tree
    if (entries && entries.length > 0) {
      safeCreateMenu({ id: "fk-fill-form", parentId: "fk-root", title: "Fill from Saved Forms", contexts: ["all"] });
      entries.forEach(e => {
        const formParentId = `form-parent-${e.id}`;
        safeCreateMenu({ id: formParentId, parentId: "fk-fill-form", title: e.label || "Untitled form", contexts: ["all"] });
        
        safeCreateMenu({ id: `fill-form-action-${e.id}`, parentId: formParentId, title: "▶ Fill this entire form", contexts: ["all"] });
        safeCreateMenu({ id: `sep-form-${e.id}`, parentId: formParentId, type: "separator", contexts: ["all"] });
        
        const fieldKeys = Object.keys(e.fields || {});
        if (fieldKeys.length === 0) {
           safeCreateMenu({ id: `view-form-${e.id}-empty`, parentId: formParentId, title: "(No fields saved)", enabled: false, contexts: ["all"] });
        } else {
           fieldKeys.forEach((k) => {
             const f = e.fields[k];
             let displayVal = Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "");
             if (typeof f.value === "boolean") displayVal = f.value ? "Checked" : "Unchecked";
             if (displayVal.length > 30) displayVal = displayVal.substring(0, 30) + "..."; 
             safeCreateMenu({ id: `force-form-action-${e.id}:::${k}`, parentId: formParentId, title: `${f.label}: ${displayVal}`, contexts: ["all"] });
           });
        }
      });
    }
  });
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  chrome.tabs.sendMessage(activeInfo.tabId, { type: "FK_REQUEST_ENTRIES_FOR_MENU" }, { frameId: 0 }, async (response) => {
    if (chrome.runtime.lastError) {
      chrome.contextMenus.removeAll();
      lastMenuHash = "";
    } else if (response && response.entries) {
      const profiles = await FormKeeperStorage.getHostEntries("__PROFILES__");
      rebuildMenu(response.entries, profiles);
    }
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const frameId = info.frameId || 0;
  if (info.menuItemId.startsWith("fill-form-action-")) {
    const entryId = info.menuItemId.replace("fill-form-action-", "");
    chrome.tabs.sendMessage(tab.id, { type: "FK_CONTEXT_FILL_FORM", entryId }, { frameId });
  } else if (info.menuItemId.startsWith("force-form-action-")) {
    const remainder = info.menuItemId.replace("force-form-action-", "");
    const [entryId, fieldKey] = remainder.split(":::");
    chrome.tabs.sendMessage(tab.id, { type: "FK_CONTEXT_FORCE_FILL_FORM", entryId, fieldKey }, { frameId });
  } else if (info.menuItemId.startsWith("fill-prof-action-")) {
    const entryId = info.menuItemId.replace("fill-prof-action-", "");
    chrome.tabs.sendMessage(tab.id, { type: "FK_CONTEXT_FILL_PROFILE", entryId }, { frameId });
  } else if (info.menuItemId.startsWith("force-prof-action-")) {
    const remainder = info.menuItemId.replace("force-prof-action-", "");
    const [entryId, fieldKey] = remainder.split(":::");
    chrome.tabs.sendMessage(tab.id, { type: "FK_CONTEXT_FORCE_FILL_PROFILE", entryId, fieldKey }, { frameId });
  }
});

const RELAY_TYPES = {
  FK_FILL_ENTRY_ON_ACTIVE_TAB: "FK_FILL_ENTRY",
  FK_MANUAL_SAVE_ON_ACTIVE_TAB: "FK_MANUAL_SAVE",
  FK_GET_PAGE_STATUS_ON_ACTIVE_TAB: "FK_GET_PAGE_STATUS",
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type in RELAY_TYPES) {
    (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        sendResponse({ ok: false, error: "No active tab." });
        return;
      }
      try {
        const result = await chrome.tabs.sendMessage(
          tab.id,
          { type: RELAY_TYPES[message.type], entry: message.entry, isProfile: message.isProfile },
          { frameId: 0 }
        );
        sendResponse({ ok: true, result });
      } catch (e) {
        sendResponse({ ok: false, error: "Couldn't reach the page. Try reloading the tab." });
      }
    })();
    return true; 
  }

  // --- Silently auto-update the form instead of popping up a notification ---
  if (message?.type === "FK_CONFIRM_SUBMIT") {
    (async () => {
      const hostEntries = await FormKeeperStorage.getHostEntries(message.host);
      const namedEntries = hostEntries
        .filter((e) => !e.auto && (e.formId ? e.formId === message.formId : e.signature === message.signature))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

      if (namedEntries[0]) {
        await FormKeeperStorage.saveEntry(message.host, {
          id: namedEntries[0].id, label: namedEntries[0].label, path: message.path,
          formId: message.formId, signature: message.signature, fields: message.fields, auto: false,
        });
      }
    })();
    return;
  }

  if (message?.type === "FK_STATUS_UPDATE" && sender.tab?.id != null && sender.frameId === 0) {
    const tabId = sender.tab.id;
    if (message.matchCount > 0) {
      chrome.action.setBadgeText({ tabId, text: message.matchCount > 9 ? "9+" : String(message.matchCount) });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#4fd1b0" });
      chrome.action.setBadgeTextColor?.({ tabId, color: "#0b1512" });
    } else if (message.hasTouchedData) {
      chrome.action.setBadgeText({ tabId, text: "\u2022" });
      chrome.action.setBadgeBackgroundColor({ tabId, color: "#8fa0a8" });
    } else {
      chrome.action.setBadgeText({ tabId, text: "" });
    }
  }

  if (message?.type === "FK_UPDATE_CONTEXT_MENU" && sender.tab?.active) {
    rebuildMenu(message.entries, message.profiles);
  }
});