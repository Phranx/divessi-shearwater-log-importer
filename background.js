// background.js — DiveSSI Log Importer v0.0.8
// The import loop runs HERE so it survives the popup closing/reopening.

const KEY_DIVES    = 'session_dives';
const KEY_IMPORTED = 'importedDives_v2';
const KEY_PROGRESS = 'session_progress';
const KEY_DELAY    = 'importDelay';
const KEY_SETTINGS = 'session_settings';

// ─── Storage helpers ──────────────────────────────────────────────────────────

function storageGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, d => resolve(d[key] ?? null));
  });
}

function storageSet(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Notify popup of progress (if it's open) ─────────────────────────────────

function notifyPopup(msg) {
  chrome.runtime.sendMessage({ type: 'IMPORT_PROGRESS', ...msg }).catch(() => {
    // Popup is closed — that's fine, progress is saved to storage
  });
}

// ─── Navigate a tab to /add and wait until it's actually there ────────────────

function navigateAndWaitForAdd(tabId) {
  return new Promise(async (resolve) => {
    await chrome.tabs.update(tabId, { url: 'https://my.divessi.com/mydivelog/add' });

    const timeout = setTimeout(resolve, 20000);

    const fn = (id, info, tab) => {
      if (id !== tabId) return;
      if (info.status === 'complete' && tab.url?.includes('/mydivelog/add')) {
        chrome.tabs.onUpdated.removeListener(fn);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(fn);
  });
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    const timeout = setTimeout(resolve, 15000);
    const fn = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(fn);
        clearTimeout(timeout);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(fn);
  });
}

async function ensureAddDiveTab() {
  const existing = await chrome.tabs.query({ url: 'https://my.divessi.com/mydivelog/add*' });
  if (existing.length) return existing[0].id;
  const ssiTabs = await chrome.tabs.query({ url: 'https://my.divessi.com/*' });
  if (ssiTabs.length) {
    await navigateAndWaitForAdd(ssiTabs[0].id);
    return ssiTabs[0].id;
  }
  const tab = await chrome.tabs.create({ url: 'https://my.divessi.com/mydivelog/add', active: false });
  await waitForTabLoad(tab.id);
  return tab.id;
}

function buildDates(dateVal) {
  const d = dateVal instanceof Date ? dateVal : new Date(dateVal);
  return {
    day:     d.getDate(),
    month:   d.getMonth() + 1,
    year:    d.getFullYear(),
    time:    `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
    display: `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`,
  };
}

// ─── Main import loop (runs in background, survives popup close) ──────────────

let loopRunning = false;

async function runImportLoop(toImportIdxs, startFrom = 0) {
  if (loopRunning) return;
  loopRunning = true;

  const divesRaw  = await storageGet(KEY_DIVES)    || [];
  const imported  = await storageGet(KEY_IMPORTED)  || [];
  const settings  = await storageGet(KEY_SETTINGS)  || {};
  const delay     = (await storageGet(KEY_DELAY))    || 2000;

  const importedSet = new Set(imported);
  const dives = divesRaw.map(d => ({ ...d, date: new Date(d.date) }));

  let done = 0, errors = 0;

  const tabId = await ensureAddDiveTab();

  for (let i = startFrom; i < toImportIdxs.length; i++) {
    const idx  = toImportIdxs[i];
    const dive = dives[idx];
    if (!dive) continue;

    // Save progress so popup can show it on open
    await storageSet(KEY_PROGRESS, {
      toImportIdxs, currentI: i, done, errors,
      running: true, tabId,
      total: toImportIdxs.length,
    });

    notifyPopup({ event: 'DIVE_START', idx, i, total: toImportIdxs.length });

    try {
      await navigateAndWaitForAdd(tabId);
      await sleep(1800);

      const diveData = {
        ...dive,
        date: dive.date instanceof Date ? dive.date.toISOString() : dive.date,
        buddyId:          settings.selectedBuddyId   || '',
        trainingCenterId: settings.selectedCenterId  || '',
        diveSiteId:       settings.selectedSite?.id   || dive.diveSiteId   || '',
        diveSiteName:     settings.selectedSite?.name || dive.diveSiteName || '',
        diveSiteBow:      settings.selectedSite?.bow  || dive.diveSiteBow  || 'salt',
      };

      const result = await chrome.tabs.sendMessage(tabId, {
        type:  'FILL_AND_SUBMIT',
        dive:  diveData,
        dates: buildDates(dive.date),
      });

      if (result?.success) {
        // Record as imported
        const dKey = `${new Date(dive.date).toISOString().slice(0,16)}_${dive.diveNumber}`;
        importedSet.add(dKey);
        await storageSet(KEY_IMPORTED, [...importedSet]);
        done++;
        notifyPopup({ event: 'DIVE_DONE', idx, done, errors });
      } else {
        errors++;
        notifyPopup({ event: 'DIVE_ERROR', idx, done, errors, detail: result });
        console.error('Import failed:', result);
      }

    } catch (err) {
      errors++;
      notifyPopup({ event: 'DIVE_ERROR', idx, done, errors, detail: err.message });
      console.error('Import error:', err);
    }

    if (i < toImportIdxs.length - 1) {
      notifyPopup({ event: 'WAITING', i, delay });
      await sleep(delay);
    }
  }

  loopRunning = false;
  await storageSet(KEY_PROGRESS, null);
  notifyPopup({ event: 'IMPORT_COMPLETE', done, errors, total: toImportIdxs.length });
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'START_IMPORT') {
    runImportLoop(message.toImportIdxs, message.startFrom || 0);
    sendResponse({ started: true });
    return true;
  }

  if (message.type === 'GET_STATUS') {
    storageGet(KEY_PROGRESS).then(p => sendResponse({ progress: p, running: loopRunning }));
    return true;
  }

  if (message.type === 'NAVIGATE_TO_ADD') {
    ensureAddDiveTab().then(tabId => sendResponse({ tabId }));
    return true;
  }

  if (message.type === 'NAVIGATE_AND_LOAD') {
    // Navigate tab to a URL and wait for load — used by popup for scan log etc.
    const doIt = async () => {
      const tabs = await chrome.tabs.query({ url: 'https://my.divessi.com/*' });
      let tabId;
      if (tabs.length) {
        tabId = tabs[0].id;
        await chrome.tabs.update(tabId, { url: message.url });
        await waitForTabLoad(tabId);
      } else {
        const t = await chrome.tabs.create({ url: message.url, active: false });
        tabId = t.id;
        await waitForTabLoad(tabId);
      }
      await sleep(message.extraWait || 1000);
      sendResponse({ tabId });
    };
    doIt();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  console.log('DiveSSI Log Importer v0.0.8 installed');
});
