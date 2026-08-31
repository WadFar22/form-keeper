/**
 * Form Keeper — storage layer
 *
 * Everything lives in chrome.storage.local. Nothing in this file ever
 * makes a network request. This is the single source of truth for the
 * on-disk schema so every surface (content script, popup, options page,
 * background worker) reads and writes data the same way.
 */

const FK_SETTINGS_KEY = "fk_settings";
const FK_DATA_KEY = "fk_data";
const FK_SITES_KEY = "fk_sites";

const FK_DEFAULT_SETTINGS = {
  autoDetect: true,
  autoPrompt: true,
  includeSensitive: true,
  mergeFill: false,
  retentionDays: 0,
};

function fkUUID() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}

async function fkStorageGet(keys) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.get(keys, (result) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(result);
      });
    } catch (e) {
      reject(e);
    }
  });
}

async function fkStorageSet(obj) {
  return new Promise((resolve, reject) => {
    try {
      chrome.storage.local.set(obj, () => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve();
      });
    } catch (e) {
      reject(e);
    }
  });
}

const FormKeeperStorage = {
  async getSettings() {
    const res = await fkStorageGet(FK_SETTINGS_KEY);
    return { ...FK_DEFAULT_SETTINGS, ...(res[FK_SETTINGS_KEY] || {}) };
  },

  async saveSettings(patch) {
    const current = await this.getSettings();
    const next = { ...current, ...patch };
    await fkStorageSet({ [FK_SETTINGS_KEY]: next });
    return next;
  },

  async getAllData() {
    const res = await fkStorageGet(FK_DATA_KEY);
    return res[FK_DATA_KEY] || {};
  },

  async getHostEntries(host) {
    const data = await this.getAllData();
    return data[host] || [];
  },

  async getSiteEnabled(host) {
    const res = await fkStorageGet(FK_SITES_KEY);
    const sites = res[FK_SITES_KEY] || {};
    return !!(sites[host] && sites[host].enabled);
  },

  async setSiteEnabled(host, enabled) {
    const res = await fkStorageGet(FK_SITES_KEY);
    const sites = res[FK_SITES_KEY] || {};
    sites[host] = { ...(sites[host] || {}), enabled: !!enabled };
    await fkStorageSet({ [FK_SITES_KEY]: sites });
    return sites[host];
  },

  async saveEntry(host, entry) {
    const data = await this.getAllData();
    const list = data[host] || [];
    const now = Date.now();

    if (host === "__PROFILES__") {
      entry.isProfile = true;
    }

    if (entry.id) {
      const idx = list.findIndex((e) => e.id === entry.id);
      if (idx !== -1) {
        list[idx] = { ...list[idx], ...entry, updatedAt: now };
      } else {
        list.push({ ...entry, updatedAt: now });
      }
    } else {
      list.push({
        ...entry,
        id: fkUUID(),
        savedAt: now,
        updatedAt: now,
      });
    }

    data[host] = list;
    await fkStorageSet({ [FK_DATA_KEY]: data });
    return data[host];
  },

  async deleteEntry(host, id) {
    const data = await this.getAllData();
    data[host] = (data[host] || []).filter((e) => e.id !== id);
    if (data[host].length === 0) delete data[host];
    await fkStorageSet({ [FK_DATA_KEY]: data });
  },

  async clearHost(host) {
    const data = await this.getAllData();
    delete data[host];
    await fkStorageSet({ [FK_DATA_KEY]: data });
  },

  async clearAll() {
    await fkStorageSet({ [FK_DATA_KEY]: {} });
  },

  async exportAll() {
    const settings = await this.getSettings();
    const data = await this.getAllData();
    return {
      exportedAt: new Date().toISOString(),
      app: "form-keeper",
      version: 1,
      settings,
      data,
    };
  },

  async importAll(payload, merge = true) {
    if (!payload || typeof payload !== "object") throw new Error("Invalid import file.");
    const incomingData = payload.data || payload.fk_data || {};
    const incomingSettings = payload.settings || payload.fk_settings || {};

    if (merge) {
      const current = await this.getAllData();
      for (const host of Object.keys(incomingData)) {
        const existing = current[host] || [];
        const existingIds = new Set(existing.map((e) => e.id));
        const merged = existing.slice();
        for (const entry of incomingData[host]) {
          if (host === "__PROFILES__") entry.isProfile = true;
          if (existingIds.has(entry.id)) {
            const idx = merged.findIndex((e) => e.id === entry.id);
            merged[idx] = { ...merged[idx], ...entry };
          } else {
            merged.push(entry);
          }
        }
        current[host] = merged;
      }
      await fkStorageSet({ [FK_DATA_KEY]: current });
    } else {
      await fkStorageSet({ [FK_DATA_KEY]: incomingData });
    }

    if (Object.keys(incomingSettings).length) {
      await this.saveSettings(incomingSettings);
    }
  },

  /** Retention cleanup: Purges old site entries while permanently shielding Global Profiles */
  async applyRetention() {
    const settings = await this.getSettings();
    if (!settings.retentionDays || settings.retentionDays <= 0) return;
    const cutoff = Date.now() - settings.retentionDays * 24 * 60 * 60 * 1000;
    const data = await this.getAllData();
    let changed = false;
    for (const host of Object.keys(data)) {
      if (host === "__PROFILES__") continue; // Global Profiles are immune to auto-deletion
      const filtered = data[host].filter((e) => (e.updatedAt || e.savedAt) >= cutoff);
      if (filtered.length !== data[host].length) changed = true;
      if (filtered.length === 0) delete data[host];
      else data[host] = filtered;
    }
    if (changed) await fkStorageSet({ [FK_DATA_KEY]: data });
  },
};

(typeof self !== "undefined" ? self : globalThis).FormKeeperStorage = FormKeeperStorage;