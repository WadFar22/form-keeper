# Form Keeper

<div align="center">

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/hcjdhmkgcokfjkikoehgcfebfcedjldh?label=Chrome%20Web%20Store&logo=googlechrome&logoColor=white&color=4285F4)](https://chromewebstore.google.com/detail/form-keeper-%E2%80%94-local-form/hcjdhmkgcokfjkikoehgcfebfcedjldh)
[![Edge Add-ons](https://img.shields.io/badge/Edge%20Add--ons-Available-0078D7?logo=microsoftedge&logoColor=white)](https://microsoftedge.microsoft.com/addons/detail/form-keeper-%E2%80%94-local-form-/lllebjkfiigggcoffmkpamfkcnkdgaag)

</div>
**[Install from Chrome Web Store](https://chromewebstore.google.com/detail/form-keeper-%E2%80%94-local-form/hcjdhmkgcokfjkikoehgcfebfcedjldh)**  
**[Install from Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/form-keeper-%E2%80%94-local-form-/lllebjkfiigggcoffmkpamfkcnkdgaag)**

A small, clean browser extension that remembers what you typed into a form so
you never have to retype it — whether a submission failed, you're filling the
same form again, or you're testing the same inputs repeatedly.

**Everything is stored locally with `chrome.storage.local`.** There is no 
server, no account, no analytics, and no network request anywhere in this 
codebase — you can verify that yourself; search the code for `fetch(` or 
`XMLHttpRequest` and you'll find nothing.

## Install it (Chrome or Edge — both are Chromium, so the steps are identical)

1. Unzip this folder somewhere permanent (don't delete it after installing — 
   the browser loads the extension from these files).
2. Go to `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the extension folder.
5. Pin it from the puzzle-piece icon in your toolbar for quick access.

## Two Ways to Save

* **Global Profiles (Universal):** Saved across all websites. Ideal for your 
  universal personal details (like Name, Phone, Email, Address). Form Keeper 
  automatically maps these fields onto almost any form you encounter anywhere 
  on the web.
* **Saved Forms (Site-Specific):** Saved strictly for one specific website. 
  Perfect for recurring forms, tax portals, or complex dashboards, remembering 
  the exact structure of that webpage (even distinguishing language versions 
  like `/en` or `/ar`).

## How it works

* **While you type**, nothing appears on the page. Form Keeper quietly keeps 
  a rolling backup of what you've typed, purely as a safety net.
* **Right-Click Shortcuts:** You can fill forms directly without opening the 
  popup. Right-click anywhere on a webpage to populate the whole page using 
  *Fill from Saved Profile* or *Fill from Saved Forms*. Right-click directly 
  inside a specific input box to inject a single, specific piece of data.
* **Click the toolbar icon** any time to see what's relevant on the current 
  page: if it recognizes a saved form here, it slides down a preview of each 
  saved version with a one-click **Fill** button; if you've typed something 
  new that isn't saved yet, it offers a **Save as new entry** button instead.
* A small badge on the toolbar icon tells you at a glance whether there's 
  something to fill (teal, with a count) or something new to save (grey dot) 
  on the current page — so you only need to click in when there's a reason 
  to. Turn this off in Settings if you'd rather the icon stay silent.
* **On submit**, it also quietly keeps a backup copy of what you typed, so if 
  the submission fails, your data isn't gone — open the popup and hit Fill.
* The popup's **This site / Profiles / All sites** tabs list everything saved, 
  with Fill / Rename / Delete on each, plus a persistent **+ Save current form** button 
  (only enabled once you've actually typed something).
* The **Settings** page (right-click the icon → Options, or the gear in the 
  popup) lets you turn detection off entirely, toggle the toolbar badge, 
  export/import your data via **JSON** or human-readable **CSV** files, or 
  wipe everything.

## What it will never save

* **Password fields** (`type="password"`) — hard-coded, no setting can override 
  this.
* **Captcha tokens** (reCAPTCHA, hCaptcha, Turnstile, etc.) and CSRF/anti-forgery 
  tokens — these are single-use or regenerate on every load, so saving them 
  is pointless; excluded unconditionally, same as passwords.
* **Sensitive-looking fields** (credit-card numbers, CVV/CVC codes, SSNs, or 
  passport numbers) — **skipped by default**; there is an explicit opt-in 
  toggle in Settings if you want to include them.
* **Hidden fields** (`display:none`, zero size, etc.) — this also quietly 
  catches most captcha widgets' underlying inputs.

## Saving the same form multiple times, with different data

If you fill out the same form repeatedly with different details (e.g. one 
registration per person), each time you press **+ Save current form as new entry**
in the popup, it creates a separate, new saved entry rather than 
overwriting the last one. Open the popup on that page later and it shows 
every saved version with a live preview of its field values, so you can pick 
the right one instead of guessing from a label alone.

Only fields you've actually typed into count toward "there's something to 
save" — a form's default dropdown value, or values left over from before a 
page refresh, are ignored, so the Save button stays disabled until there's 
genuinely new data.

Separately, there's always one silent, auto-updating "backup" entry per form 
that never needs your approval — it exists purely so a failed submission 
doesn't cost you your data, and it won't clutter your named saves.

## Multi-step forms

Forms that reveal or hide fields as you move between steps are matched by a 
stable form identity (its `id`/`name`, or position on the page) rather than 
by the exact set of fields visible at any one moment. Data captured on earlier 
steps is preserved and merged with later steps rather than being overwritten — 
so a field that's temporarily off-screen won't get wiped by a step that 
doesn't include it.

## Project structure

* `manifest.json` — Manifest V3 config (minimal permissions)
* `src/storage-lib.js` — Shared local-storage schema/helpers
* `src/content.js` — Runs on pages: detects forms, save/restore prompts
* `src/background.js` — Service worker: light housekeeping + message relay
* `popup/` — Toolbar popup UI (per-site and all-sites views)
* `options/` — Settings + full data browser/export/import
* `icons/` — Extension icons

## Permissions, and why each one is needed

* `storage` — to save your data locally.
* `contextMenus` — to power the right-click shortcuts for instantly filling 
  forms and fields.
* `activeTab` / `scripting` — to talk to the page you're currently on when 
  you click "Fill" from the popup.
* `host_permissions: <all_urls>` — the content script needs to run on pages 
  to notice forms and offer to save/restore them. It does nothing until a 
  form is filled in or you ask it to.

No `alarms`, no `identity`, no remote code, no third-party libraries.