(async function () {
  try {
    const settings = await FormKeeperStorage.getSettings();
    document.documentElement.setAttribute("data-theme", settings.theme || "dark");
  } catch (e) {
    console.warn("Failed to load Form Keeper theme on guide page:", e);
  }
})();