// content.js — DiveSSI Log Importer v2
// Runs on all my.divessi.com pages.

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setNativeValue(el, value) {
  if (!el) return false;
  const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

function field(name) { return document.querySelector(`[name="${name}"]`); }
function setField(name, value) { const el = field(name); return el ? setNativeValue(el, value) : false; }
function setHidden(name, value) { const el = field(name); if (!el) return false; el.value = value; return true; }

function setSelect(name, value) {
  const el = field(name);
  if (!el) return false;
  for (const opt of el.options) {
    if (opt.value === String(value) || opt.text.trim() === String(value)) return setNativeValue(el, opt.value);
  }
  for (const opt of el.options) {
    if (opt.text.toLowerCase().includes(String(value).toLowerCase())) return setNativeValue(el, opt.value);
  }
  return false;
}

function isVisible(el) {
  if (!el) return false;
  const s = window.getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden') return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Dive site search ─────────────────────────────────────────────────────────

async function searchDiveSites(query) {
  const params = new URLSearchParams({
    'filter[country]': '', 'filter[site]': query, 'filter[area]': '',
    minlat: -89, minlng: -179.9999, maxlat: 89, maxlng: 179.9999,
    latitude: 0, longitude: 0,
  });
  const res = await fetch(`/code/geo/dive_site.json.sd.php?${params}`, { credentials: 'include' });
  if (!res.ok) throw new Error(`${res.status}`);
  const raw = await res.json();
  let sites = [];
  // API format: { markers: [ { f: "126955", n: "Site Name", la, lo } ] }
  if (raw && Array.isArray(raw.markers)) {
    sites = raw.markers.map(m => ({ id: m.f, name: m.n?.trim(), lat: m.la, lng: m.lo, bow: 'salt' }));
  } else if (Array.isArray(raw)) {
    sites = raw.map(s => ({ id: s.f || s.id || s.ds_id, name: (s.n || s.name || s.ds_name)?.trim(), bow: 'salt' }));
  } else if (raw && Array.isArray(raw.features)) {
    sites = raw.features.map(f => ({ id: f.properties?.f || f.properties?.id, name: (f.properties?.n || f.properties?.name)?.trim(), bow: 'salt' }));
  }
  return sites.filter(s => s.id && s.name);
}

async function selectSite(siteId, siteName, bow = 'salt') {
  // Step 1: set the hidden fields directly
  setHidden('odin_user_log_dive_sites_id', siteId);
  setHidden('dive_site_bow', bow);

  // Step 2: fetch the site info popup HTML — it contains the "Select Site" button
  // which DiveSSI's own JS watches for clicks via event delegation
  try {
    const res = await fetch(
      `/code/process/ds_infowindow_sd.php?mainnav=mydivelog&a=selectsite&id=${siteId}`,
      { credentials: 'include' }
    );
    const html = await res.text();

    // Parse the response and extract the data attributes
    const tmp = document.createElement('div');
    tmp.innerHTML = html;
    const selectBtn = tmp.querySelector('[data-ds]');
    if (selectBtn) {
      // Inject the button into the page briefly and trigger DiveSSI's click handler
      selectBtn.style.display = 'none';
      document.body.appendChild(selectBtn);

      // DiveSSI binds to .tip_n clicks via jQuery delegation on document
      // Trigger both jQuery and native click events
      selectBtn.click();
      if (window.jQuery) {
        window.jQuery(selectBtn).trigger('click');
      }
      await new Promise(r => setTimeout(r, 200));
      selectBtn.remove();
    }

    // Step 3: also update any visible site name display the form shows
    const siteDisplay = document.querySelector('#selected_dive_site_name, .dive-site-name-display, [id*="site_name"]');
    if (siteDisplay) siteDisplay.textContent = siteName;

    // Step 4: dispatch a change event on the hidden field so any watchers notice
    const hiddenField = field('odin_user_log_dive_sites_id');
    if (hiddenField) {
      hiddenField.dispatchEvent(new Event('change', { bubbles: true }));
      hiddenField.dispatchEvent(new Event('input',  { bubbles: true }));
    }
  } catch(e) {
    console.warn('selectSite fetch error:', e);
    // Hidden fields were already set above — that may be enough
  }
}

// ─── Scrape buddies ───────────────────────────────────────────────────────────

function scrapeBuddiesFromForm() {
  const sel = field('odin_user_log_buddy_ids[]');
  if (!sel) return [];
  return Array.from(sel.options)
    .filter(o => o.value && o.value !== '0')
    .map(o => ({ id: o.value, name: o.text.trim() }));
}

// ─── Scrape training centers ──────────────────────────────────────────────────

function scrapeTrainingCentersFromForm() {
  const sel = field('log_linked_facility_id');
  if (!sel) return [];
  return Array.from(sel.options)
    .filter(o => o.value && o.value !== '0' && o.value !== '')
    .map(o => ({ id: o.value, name: o.text.trim() }));
}

// ─── Set buddy ────────────────────────────────────────────────────────────────

function setBuddy(buddyId) {
  const sel = field('odin_user_log_buddy_ids[]');
  if (!sel) return false;
  for (const opt of sel.options) {
    if (opt.value === String(buddyId)) {
      opt.selected = true;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  }
  return false;
}

// ─── Fill all form fields ─────────────────────────────────────────────────────

function fillAllFields(dive, dates) {
  // Date
  setSelect('date_sel2_dd', String(dates.day).padStart(2, '0'));
  setSelect('date_sel2_mm', String(dates.month).padStart(2, '0'));
  setSelect('date_sel2_yy', String(dates.year));
  setField('odin_user_log_entry_time', dates.time);

  // Dive number
  setField('odin_user_log_dive_nr', dive.diveNumber);

  // Kind of dive — radio (0=SCUBA, 2=XR, 4=SCR, 6=Freediving, 8=CCR)
  const diveTypeVal = String(dive.diveTypeValue ?? 0);
  document.querySelectorAll('input[name="odin_user_log_dive_type"]').forEach(radio => {
    if (radio.value === diveTypeVal) {
      radio.checked = true;
      radio.dispatchEvent(new Event('change', { bubbles: true }));
    }
  });

  // Dive type dropdown
  setSelect('odin_user_log_var_divetype_id', 'Fun Dive');

  // Hidden computer/deco fields
  setHidden('odin_user_log_diveComputer', dive.computer || 'Shearwater Perdix 2');
  setHidden('odin_user_log_si_before',    dive.surfaceInterval || 0);
  setHidden('odin_user_log_gf_set',       `${dive.gfLow}/${dive.gfHigh}`);
  setHidden('odin_user_log_gf_set_1',     dive.gfLow);
  setHidden('odin_user_log_gf_set_2',     dive.gfHigh);
  setHidden('odin_user_log_gf_end',       dive.gfHigh);
  setHidden('odin_user_log_cns_start',    dive.startCNS || 0);
  setHidden('odin_user_log_cns_end',      dive.endCNS   || 0);

  // Depth & time
  setField('odin_user_log_divetime',  dive.duration);
  setField('odin_user_log_depth_m',   dive.maxDepth);
  if (dive.avgDepth) setField('odin_user_log_avg_depth_m', dive.avgDepth);

  // Conditions
  setSelect('odin_user_log_var_water_body_id', dive.waterBody  || 'Ocean');
  setSelect('odin_user_log_var_watertype_id',  dive.waterType  || 'Salt Water');
  if (dive.entryType)       setSelect('odin_user_log_var_entry_id',      dive.entryType);
  if (dive.current)         setSelect('odin_user_log_var_current_id',    dive.current);
  if (dive.surface)         setSelect('odin_user_log_var_surface_id',    dive.surface);
  if (dive.weather)         setSelect('odin_user_log_var_weather_id',    dive.weather);
  if (dive.airTemp)         setField('odin_user_log_airtemp_c',          dive.airTemp);
  if (dive.waterTemp)       setField('odin_user_log_watertemp_c',        dive.waterTemp);
  if (dive.waterTempBottom) setField('odin_user_log_watertemp_max_c',    dive.waterTempBottom);
  if (dive.visibility)      setField('odin_user_log_vis_m',              dive.visibility);

  // Tank / gas — round pressure to nearest whole number
  if (dive.pressureStart) setField('odin_user_log_pressure_start_bar', Math.round(parseFloat(dive.pressureStart)));
  if (dive.pressureEnd)   setField('odin_user_log_pressure_end_bar',   Math.round(parseFloat(dive.pressureEnd)));
  if (dive.tankVol)       setField('odin_user_log_tank_vol_l',         dive.tankVol);
  if (dive.tankConfig)    setSelect('odin_user_log_gearconfiguration_id', dive.tankConfig);
  if (dive.eanPercent && parseInt(dive.eanPercent) > 21) {
    const cb = field('odin_user_log_ean');
    if (cb && !cb.checked) cb.click();
    setField('odin_user_log_ean_percent', dive.eanPercent);
  }

  // Weight
  if (dive.weight) setField('odin_user_log_weight_kg', dive.weight);

  // Training center
  if (dive.trainingCenterId) setSelect('log_linked_facility_id', dive.trainingCenterId);

  // Buddy
  if (dive.buddyId) setBuddy(dive.buddyId);

  // Rating
  if (dive.rating) setHidden('odin_user_log_rating', dive.rating);

  // Comment
  const comment = [
    `Imported from Shearwater ${dive.computer || 'Perdix 2'}`,
    dive.decoModel ? `Deco: ${dive.decoModel} GF ${dive.gfLow}/${dive.gfHigh}` : null,
    (dive.startCNS != null && dive.endCNS != null) ? `CNS: ${dive.startCNS}% → ${dive.endCNS}%` : null,
    dive.surfaceInterval > 0 ? `SI: ${dive.surfaceInterval} min` : null,
    dive.notes || null,
  ].filter(Boolean).join('\n');
  setNativeValue(field('odin_user_log_comment'), comment);
  if (dive.gearNotes) setNativeValue(field('odin_user_log_gear_details'), dive.gearNotes);
}

// ─── Wizard navigation ────────────────────────────────────────────────────────

function getVisibleNextBtn() {
  return Array.from(document.querySelectorAll('input[name="next"], input[name="odin_user_log_next"]'))
    .find(isVisible) || null;
}
function getVisibleSubmitBtn() {
  const btn = document.querySelector('input[name="submit"][type="submit"]');
  return btn && isVisible(btn) ? btn : null;
}

// ─── Pause banner ─────────────────────────────────────────────────────────────

const BANNER_ID = 'divessi-importer-banner';

function showPauseBanner(diveInfo, sites) {
  removeBanner();
  const banner = document.createElement('div');
  banner.id = BANNER_ID;
  banner.style.cssText = `
    position:fixed;top:0;left:0;right:0;z-index:999999;
    background:#0d2244;border-bottom:3px solid #5b9bd5;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    box-shadow:0 4px 24px rgba(0,0,0,0.6);
  `;

  const siteBtns = sites.length > 0
    ? sites.slice(0, 10).map(s => `
        <div class="dsii-site-btn" data-id="${s.id}" data-name="${s.name}" data-bow="${s.bow||'salt'}"
          style="background:#1a3a6b;border:1px solid #2a5a9b;border-radius:6px;
                 padding:4px 10px;cursor:pointer;font-size:12px;color:#c8d8f0;
                 white-space:nowrap;transition:background 0.15s;">
          ${s.name} <span style="color:#5b9bd5;font-size:10px">#${s.id}</span>
        </div>`).join('')
    : `<span style="font-size:12px;color:#8899bb">No sites found — select on map below ↓</span>`;

  banner.innerHTML = `
    <div style="padding:10px 16px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #1e3a6b;">
      <div style="font-size:22px">🤿</div>
      <div style="flex:1">
        <div style="font-size:13px;font-weight:700;color:#7eb8f7;">
          Dive #${diveInfo.diveNumber} &nbsp;·&nbsp; ${diveInfo.display}
          &nbsp;·&nbsp; ${diveInfo.maxDepth}m &nbsp;·&nbsp; ${diveInfo.duration} min
          ${diveInfo.site ? `&nbsp;·&nbsp; <span style="color:#40c080">${diveInfo.site}</span>` : ''}
        </div>
        <div style="font-size:11px;color:#8899bb;margin-top:2px;">
          Select dive site below or on the map, then click Continue
        </div>
      </div>
      <button id="${BANNER_ID}-continue" style="
        background:#1e6bb8;color:white;border:none;border-radius:8px;
        padding:9px 18px;font-size:13px;font-weight:700;cursor:pointer;
        opacity:0.35;pointer-events:none;white-space:nowrap;transition:opacity 0.2s;">
        Continue ▶
      </button>
    </div>
    <div style="padding:8px 16px 10px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
      ${siteBtns}
    </div>
  `;

  document.body.prepend(banner);
  document.body.style.paddingTop = (banner.offsetHeight + 4) + 'px';

  const continueBtn = document.getElementById(`${BANNER_ID}-continue`);
  const siteField = field('odin_user_log_dive_sites_id');

  function enableContinue() {
    continueBtn.style.opacity = '1';
    continueBtn.style.pointerEvents = 'auto';
  }

  banner.querySelectorAll('.dsii-site-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      selectSite(btn.dataset.id, btn.dataset.name, btn.dataset.bow).then(() => {
        // Re-check after async completes
        const sf = field('odin_user_log_dive_sites_id');
        if (sf?.value && sf.value !== '0') enableContinue();
      });
      banner.querySelectorAll('.dsii-site-btn').forEach(b => {
        b.style.background = '#1a3a6b'; b.style.border = '1px solid #2a5a9b'; b.style.color = '#c8d8f0';
      });
      btn.style.background = '#1e6bb8'; btn.style.border = '1px solid #5b9bd5'; btn.style.color = 'white';
      enableContinue();
    });
  });

  const poll = setInterval(() => {
    if (siteField?.value && siteField.value !== '0' && siteField.value !== '') enableContinue();
  }, 300);

  return new Promise(resolve => {
    continueBtn.addEventListener('click', () => { clearInterval(poll); resolve(); });
  });
}

function removeBanner() {
  document.getElementById(BANNER_ID)?.remove();
  document.body.style.paddingTop = '';
}

// ─── Main wizard runner ───────────────────────────────────────────────────────

async function runWizard(dive, dates) {
  try {
    fillAllFields(dive, dates);
    await sleep(300);

    // Step 1 → 2
    getVisibleNextBtn()?.click();
    await sleep(1200);
    fillAllFields(dive, dates);

    // Site search
    let sites = [];
    if (dive.diveSiteName) {
      try { sites = await searchDiveSites(dive.diveSiteName); } catch(e) { console.warn('Site search:', e); }
    }
    if (dive.diveSiteId) {
      await selectSite(dive.diveSiteId, dive.diveSiteName || '', dive.diveSiteBow || 'salt');
      await sleep(600);
    }

    await showPauseBanner({
      diveNumber: dive.diveNumber, display: dates.display,
      maxDepth: dive.maxDepth, duration: dive.duration, site: dive.diveSiteName || '',
    }, sites);

    removeBanner();
    await sleep(300);
    fillAllFields(dive, dates);

    // Step 2 → 3
    getVisibleNextBtn()?.click();
    await sleep(1000);
    fillAllFields(dive, dates);

    // Step 3 → 4
    getVisibleNextBtn()?.click();
    await sleep(800);
    fillAllFields(dive, dates);

    // Step 4 → 5
    getVisibleNextBtn()?.click();
    await sleep(800);
    fillAllFields(dive, dates);

    // Step 5: submit
    await sleep(400);
    getVisibleSubmitBtn()?.click();
    return { success: true };

  } catch (err) {
    removeBanner();
    return { success: false, error: err.message };
  }
}

// ─── Scrape existing dive log via API ─────────────────────────────────────────
// DiveSSI loads the logbook dynamically — scraping DOM is unreliable.
// Instead we call the same JSON API the page uses to populate itself.

function scrapeExistingDives() {
  // The /mydivelog page renders a DataTables table with id="divestable".
  // Each row's date cell uses data-order="YYYY-MM-DD HH:MM" for sorting.
  // e.g. <td data-order="2024-10-13 09:46" id="date_21439204">
  // This is far more reliable than parsing visible text.

  const dives = [];
  const seen = new Set();

  // Method 1: target cells with id starting with "date_" — most precise
  document.querySelectorAll('td[id^="date_"]').forEach(cell => {
    const dateOrder = cell.dataset && cell.dataset.order ? cell.dataset.order : '';
    const id = cell.id.replace('date_', '');
    if (dateOrder && !seen.has(dateOrder)) {
      seen.add(dateOrder);
      dives.push({ dateStr: dateOrder, id });
    }
  });

  // Method 2: scan #divestable rows, 4th column has the date data-order
  if (dives.length === 0) {
    const table = document.getElementById('divestable');
    if (table) {
      table.querySelectorAll('tbody tr').forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 4) return;
        const dateCell = cells[3];
        const dateOrder = dateCell && dateCell.dataset && dateCell.dataset.order
          ? dateCell.dataset.order : '';
        if (dateOrder && !seen.has(dateOrder)) {
          seen.add(dateOrder);
          dives.push({ dateStr: dateOrder, id: '' });
        }
      });
    }
  }

  return dives;
}

// ─── Message listener ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {

  if (message.type === 'FILL_AND_SUBMIT') {
    runWizard(message.dive, message.dates)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (message.type === 'SEARCH_SITES') {
    // [FIX #2] Use locationHint to centre the map search on the right region
    // The "adr" field on the DiveSSI form is the geo-centre input.
    // We pre-fill it with the location name so the search is geographically filtered.
    const locationHint = message.locationHint || '';
    if (locationHint) {
      const adrInput = document.querySelector('[name="adr"], #adr, input[placeholder*="Place"]');
      if (adrInput) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(adrInput, locationHint);
        adrInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }

    const params = new URLSearchParams({
      'filter[country]': '', 'filter[site]': message.query, 'filter[area]': locationHint,
      minlat: -89, minlng: -179.9999, maxlat: 89, maxlng: 179.9999,
      latitude: 0, longitude: 0,
    });
    fetch(`/code/geo/dive_site.json.sd.php?${params}`, { credentials: 'include' })
      .then(r => r.text())
      .then(text => {
        try {
          const data = JSON.parse(text);
          sendResponse({ ok: true, data, raw: text.slice(0, 200) });
        } catch(e) {
          sendResponse({ ok: false, error: 'JSON parse failed', raw: text.slice(0, 300) });
        }
      })
      .catch(err => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === 'SCRAPE_BUDDIES') {
    sendResponse({ buddies: scrapeBuddiesFromForm() });
    return true;
  }

  if (message.type === 'SCRAPE_TRAINING_CENTERS') {
    sendResponse({ centers: scrapeTrainingCentersFromForm() });
    return true;
  }

  if (message.type === 'SCRAPE_DIVE_LOG') {
    try {
      const dives = scrapeExistingDives();
      sendResponse({ dives });
    } catch(err) {
      sendResponse({ dives: [], error: err.message });
    }
    return true;
  }
});
