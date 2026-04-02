// popup.js — DiveSSI Log Importer v0.0.7
// Import loop runs in background.js — this file only manages UI.

const DIVE_TYPE_LABELS = { 0:'SCUBA', 2:'XR', 4:'SCR', 6:'Freediving', 8:'CCR' };
const KEY_DIVES    = 'session_dives';
const KEY_IMPORTED = 'importedDives_v2';
const KEY_SETTINGS = 'session_settings';
const KEY_PROGRESS = 'session_progress';
const KEY_DELAY    = 'importDelay';

// ─── State ────────────────────────────────────────────────────────────────────

let dives        = [];
let importedSet  = new Set();
let selectedSite = null;
let selectedBuddyId  = '';
let selectedCenterId = '';
let currentFilter    = 'all';
let allChecked       = true;

// ─── Storage ──────────────────────────────────────────────────────────────────

function storageGet(key) {
  return new Promise(resolve => chrome.storage.local.get(key, d => resolve(d[key] ?? null)));
}
function storageSet(key, value) {
  return new Promise(resolve => chrome.storage.local.set({ [key]: value }, resolve));
}

function serialiseDives(arr) {
  return arr.map(d => ({ ...d, date: d.date instanceof Date ? d.date.toISOString() : d.date }));
}
function deserialiseDives(arr) {
  return (arr || []).map(d => ({ ...d, date: new Date(d.date) }));
}

async function saveSession() {
  await Promise.all([
    storageSet(KEY_DIVES,    serialiseDives(dives)),
    storageSet(KEY_SETTINGS, { selectedSite, selectedBuddyId, selectedCenterId }),
    storageSet(KEY_IMPORTED, [...importedSet]),
  ]);
}

async function loadSession() {
  const [divesRaw, settings, imported] = await Promise.all([
    storageGet(KEY_DIVES),
    storageGet(KEY_SETTINGS),
    storageGet(KEY_IMPORTED),
  ]);
  dives        = deserialiseDives(divesRaw);
  importedSet  = new Set(imported || []);
  selectedSite      = settings?.selectedSite      || null;
  selectedBuddyId   = settings?.selectedBuddyId   || '';
  selectedCenterId  = settings?.selectedCenterId  || '';
}

// ─── Dive key ─────────────────────────────────────────────────────────────────

function diveKey(dive) {
  const d = dive.date instanceof Date ? dive.date : new Date(dive.date);
  return `${d.toISOString().slice(0,16)}_${dive.diveNumber}`;
}
function markImported(dive) { importedSet.add(diveKey(dive)); }
function isImported(dive)   { return importedSet.has(diveKey(dive)); }

// ─── CSV parsing ──────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error('No data rows');
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  return lines.slice(1).filter(l => l.trim()).map(raw => {
    const values = [];
    let cur = '', inQ = false;
    for (const ch of raw) {
      if (ch === '"') { inQ = !inQ; }
      else if (ch === ',' && !inQ) { values.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    values.push(cur.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = values[i] || ''; });
    const date = parseDate(row['Date'] || row['Start Date']);
    if (!date) return null;
    const gfStr = row['VPM-B Conservatism'] || '';
    return {
      diveNumber:      row['Dive Number'] || '',
      date,
      maxDepth:        parseFloat(row['Max Depth (m)'] || row['Max Depth']) || 0,
      avgDepth:        parseFloat(row['Avg Depth (m)']) || '',
      duration:        parseInt(row['Duration (min)']) || Math.round((parseInt(row['Max Time'])||0)/60),
      diveSiteName:    row['Dive Site Name'] || '',
      location:        row['Location'] || '',
      buddy:           row['Buddy'] || '',
      diveTypeValue:   parseInt(row['Dive Type Value']) || 0,
      surfaceInterval: parseInt(row['Surface Interval (min)']) || 0,
      startCNS:        parseFloat(row['Start CNS %']) || 0,
      endCNS:          parseFloat(row['End CNS']) || 0,
      decoModel:       row['Deco Model'] || 'GF',
      gfLow:           parseInt(row['GF Minimum']) || extractGF(gfStr, 'low'),
      gfHigh:          parseInt(row['GF Maximum']) || extractGF(gfStr, 'high'),
      computer:        row['Computer Model'] || row['Product'] || 'Shearwater Perdix 2',
      entryType:       row['Entry Type'] || '',
      visibility:      row['Visibility (m)'] || '',
      weather:         row['Weather'] || '',
      surface:         row['Surface Conditions'] || '',
      airTemp:         row['Air Temp (°C)'] || '',
      waterTemp:       row['Water Temp Avg (°C)'] || row['Water Temp Surface (°C)'] || '',
      waterTempBottom: row['Water Temp Min (°C)'] || row['Water Temp Bottom (°C)'] || '',
      eanPercent:      row['EAN O2 %'] || '',
      pressureStart:   row['Pressure Start (bar)'] || '',
      pressureEnd:     row['Pressure End (bar)'] || '',
      tankVol:         row['Tank Vol (L)'] || row['Tank Size'] || '',
      tankConfig:      row['Tank Config'] || '',
      weight:          row['Weight (kg)'] || '',
      rating:          row['Rating (1-5)'] || '',
      current:         row['Current'] || '',
      notes:           row['Notes'] || row['Notes / Comment'] || '',
      gearNotes:       row['Gear Notes'] || '',
    };
  }).filter(Boolean);
}

function parseDate(str) {
  if (!str) return null;
  let m = str.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5]);
  m = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})/);
  if (m) {
    let h = +m[4];
    const ap = str.match(/(AM|PM)/i)?.[1];
    if (ap) { if (ap==='PM'&&h!==12) h+=12; if (ap==='AM'&&h===12) h=0; }
    return new Date(+m[3], +m[2]-1, +m[1], h, +m[5]);
  }
  return null;
}

function extractGF(str, part) {
  const m = str.match(/(\d+)\/(\d+)/);
  if (!m) return part==='low' ? 40 : 85;
  return part==='low' ? +m[1] : +m[2];
}

function buildDates(date) {
  const d = date instanceof Date ? date : new Date(date);
  return {
    day: d.getDate(), month: d.getMonth()+1, year: d.getFullYear(),
    time: `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`,
    display: `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`,
  };
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────

const dropZone    = document.getElementById('drop-zone');
const fileInput   = document.getElementById('file-input');
const stepLoad    = document.getElementById('step-load');
const stepConfig  = document.getElementById('step-configure');
const diveScroll  = document.getElementById('dive-scroll');
const diveCount   = document.getElementById('dive-count');
const btnImport   = document.getElementById('btn-import');
const btnReset    = document.getElementById('btn-reset');
const progressBar = document.getElementById('progress-bar');
const progressFill= document.getElementById('progress-fill');
const statusBar   = document.getElementById('status-bar');
const errorBar    = document.getElementById('error-bar');
const delayInput  = document.getElementById('delay-input');

function setStatus(msg, type='') {
  statusBar.textContent = msg;
  statusBar.className = 'status-bar' + (type ? ' '+type : '');
}

function setError(msg) {
  errorBar.textContent = msg ? '⚠ ' + msg : '';
  errorBar.style.display = msg ? 'block' : 'none';
}

function setDiveStatus(idx, type, icon) {
  const el = document.getElementById(`status-${idx}`);
  if (el) { el.className = `dive-status status-${type}`; el.textContent = icon; }
  document.getElementById(`dive-${idx}`)?.scrollIntoView({ block:'nearest' });
}

// ─── Tabs UI ──────────────────────────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    if (tab.dataset.tab === 'settings') refreshSettings();
  });
});

function refreshSettings() {
  document.getElementById('history-count').textContent =
    `${importedSet.size} dive${importedSet.size!==1?'s':''} recorded as imported`;
}

document.getElementById('btn-clear-history').addEventListener('click', async () => {
  if (!confirm('Clear all import history?')) return;
  importedSet.clear();
  await storageSet(KEY_IMPORTED, []);
  refreshSettings();
  renderDiveList();
  setStatus('History cleared');
});

storageGet(KEY_DELAY).then(v => { if (v) delayInput.value = v; });
delayInput.addEventListener('change', () => storageSet(KEY_DELAY, +delayInput.value));

// ─── Filters & toggle all ─────────────────────────────────────────────────────

document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.filter;
    renderDiveList();
  });
});

document.getElementById('btn-toggle-all').addEventListener('click', () => {
  allChecked = !allChecked;
  document.getElementById('btn-toggle-all').textContent = allChecked ? 'Untick All' : 'Tick All';
  document.querySelectorAll('.dive-check').forEach(chk => { chk.checked = allChecked; });
});

// ─── File handling ────────────────────────────────────────────────────────────

dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', e => loadFile(e.target.files[0]));
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('drag-over');
  loadFile(e.dataTransfer.files[0]);
});

async function loadFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.csv')) { setError('Please select a .csv file'); return; }
  setStatus('Loading…'); setError('');
  try {
    dives = parseCSV(await file.text());
    if (!dives.length) throw new Error('No valid dives found');
    await saveSession();
    showConfigStep();
    setStatus(`${dives.length} dives loaded · ${importedSet.size} already imported`);
    // Ask background to open /add tab, then load buddies/centers
    chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_ADD' }, async res => {
      if (res?.tabId) {
        await sleep(1800);
        autoLoadBuddiesAndCenters(res.tabId);
      }
    });
  } catch(err) {
    setError(err.message);
  }
}

function showConfigStep() {
  stepLoad.style.display = 'none';
  stepConfig.style.display = 'block';
  renderDiveList();
  // Restore site pill
  if (selectedSite) {
    document.getElementById('selected-site-name').textContent = selectedSite.name;
    document.getElementById('selected-site').style.display = 'block';
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Buddy & center auto-load ─────────────────────────────────────────────────

async function autoLoadBuddiesAndCenters(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_BUDDIES' });
    const buddies = res?.buddies || [];
    if (buddies.length) {
      const sel = document.getElementById('buddy-select');
      sel.innerHTML = '<option value="">— Select buddy —</option>';
      buddies.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.id; opt.textContent = b.name;
        if (b.id === selectedBuddyId) opt.selected = true;
        sel.appendChild(opt);
      });
      document.getElementById('btn-load-buddies').textContent = `✓ ${buddies.length} loaded`;
    }
  } catch(e) {}

  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_TRAINING_CENTERS' });
    const centers = res?.centers || [];
    if (centers.length) {
      const sel = document.getElementById('center-select');
      sel.innerHTML = '<option value="">— Select center —</option>';
      centers.forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id; opt.textContent = c.name;
        if (c.id === selectedCenterId) opt.selected = true;
        sel.appendChild(opt);
      });
      document.getElementById('btn-load-centers').textContent = `✓ ${centers.length} loaded`;
    }
  } catch(e) {}
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderDiveList() {
  diveScroll.innerHTML = '';
  let visible = 0;
  dives.forEach((dive, idx) => {
    const imported = isImported(dive);
    if (currentFilter === 'pending'  && imported)  return;
    if (currentFilter === 'imported' && !imported) return;
    visible++;
    const d = buildDates(dive.date);
    const typeLabel = DIVE_TYPE_LABELS[dive.diveTypeValue] || 'SCUBA';
    const item = document.createElement('div');
    item.className = `dive-item${imported ? ' imported' : ''}`;
    item.id = `dive-${idx}`;
    item.innerHTML = `
      <input type="checkbox" class="dive-check" id="chk-${idx}" ${!imported?'checked':''} data-idx="${idx}"/>
      <span class="dive-num">#${dive.diveNumber}</span>
      <span class="dive-info">
        ${d.display} · ${dive.maxDepth}m · ${dive.duration}min · <em style="color:#8899bb">${typeLabel}</em>
        <br><small>${dive.diveSiteName||dive.location||'—'}${dive.buddy?' · 👤 '+dive.buddy:''}</small>
      </span>
      <span class="dive-status ${imported?'status-imported':'status-pending'}" id="status-${idx}">${imported?'✓':'○'}</span>
    `;
    diveScroll.appendChild(item);
  });
  diveCount.textContent = `${visible} shown`;
}

// ─── Reset ────────────────────────────────────────────────────────────────────

btnReset.addEventListener('click', async () => {
  if (!confirm('Load a different file? This will clear your current session.')) return;
  dives = []; selectedSite = null; selectedBuddyId = ''; selectedCenterId = ''; allChecked = true;
  await Promise.all([storageSet(KEY_DIVES,[]), storageSet(KEY_SETTINGS,{}), storageSet(KEY_PROGRESS,null)]);
  stepLoad.style.display = 'block'; stepConfig.style.display = 'none';
  progressBar.style.display = 'none'; fileInput.value = '';
  document.getElementById('selected-site').style.display = 'none';
  document.getElementById('btn-toggle-all').textContent = 'Untick All';
  setStatus(''); setError('');
  btnImport.textContent = 'Import Selected'; btnImport.disabled = false;
});

// ─── Site search ──────────────────────────────────────────────────────────────

document.getElementById('btn-site-search').addEventListener('click', runSiteSearch);
document.getElementById('site-search').addEventListener('keydown', e => { if (e.key==='Enter') runSiteSearch(); });
document.getElementById('clear-site').addEventListener('click', async () => {
  selectedSite = null;
  document.getElementById('selected-site').style.display = 'none';
  await saveSession();
});

async function getOrOpenAddTab() {
  // Ask background to ensure /add tab exists and return its ID
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'NAVIGATE_TO_ADD' }, res => resolve(res?.tabId));
  });
}

async function sendToAddTab(message) {
  const tabId = await getOrOpenAddTab();
  if (!tabId) throw new Error('Could not open DiveSSI tab');
  return chrome.tabs.sendMessage(tabId, message);
}

async function runSiteSearch() {
  const q = document.getElementById('site-search').value.trim();
  if (!q) return;
  const btn = document.getElementById('btn-site-search');
  const resultsEl = document.getElementById('site-results');
  const debugEl   = document.getElementById('site-debug');
  btn.textContent = '…'; btn.disabled = true;
  resultsEl.style.display = 'none'; resultsEl.innerHTML = '';
  debugEl.style.display = 'none'; setError('');

  // [FIX #2] Use Location field as geo centre if available
  // Find the first dive whose site name matches or just take the first dive's location
  const locationHint = dives.find(d => d.diveSiteName && q.toLowerCase().includes(d.diveSiteName.toLowerCase()))?.location
    || dives[0]?.location || '';

  try {
    const response = await sendToAddTab({ type: 'SEARCH_SITES', query: q, locationHint });
    if (!response?.ok) {
      setError(`Site search: ${response?.error || 'no response'}`);
      return;
    }
    const data = response.data;
    let sites = [];
    if (data?.markers) {
      sites = data.markers.map(m => ({ id: m.f, name: m.n?.trim(), lat: m.la, lng: m.lo, bow: 'salt' }));
    } else if (Array.isArray(data)) {
      sites = data.map(s => ({ id: s.f||s.id, name: (s.n||s.name)?.trim(), bow: 'salt' }));
    }
    sites = sites.filter(s => s.id && s.name);

    if (!sites.length) {
      resultsEl.innerHTML = '<div style="padding:8px 10px;font-size:11px;color:#8899bb">No sites found</div>';
      debugEl.textContent = `Raw: ${response.raw}`; debugEl.style.display = 'block';
    } else {
      sites.slice(0,15).forEach(site => {
        const item = document.createElement('div');
        item.className = 'result-item';
        item.innerHTML = `<span>${site.name}</span><span class="rid">#${site.id}</span>`;
        item.addEventListener('click', async () => {
          selectedSite = site;
          document.getElementById('selected-site-name').textContent = site.name;
          document.getElementById('selected-site').style.display = 'block';
          resultsEl.style.display = 'none';
          await saveSession();
        });
        resultsEl.appendChild(item);
      });
    }
    resultsEl.style.display = 'block';
  } catch(err) { setError('Site search error: ' + err.message); }

  btn.textContent = 'Search'; btn.disabled = false;
}

// ─── Buddies & centers (manual load) ─────────────────────────────────────────

document.getElementById('btn-load-buddies').addEventListener('click', async () => {
  const btn = document.getElementById('btn-load-buddies');
  btn.textContent = '…'; btn.disabled = true;
  setError('');
  try {
    const tabId = await getOrOpenAddTab();
    if (tabId) await autoLoadBuddiesAndCenters(tabId);
  } catch(e) { setError('Could not load buddies: ' + e.message); }
  btn.disabled = false;
});

document.getElementById('buddy-select').addEventListener('change', async e => {
  selectedBuddyId = e.target.value;
  await saveSession();
});

document.getElementById('btn-load-centers').addEventListener('click', async () => {
  const btn = document.getElementById('btn-load-centers');
  btn.textContent = '…'; btn.disabled = true;
  setError('');
  try {
    const tabId = await getOrOpenAddTab();
    if (tabId) await autoLoadBuddiesAndCenters(tabId);
  } catch(e) { setError('Could not load centers: ' + e.message); }
  btn.disabled = false;
});

document.getElementById('center-select').addEventListener('change', async e => {
  selectedCenterId = e.target.value;
  await saveSession();
});

// ─── Scan Log ─────────────────────────────────────────────────────────────────

document.getElementById('btn-scan-log').addEventListener('click', scanExistingLog);

async function scanExistingLog() {
  const btn = document.getElementById('btn-scan-log');
  btn.textContent = '⏳'; btn.disabled = true;
  setStatus('Navigating to dive log…'); setError('');

  try {
    // Use background to navigate (survives popup focus change)
    const { tabId } = await new Promise(resolve =>
      chrome.runtime.sendMessage({ type: 'NAVIGATE_AND_LOAD', url: 'https://my.divessi.com/mydivelog', extraWait: 2500 }, resolve)
    );
    if (!tabId) { setError('Could not open DiveSSI tab'); return; }

    setStatus('Scanning log…');
    const res = await chrome.tabs.sendMessage(tabId, { type: 'SCRAPE_DIVE_LOG' });
    const existing = res?.dives || [];

    if (!existing.length) {
      setError('Could not read log entries — DiveSSI may use a different layout');
      // Still navigate back
      chrome.runtime.sendMessage({ type: 'NAVIGATE_AND_LOAD', url: 'https://my.divessi.com/mydivelog/add', extraWait: 1500 }, () => {});
      return;
    }

    // dateStr format from data-order: "2024-10-13 09:46" — ISO-like, easy to parse
    const existingDates = new Set();
    existing.forEach(e => {
      const s = (e.dateStr || '').trim();
      if (!s) return;
      // "YYYY-MM-DD HH:MM" or "YYYY-MM-DD"
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) {
        existingDates.add(`${iso[1]}-${iso[2]}-${iso[3]}`);
      }
    });

    let matched = 0;
    dives.forEach((dive, idx) => {
      const d = dive.date instanceof Date ? dive.date : new Date(dive.date);
      if (isNaN(d)) return;
      const key = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
      if (existingDates.has(key)) {
        markImported(dive); matched++;
        const chk = document.getElementById(`chk-${idx}`);
        if (chk) chk.checked = false;
        document.getElementById(`dive-${idx}`)?.classList.add('imported');
        setDiveStatus(idx, 'imported', '✓');
      }
    });

    await storageSet(KEY_IMPORTED, [...importedSet]);
    renderDiveList();
    setStatus(matched > 0
      ? `✅ ${matched} dives matched and unticked (${existingDates.size} dates in log)`
      : `No matches — ${existingDates.size} dates found in log`,
      matched > 0 ? 'success' : 'warning');

    // Navigate back to /add
    chrome.runtime.sendMessage({ type: 'NAVIGATE_AND_LOAD', url: 'https://my.divessi.com/mydivelog/add', extraWait: 1500 }, res2 => {
      if (res2?.tabId) autoLoadBuddiesAndCenters(res2.tabId);
    });

  } catch(err) {
    setError('Scan error: ' + err.message);
    console.error(err);
  }

  btn.textContent = '🔍 Scan Log'; btn.disabled = false;
}

// ─── Import — kicks off background loop ───────────────────────────────────────

btnImport.addEventListener('click', startImport);

async function startImport() {
  const progress = await storageGet(KEY_PROGRESS);
  if (progress?.running) { setStatus('Import already running in background'); return; }

  const toImportIdxs = [];
  document.querySelectorAll('.dive-check').forEach(chk => {
    if (chk.checked) toImportIdxs.push(+chk.dataset.idx);
  });
  if (!toImportIdxs.length) { setStatus('No dives selected', 'warning'); return; }

  await saveSession();

  setStatus(`Starting import of ${toImportIdxs.length} dives…`);
  btnImport.disabled = true;
  btnImport.textContent = 'Importing…';
  progressBar.style.display = 'block';

  // Hand off to background worker
  chrome.runtime.sendMessage({ type: 'START_IMPORT', toImportIdxs });
}

// ─── Listen to progress events from background ────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'IMPORT_PROGRESS') return;

  switch (message.event) {
    case 'DIVE_START':
      setDiveStatus(message.idx, 'running', '⟳');
      setStatus(`Dive ${message.i+1}/${message.total} — select site then click Continue`);
      progressFill.style.width = `${Math.round((message.i/message.total)*100)}%`;
      break;

    case 'DIVE_DONE':
      setDiveStatus(message.idx, 'done', '✓');
      document.getElementById(`dive-${message.idx}`)?.classList.add('imported');
      // Refresh importedSet from storage to stay in sync
      storageGet(KEY_IMPORTED).then(imp => {
        importedSet = new Set(imp || []);
        refreshSettings();
      });
      break;

    case 'DIVE_ERROR':
      setDiveStatus(message.idx, 'error', '✗');
      console.error('Dive error:', message.detail);
      break;

    case 'WAITING':
      setStatus(`Dive ${message.i+1} done — next in ${message.delay}ms…`);
      break;

    case 'IMPORT_COMPLETE':
      btnImport.disabled = false;
      btnImport.textContent = 'Import Selected';
      progressFill.style.width = '100%';
      setStatus(
        message.errors === 0
          ? `✅ All ${message.done} dives imported!`
          : `Done: ${message.done} imported, ${message.errors} failed`,
        message.errors === 0 ? 'success' : 'warning'
      );
      storageGet(KEY_IMPORTED).then(imp => { importedSet = new Set(imp||[]); refreshSettings(); });
      break;
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  await loadSession();
  refreshSettings();
  const v = await storageGet(KEY_DELAY);
  if (v) delayInput.value = v;

  if (dives.length > 0) {
    showConfigStep();
    setStatus(`Session restored · ${dives.length} dives · ${importedSet.size} imported`);

    // Re-load buddies/centers if /add tab is already open
    const tabs = await chrome.tabs.query({ url: 'https://my.divessi.com/mydivelog/add*' });
    if (tabs.length) {
      await sleep(500);
      autoLoadBuddiesAndCenters(tabs[0].id);
    }

    // Reconnect to any in-progress import
    const progress = await storageGet(KEY_PROGRESS);
    if (progress?.running) {
      setStatus(`Import running — dive ${progress.currentI+1}/${progress.total}`);
      btnImport.disabled = true;
      btnImport.textContent = 'Importing…';
      progressBar.style.display = 'block';
      progressFill.style.width = `${Math.round((progress.currentI/progress.total)*100)}%`;
    }
  }
}

init();
