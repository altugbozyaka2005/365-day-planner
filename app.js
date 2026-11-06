(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants & helpers
  // ---------------------------------------------------------------------------
  const TZ = 'Europe/London';
  const STORE = 'planner365.v1';
  const UI_STORE = 'planner365.ui';
  const DIVS = [1, 2, 3, 4, 5, 6, 10, 12]; // slots per hour (60, 30, 20, 15, 12, 10, 6, 5 min)
  const STATUS_LABEL = { g: 'Completed', y: "Wasn't efficient enough", r: 'Not attempted / distracted' };

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const hm = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
  const dur = (min) => {
    min = Math.round(min);
    if (!min) return '0m';
    const h = Math.floor(min / 60), m = min % 60;
    return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

  // Dates are handled as "YYYY-MM-DD" keys; arithmetic happens in UTC so DST never shifts a day.
  const parseKey = (k) => { const [y, m, d] = k.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const toKey = (dt) => dt.toISOString().slice(0, 10);
  const addDays = (k, n) => { const d = parseKey(k); d.setUTCDate(d.getUTCDate() + n); return toKey(d); };
  const addYears = (k, n) => {
    const [y, m, d] = k.split('-').map(Number);
    const last = new Date(Date.UTC(y + n, m, 0)).getUTCDate();
    return `${y + n}-${pad(m)}-${pad(Math.min(d, last))}`;
  };
  const dow = (k) => (parseKey(k).getUTCDay() + 6) % 7; // Monday = 0
  const fmt = (k, opts) => parseKey(k).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });
  const dayOfYear = (k) => Math.round((parseKey(k) - Date.UTC(+k.slice(0, 4), 0, 1)) / 864e5) + 1;
  const daysInYear = (y) => ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 366 : 365);
  const isoWeek = (k) => {
    const d = parseKey(k);
    d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
    const w1 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((d - w1) / 864e5 - 3 + ((w1.getUTCDay() + 6) % 7)) / 7);
  };

  const londonFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  function londonNow() {
    const p = Object.fromEntries(londonFmt.formatToParts(new Date()).map((x) => [x.type, x.value]));
    const h = +p.hour % 24;
    return { date: `${p.year}-${p.month}-${p.day}`, h, min: h * 60 + +p.minute, sec: +p.second, label: `${pad(h)}:${p.minute}:${p.second}` };
  }

  // ---------------------------------------------------------------------------
  // Event categories (colour-coding Outlook events by title keywords)
  // ---------------------------------------------------------------------------
  function defaultCategories() {
    return [
      { id: 'lecture', name: 'Lecture', color: '#7048e8', kw: 'lecture, lec, seminar, tutorial, workshop, lab, class, module, practical' },
      { id: 'meeting', name: 'Meeting', color: '#1971c2', kw: 'meeting, call, sync, stand-up, standup, 1:1, interview, catch up, catch-up, review, teams' },
      { id: 'study', name: 'Study', color: '#0c8599', kw: 'study, revision, revise, exam, assignment, coursework, homework, reading, deadline, essay' },
      { id: 'exercise', name: 'Exercise', color: '#e8590c', kw: 'gym, run, workout, football, yoga, swim, training, tennis, climbing, walk' },
      { id: 'social', name: 'Social', color: '#d6336c', kw: 'dinner, lunch, drinks, party, birthday, coffee, brunch, date' },
      { id: 'personal', name: 'Personal', color: '#8d6e63', kw: 'dentist, doctor, gp, appointment, haircut, bank, errand, travel, flight, train' },
    ];
  }
  const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let catMatchers = null; // compiled lazily, reset when categories change
  const catCache = new Map();
  function resetCategoryCache() { catMatchers = null; catCache.clear(); }
  function categoryOf(ev) {
    const cacheKey = ev.t + '\u0000' + (ev.c || []).join(',');
    if (catCache.has(cacheKey)) return catCache.get(cacheKey);
    if (!catMatchers) {
      catMatchers = data.settings.categories.map((c) => {
        const kws = String(c.kw || '').split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
        // match keywords at the start of a word, so "run" matches "Running" but not "brunch"
        return { c, re: kws.length ? new RegExp(`(^|[^a-z0-9])(${kws.map(reEsc).join('|')})`, 'i') : null };
      });
    }
    let found = null;
    const outlookCats = (ev.c || []).map((x) => x.toLowerCase());
    if (outlookCats.length) found = data.settings.categories.find((c) => outlookCats.includes(String(c.name).toLowerCase())) || null;
    if (!found) { const m = catMatchers.find((x) => x.re && x.re.test(ev.t)); found = m ? m.c : null; }
    const res = found || { id: 'other', name: 'Other', color: data.settings.otherColor };
    catCache.set(cacheKey, res);
    return res;
  }
  const evStyle = (ev) => `--evc:${esc(categoryOf(ev).color)}`;

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  function normalize(d) {
    d = d && typeof d === 'object' ? d : {};
    d.settings = { defaultSlots: 4, startHour: 6, endHour: 24, mergeEvents: true, otherColor: '#868e96', ...(d.settings || {}) };
    if (!DIVS.includes(+d.settings.defaultSlots)) d.settings.defaultSlots = 4;
    if (!Array.isArray(d.settings.categories)) d.settings.categories = defaultCategories();
    d.days = d.days && typeof d.days === 'object' ? d.days : {};
    for (const k of Object.keys(d.days)) {
      const x = d.days[k];
      if (!x || typeof x !== 'object' || !/^\d{4}-\d{2}-\d{2}$/.test(k)) { delete d.days[k]; continue; }
      x.div = x.div || {};
      x.slots = x.slots || {};
      x.goals = Array.isArray(x.goals) ? x.goals : [];
      x.blocks = x.blocks && typeof x.blocks === 'object' ? x.blocks : {};
      x.split = Array.isArray(x.split) ? x.split : [];
      if (!DIVS.includes(+x.base)) x.base = d.settings.defaultSlots;
    }
    return d;
  }
  function load() {
    let raw = null;
    try { raw = localStorage.getItem(STORE); } catch (e) { /* storage blocked */ }
    try { return normalize(raw ? JSON.parse(raw) : null); } catch (e) { return normalize(null); }
  }

  let data = load();
  let saveTimer = null;

  function setSaveState(s) {
    const el = $('#saveState');
    el.className = 'save-state' + (s === 'error' ? ' error' : '');
    el.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved' : s === 'error' ? 'Not saved!' : '';
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 300);
    setSaveState('saving');
  }
  function flush() {
    clearTimeout(saveTimer);
    saveTimer = null;
    for (const k of Object.keys(data.days)) {
      const x = data.days[k];
      if (!Object.keys(x.slots).length && !x.goals.length && !Object.keys(x.div).length &&
          !Object.keys(x.blocks).length && !x.split.length) delete data.days[k];
    }
    try {
      localStorage.setItem(STORE, JSON.stringify(data));
      setSaveState('saved');
    } catch (e) {
      setSaveState('error');
    }
  }
  window.addEventListener('beforeunload', () => { if (saveTimer) flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flush(); });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------------------------------------------------------------------------
  // Outlook calendar (ICS feed, relayed through server.py). Kept separate from
  // planner data so backups don't contain the private calendar link.
  // ---------------------------------------------------------------------------
  const CAL_STORE = 'planner365.cal';
  const CAL_REFRESH_MS = 15 * 60 * 1000;
  let cal = { url: '', fetchedAt: 0, error: '', byDate: {}, allDay: {} };
  try { cal = { ...cal, ...(JSON.parse(localStorage.getItem(CAL_STORE)) || {}) }; } catch (e) { /* ignore */ }
  const saveCal = () => { try { localStorage.setItem(CAL_STORE, JSON.stringify(cal)); } catch (e) { /* quota */ } };
  let calSyncing = false;

  const eventsOn = (key) => cal.byDate[key] || [];
  const allDayOn = (key) => cal.allDay[key] || [];
  const eventsIn = (key, m, L) => eventsOn(key).filter((ev) => ev.s < m + L && ev.e > m);
  const evTip = (ev) => `${hm(ev.s)}–${hm(ev.e)} · ${ev.t}${ev.loc ? ' · ' + ev.loc : ''}`;

  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} days ago`;
  }
  function calStatusText() {
    if (!cal.url) return 'Not connected.';
    if (calSyncing) return 'Syncing…';
    if (cal.error) return `⚠ ${cal.error}`;
    return cal.fetchedAt ? `Connected · ${cal.count ?? 0} events · synced ${ago(cal.fetchedAt)}` : 'Connected, not synced yet.';
  }
  function updateCalStatus() {
    const el = $('#icsStatus');
    if (el) el.textContent = calStatusText();
    const btn = $('[data-act="cal-sync"]');
    if (btn) {
      btn.textContent = calSyncing ? '↻ Syncing…' : cal.error ? '⚠ Outlook' : '↻ Outlook';
      btn.title = calStatusText();
    }
  }
  const isTypingSomewhere = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a.id !== 'datePick';
  };

  async function syncCalendar() {
    if (!cal.url || calSyncing) return;
    calSyncing = true;
    updateCalStatus();
    try {
      if (location.protocol === 'file:') throw new Error('Open the planner via "python3 server.py" (http://localhost:8365) to sync Outlook.');
      const res = await fetch('/api/ics', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: cal.url }),
      });
      const text = await res.text();
      if (!res.ok) {
        let msg = `Sync failed (HTTP ${res.status}).`;
        try { msg = JSON.parse(text).error || msg; } catch (e) {
          if (res.status === 404 || res.status === 501) msg = 'Calendar sync needs the planner server. Start it with "python3 server.py".';
        }
        throw new Error(msg);
      }
      const idx = window.PlannerCal.buildIndex(text);
      cal = { ...cal, byDate: idx.byDate, allDay: idx.allDay, count: idx.count, fetchedAt: Date.now(), error: '' };
    } catch (e) {
      cal.error = e.message || String(e);
    }
    calSyncing = false;
    saveCal();
    updateCalStatus();
    if (!isTypingSomewhere() && !drag) render();
  }

  // ---------------------------------------------------------------------------
  // Data model
  // ---------------------------------------------------------------------------
  const getDay = (key) => data.days[key];
  function ensureDay(key) {
    if (!data.days[key]) data.days[key] = { base: data.settings.defaultSlots, div: {}, slots: {}, goals: [], blocks: {}, split: [] };
    return data.days[key];
  }
  const getDiv = (day, h) => (day && day.div[h]) || (day && day.base) || data.settings.defaultSlots;
  function slotsOf(day, h) {
    const n = getDiv(day, h), L = 60 / n;
    return Array.from({ length: n }, (_, i) => ({ m: h * 60 + i * L, L }));
  }

  // ----- Merged slots -----
  // A day's real slots ("units") are the per-hour grid slots, except where a merged block
  // covers them. Blocks come from manual merges (day.blocks = {start: end}) and, automatically,
  // from Outlook events (unless the user split that event: day.split = ['start-end']).
  const MAX_MERGE_MIN = 4 * 60; // longer events (e.g. "working hours") are not merged
  function blocksOf(key) {
    const day = getDay(key);
    const out = [];
    if (day && day.blocks) for (const [s, e] of Object.entries(day.blocks)) out.push({ s: +s, e: +e, manual: true });
    if (data.settings.mergeEvents) {
      const split = new Set((day && day.split) || []);
      for (const ev of eventsOn(key)) {
        const len = ev.e - ev.s;
        if (len <= 0 || len > MAX_MERGE_MIN || split.has(`${ev.s}-${ev.e}`)) continue;
        out.push({ s: ev.s, e: ev.e, ev });
      }
    }
    // manual merges win; among events, earlier then longer wins; overlapping ones are dropped
    out.sort((a, b) => (b.manual ? 1 : 0) - (a.manual ? 1 : 0) || a.s - b.s || b.e - a.e);
    const kept = [];
    for (const b of out) if (!kept.some((k) => b.s < k.e && b.e > k.s)) kept.push(b);
    return kept.sort((a, b) => a.s - b.s);
  }
  function unitsOfDay(key) {
    const day = getDay(key);
    const blocks = blocksOf(key);
    const bounds = [];
    for (let h = 0; h < 24; h++) for (const s of slotsOf(day, h)) bounds.push(s.m);
    bounds.push(1440);
    const units = [];
    let t = 0, bi = 0, gi = 0;
    while (t < 1440) {
      while (bi < blocks.length && blocks[bi].e <= t) bi++;
      const b = blocks[bi];
      if (b && b.s <= t) { units.push({ m: t, L: b.e - t, block: b }); t = b.e; bi++; continue; }
      while (bounds[gi] <= t) gi++;
      const end = Math.min(bounds[gi], b ? b.s : 1440);
      units.push({ m: t, L: end - t });
      t = end;
    }
    return units;
  }
  const unitsOverlapping = (units, from, to) => units.filter((u) => u.m < to && u.m + u.L > from);
  const unitsStartingIn = (units, h) => units.filter((u) => Math.floor(u.m / 60) === h);
  const unitAt = (key, minute) => unitsOfDay(key).find((u) => u.m <= minute && minute < u.m + u.L);
  const lastUnitInHour = (key, h) => { const us = unitsOverlapping(unitsOfDay(key), h * 60, h * 60 + 60); return us[us.length - 1]; };

  function setSlot(key, m, patch) {
    const day = ensureDay(key);
    const next = { t: '', s: '', ...(day.slots[m] || {}), ...patch };
    if (!next.t && !next.s) delete day.slots[m];
    else day.slots[m] = next;
    save();
  }

  // Change the number of slots in an hour, re-mapping existing entries so nothing is lost.
  function setDiv(key, h, n) {
    const day = ensureDay(key);
    if (n === getDiv(day, h)) return;
    const L = 60 / n;
    const blocks = blocksOf(key);
    const moved = [];
    for (let m = h * 60; m < h * 60 + 60; m++) {
      // entries belonging to merged slots (or the gap right after one) stay where they are
      if (blocks.some((b) => b.s <= m && m <= b.e)) continue;
      if (day.slots[m]) { moved.push([m, day.slots[m]]); delete day.slots[m]; }
    }
    for (const [m, s] of moved) {
      const t = h * 60 + Math.floor((m - h * 60) / L) * L;
      const ex = day.slots[t];
      if (!ex) day.slots[t] = { ...s };
      else {
        ex.t = [ex.t, s.t].filter(Boolean).join(' · ');
        ex.s = ex.s || s.s;
      }
    }
    if (n === day.base) delete day.div[h];
    else day.div[h] = n;
  }
  function stepDiv(key, hours, dir) {
    let changed = false;
    for (const h of hours) {
      const i = DIVS.indexOf(getDiv(getDay(key), h));
      const j = i < 0 ? DIVS.indexOf(4) : i + dir;
      if (j >= 0 && j < DIVS.length) { setDiv(key, h, DIVS[j]); changed = true; }
    }
    if (changed) save();
    return changed;
  }

  function dayStats(key) {
    const r = { g: 0, y: 0, r: 0, unrated: 0, planned: 0, goals: 0, goalsDone: 0 };
    const day = getDay(key);
    if (!day) return r;
    if (Object.keys(day.slots).length) {
      for (const u of unitsOfDay(key)) {
        const s = day.slots[u.m];
        if (!s) continue;
        if (s.s) r[s.s] += u.L;
        else if (s.t) r.unrated += u.L;
        if (s.t) r.planned += u.L;
      }
    }
    r.goals = day.goals.length;
    r.goalsDone = day.goals.filter((g) => g.done).length;
    return r;
  }
  const scoreOf = (st) => {
    const rated = st.g + st.y + st.r;
    return rated ? (st.g + 0.5 * st.y) / rated : null;
  };

  // ---------------------------------------------------------------------------
  // UI state
  // ---------------------------------------------------------------------------
  let uiView = 'day';
  try { uiView = localStorage.getItem(UI_STORE) || 'day'; } catch (e) { /* ignore */ }
  const state = { view: ['day', 'week', 'year'].includes(uiView) ? uiView : 'day', date: londonNow().date };
  let sel = null;   // { date, a, b } – slot start minutes (anchor / focus)
  let drag = null;  // active pointer selection

  const selRange = () => [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)];
  function selSlots() {
    if (!sel) return [];
    const [lo, hi] = selRange();
    return unitsOfDay(sel.date).filter((u) => u.m >= lo && u.m <= hi);
  }
  // Snap the selection to valid slot starts after the layout changed.
  function normalizeSel() {
    if (!sel) return;
    const [lo, hi] = selRange();
    sel = { date: sel.date, a: unitAt(sel.date, lo).m, b: unitAt(sel.date, hi).m };
  }

  // Merge the selected slots into one, or split a merged slot back into the grid.
  function mergeSel() {
    const ss = selSlots();
    if (ss.length < 2) return;
    const key = sel.date, day = ensureDay(key);
    const s = ss[0].m, e = ss[ss.length - 1].m + ss[ss.length - 1].L;
    const texts = [], statuses = [];
    for (const u of ss) {
      const v = day.slots[u.m];
      if (v) { if (v.t) texts.push(v.t); if (v.s) statuses.push(v.s); }
      delete day.slots[u.m];
    }
    for (const k of Object.keys(day.blocks)) if (+k >= s && +k < e) delete day.blocks[k];
    day.blocks[s] = e;
    if (texts.length || statuses.length) day.slots[s] = { t: [...new Set(texts)].join(' · '), s: statuses[0] || '' };
    save();
    sel = { date: key, a: s, b: s };
    render();
  }
  function splitAt(key, m) {
    const u = unitsOfDay(key).find((x) => x.m === m);
    if (!u || !u.block) return;
    const day = ensureDay(key);
    if (u.block.manual) delete day.blocks[u.block.s];
    else day.split.push(`${u.block.s}-${u.block.e}`);
    save();
    if (sel && sel.date === key) normalizeSel();
    render();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function render() {
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
    $('#datePick').value = state.date;
    renderTitle();
    if (state.view === 'day') renderDay();
    else if (state.view === 'week') renderWeek();
    else renderYear();
    paintSel();
    paintNow();
    try { localStorage.setItem(UI_STORE, state.view); } catch (e) { /* ignore */ }
  }

  function renderTitle() {
    const now = londonNow();
    const k = state.date;
    let title = '', meta = '', actions = '';
    if (state.view === 'day') {
      title = fmt(k, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const diff = Math.round((parseKey(k) - parseKey(now.date)) / 864e5);
      const rel = diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : diff === -1 ? 'Yesterday' : '';
      meta = `${rel ? `<span class="badge">${rel}</span>` : ''}<span>Day ${dayOfYear(k)} of ${daysInYear(+k.slice(0, 4))}</span>`;
      if (k === now.date) actions += '<button class="btn" data-act="jump-now">Jump to now</button>';
      actions += '<button class="btn" data-act="copy-layout" title="Use the same slot lengths as the previous day">Copy slot layout from previous day</button>';
    } else if (state.view === 'week') {
      const start = addDays(k, -dow(k)), end = addDays(start, 6);
      title = `${fmt(start, { day: 'numeric', month: 'short' })} – ${fmt(end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
      meta = `<span class="badge">Week ${isoWeek(k)}</span>`;
      if (now.date >= start && now.date <= end) meta += '<span>This week</span>';
    } else {
      title = k.slice(0, 4);
      meta = `<span>${daysInYear(+k.slice(0, 4))} days</span>`;
    }
    if (cal.url && state.view !== 'year') actions += `<button class="btn" data-act="cal-sync">↻ Outlook</button>`;
    $('#title').textContent = title;
    $('#titleMeta').innerHTML = meta;
    $('#subActions').innerHTML = actions;
    updateCalStatus();
    document.title = `${title} · 365 Planner`;
  }

  // ----- Day view -----
  function evChips(key, s) {
    const all = eventsOn(key);
    // the event that owns a merged slot goes first
    const evs = eventsIn(key, s.m, s.L).sort((a, b) => (s.block && b === s.block.ev ? 1 : 0) - (s.block && a === s.block.ev ? 1 : 0));
    return evs.map((ev) => {
      const i = all.indexOf(ev);
      const cat = categoryOf(ev);
      return `<button class="ev ${ev.s < s.m ? 'cont' : ''}" style="${evStyle(ev)}" data-act="ev-fill" data-date="${key}" data-i="${i}"
        title="${esc(evTip(ev))} · ${esc(cat.name)}\nClick to copy into the empty slot(s) it covers">${ev.s < s.m ? '↳ ' : ''}${esc(ev.t)}</button>`;
    }).join('');
  }
  function slotHTML(s, v, key) {
    const chips = evChips(key, s);
    const owner = s.block && s.block.ev;
    const style = owner ? ` style="${evStyle(owner)}"` : '';
    const timeLabel = s.block ? `${hm(s.m)}<small>→${hm(s.m + s.L)}</small>` : hm(s.m);
    const splitTitle = owner ? 'Split this event back into normal slots' : 'Split this merged slot back into normal slots';
    return `<div class="slot ${v.s ? 's-' + v.s : ''} ${chips ? 'has-ev' : ''} ${s.block ? 'block' : ''} ${owner ? 'ev-block' : ''}"${style} data-m="${s.m}" data-len="${s.L}">
      <span class="slot-time" title="Drag to select a window · Shift-click to extend">${timeLabel}</span>
      <div class="slot-main">${chips ? `<span class="evs">${chips}</span>` : ''}<input class="slot-text" data-m="${s.m}" value="${esc(v.t)}" placeholder="Plan ${hm(s.m)}–${hm(s.m + s.L)}…" aria-label="Plan for ${hm(s.m)}" autocomplete="off">${s.block ? `<button class="split-btn" data-act="split" data-m="${s.m}" title="${splitTitle}">${s.L}m · split</button>` : ''}</div>
      <span class="status">${['g', 'y', 'r'].map((c) =>
        `<button class="dot dot-${c} ${v.s === c ? 'on' : ''}" data-act="status" data-s="${c}" data-m="${s.m}" title="${STATUS_LABEL[c]}" aria-label="${STATUS_LABEL[c]}"></button>`).join('')}</span>
    </div>`;
  }
  // A merged slot that started in an earlier hour shows a slim "continues" row.
  function contHTML(u, v, key, h) {
    const owner = u.block && u.block.ev;
    const label = v.t || (owner ? owner.t : 'Merged slot');
    return `<div class="slot cont ${v.s ? 's-' + v.s : ''} ${owner ? 'ev-block' : ''}"${owner ? ` style="${evStyle(owner)}"` : ''} data-m="${u.m}" data-cont="1">
      <span class="slot-time" title="Part of the slot that starts at ${hm(u.m)}">${hm(h * 60)}</span>
      <div class="slot-main"><span class="cont-label">↳ ${esc(label)} <span class="muted">· ${hm(u.m)}–${hm(u.m + u.L)}</span></span></div>
      <span></span>
    </div>`;
  }

  function renderDay() {
    const key = state.date, day = getDay(key);
    const { startHour: sh, endHour: eh } = data.settings;
    const units = unitsOfDay(key);
    let html = '<div class="day-layout"><section class="timeline" id="timeline">';
    const ad = allDayOn(key);
    if (ad.length) html += `<div class="allday"><span class="allday-lbl">All day</span>${ad.map((e) => `<span class="ev" style="${evStyle(e)}">${esc(e.t)}</span>`).join('')}</div>`;
    for (let h = sh; h < eh; h++) {
      const n = getDiv(day, h), i = DIVS.indexOf(n);
      const rows = unitsOverlapping(units, h * 60, h * 60 + 60).map((u) => {
        const v = (day && day.slots[u.m]) || {};
        return u.m < h * 60 ? contHTML(u, v, key, h) : slotHTML(u, v, key);
      }).join('');
      html += `<div class="hour" data-h="${h}">
        <div class="hour-head">
          <span class="hour-label" data-h="${h}" title="Click to select this hour">${hm(h * 60)}</span>
          <div class="div-ctl">
            <button class="mini" data-act="hminus" data-h="${h}" ${i <= 0 ? 'disabled' : ''} title="Fewer, longer slots">−</button>
            <span class="div-len">${60 / n}m</span>
            <button class="mini" data-act="hplus" data-h="${h}" ${i >= DIVS.length - 1 ? 'disabled' : ''} title="More, shorter slots">+</button>
          </div>
        </div>
        <div class="slots">${rows}</div>
      </div>`;
    }
    html += `</section><aside class="side">${goalsCard(key)}${summaryCard(key)}${categoryCard(key)}${helpCard()}</aside></div>`;
    $('#main').innerHTML = html;
  }

  // Time per category from today's Outlook events
  function categoryCard(key) {
    const evs = eventsOn(key);
    if (!evs.length) return '';
    const totals = new Map();
    for (const ev of evs) {
      const c = categoryOf(ev);
      const cur = totals.get(c.id) || { c, min: 0, n: 0 };
      cur.min += ev.e - ev.s; cur.n++;
      totals.set(c.id, cur);
    }
    const rows = [...totals.values()].sort((a, b) => b.min - a.min);
    return `<div class="card" id="catCard">
      <div class="card-head"><h2>Calendar by category</h2><button class="link" data-act="edit-cats" style="margin:0">Edit</button></div>
      <div class="stats">${rows.map((r) => `<span class="sw" style="background:${esc(r.c.color)}"></span><span>${esc(r.c.name)} <span class="muted">× ${r.n}</span></span><span class="v">${dur(r.min)}</span>`).join('')}</div>
    </div>`;
  }

  function goalsCard(key) {
    const goals = (getDay(key) || {}).goals || [];
    const done = goals.filter((g) => g.done).length;
    return `<div class="card" id="goalsCard">
      <div class="card-head"><h2>Daily goals</h2><span class="muted">${done}/${goals.length} done</span></div>
      ${goals.length ? `<div class="progress"><span style="width:${(done / goals.length) * 100}%"></span></div>` : ''}
      <ul class="goals">${goals.map((g) => `<li class="${g.done ? 'done' : ''}">
        <label><input type="checkbox" data-act="goal-toggle" data-date="${key}" data-id="${g.id}" ${g.done ? 'checked' : ''}><span>${esc(g.text)}</span></label>
        <button class="x" data-act="goal-del" data-date="${key}" data-id="${g.id}" title="Delete goal">×</button></li>`).join('')}</ul>
      <form class="goal-form" data-act="goal-add" data-date="${key}">
        <input name="g" placeholder="Add a goal for this day…" autocomplete="off"><button type="submit">Add</button>
      </form>
      <button class="link" data-act="goal-carry">Carry over unfinished goals from previous day</button>
    </div>`;
  }

  function summaryCard(key) {
    const st = dayStats(key);
    const total = st.g + st.y + st.r + st.unrated;
    const pct = (v) => (total ? (v / total) * 100 : 0);
    const score = scoreOf(st);
    const row = (c, label, v) => `<span class="sw" style="background:${c}"></span><span>${label}</span><span class="v">${dur(v)}</span>`;
    return `<div class="card" id="summary">
      <div class="card-head"><h2>Day summary</h2><span class="muted">${score === null ? 'no ratings yet' : 'focus score'}</span></div>
      ${score === null ? '' : `<div class="score">${Math.round(score * 100)}%</div>`}
      <div class="stack">
        <span style="width:${pct(st.g)}%;background:var(--green)"></span>
        <span style="width:${pct(st.y)}%;background:var(--yellow)"></span>
        <span style="width:${pct(st.r)}%;background:var(--red)"></span>
      </div>
      <div class="stats">
        ${row('var(--green)', 'Completed', st.g)}
        ${row('var(--yellow)', "Wasn't efficient", st.y)}
        ${row('var(--red)', 'Not attempted / distracted', st.r)}
        ${row('var(--border)', 'Planned, not rated', st.unrated)}
      </div>
    </div>`;
  }
  const updateSummary = () => { const el = $('#summary'); if (el) el.outerHTML = summaryCard(state.date); };

  function helpCard() {
    return `<div class="card help"><ul>
      <li>Use <b>−</b> / <b>+</b> next to an hour to change its slot length (60 → 30 → 20 → 15 → 12 → 10 → 6 → 5 min).</li>
      <li>Drag over the times (or click an hour label) to select a window, then use the bar at the bottom to resize, label, or rate it.</li>
      <li>With a selection: <kbd>G</kbd> <kbd>Y</kbd> <kbd>R</kbd> rate, <kbd>0</kbd> clear, <kbd>−</kbd> <kbd>+</kbd> resize, <kbd>Esc</kbd> deselect.</li>
      <li>In the week view, click a slot to type and rate it right there; drag down a day to edit several at once.</li>
      <li>📅 Outlook events become one merged slot, colour-coded by category (edit in ⚙ Settings). Click an event tag to copy its title into the slot; “split” undoes the merge.</li>
      <li>Select several slots and press <b>⇲ Merge</b> (or <kbd>M</kbd>) to turn them into one.</li>
      <li><kbd>Enter</kbd> in a slot jumps to the next one. <kbd>←</kbd> <kbd>→</kbd> change day, <kbd>T</kbd> today.</li>
    </ul></div>`;
  }

  // ----- Week view -----
  function weekLegend(days) {
    const seen = new Map();
    for (const k of days) for (const ev of [...eventsOn(k), ...allDayOn(k)]) { const c = categoryOf(ev); seen.set(c.id, c); }
    if (!seen.size) return '';
    return `<div class="legend">${[...seen.values()].map((c) => `<span class="legend-item"><span class="sw" style="background:${esc(c.color)}"></span>${esc(c.name)}</span>`).join('')}
      <button class="link" data-act="edit-cats" style="margin:0">Edit categories</button></div>`;
  }
  function renderWeek() {
    const start = addDays(state.date, -dow(state.date));
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    const today = londonNow().date;
    const { startHour: sh, endHour: eh } = data.settings;
    let html = weekLegend(days) + '<div class="week-wrap"><div class="week"><div class="wk-corner"></div>';
    for (const k of days) {
      const st = dayStats(k), score = scoreOf(st);
      html += `<button class="wk-head ${k === today ? 'today' : ''}" data-act="open-day" data-date="${k}" title="Open day">
        <span class="wk-dow">${fmt(k, { weekday: 'short' })}</span>
        <span class="wk-date">${fmt(k, { day: 'numeric', month: 'short' })}</span>
        <span class="wk-meta">${st.g ? `<span>${dur(st.g)} done</span>` : ''}${score !== null ? `<span>${Math.round(score * 100)}%</span>` : ''}</span>
        ${allDayOn(k).map((e) => `<span class="ev wk-allday" style="${evStyle(e)}" title="All day · ${esc(e.t)}">${esc(e.t)}</span>`).join('')}
      </button>`;
    }
    html += '<div class="wk-glabel">Goals</div>';
    for (const k of days) {
      const goals = (getDay(k) || {}).goals || [];
      html += `<div class="wk-goals">${goals.map((g) => `<label class="${g.done ? 'done' : ''}">
          <input type="checkbox" data-act="goal-toggle" data-date="${k}" data-id="${g.id}" ${g.done ? 'checked' : ''}><span>${esc(g.text)}</span></label>`).join('')}
        <form data-act="goal-add" data-date="${k}"><input name="g" placeholder="+ goal" autocomplete="off"></form></div>`;
    }
    const unitsByDay = Object.fromEntries(days.map((k) => [k, unitsOfDay(k)]));
    for (let h = sh; h < eh; h++) {
      html += `<div class="wk-hour">${hm(h * 60)}</div>`;
      for (const k of days) {
        const day = getDay(k);
        const segs = unitsOverlapping(unitsByDay[k], h * 60, h * 60 + 60);
        html += `<div class="wk-cell ${k === today ? 'today' : ''}">${segs.map((u) => {
          const v = (day && day.slots[u.m]) || {};
          const evs = eventsIn(k, u.m, u.L);
          const owner = (u.block && u.block.ev) || evs.find((ev) => ev.s >= u.m) || evs[0];
          const cont = u.m < h * 60;
          const flex = Math.min(u.m + u.L, h * 60 + 60) - Math.max(u.m, h * 60);
          const tip = `${hm(u.m)}–${hm(u.m + u.L)}${v.t ? ' · ' + v.t : ''}${v.s ? ' · ' + STATUS_LABEL[v.s] : ''}` +
            evs.map((ev) => `\n📅 ${evTip(ev)} · ${categoryOf(ev).name}`).join('') + '\nClick to edit · drag to select several · double-click for day view';
          const startEv = evs.find((ev) => ev.s >= u.m);
          const label = cont ? '' : v.t ? `<span>${esc(v.t)}</span>` : startEv ? `<span class="ev-t">${esc(startEv.t)}</span>` : '';
          const style = `flex:${flex} 1 0;${owner ? evStyle(owner) : ''}`;
          return `<div class="wk-slot ${v.s ? 's-' + v.s : ''} ${v.t ? 'has' : ''} ${evs.length ? 'has-ev' : ''} ${u.block ? 'block' : ''} ${cont ? 'cont' : ''} ${u.m + u.L > h * 60 + 60 ? 'runs-on' : ''}" style="${style}" data-date="${k}" data-m="${u.m}" title="${esc(tip)}">${label}</div>`;
        }).join('')}</div>`;
      }
    }
    html += '</div></div>';
    $('#main').innerHTML = html;
  }

  // ----- Year view -----
  function renderYear() {
    const y = +state.date.slice(0, 4);
    const today = londonNow().date;
    const tot = { g: 0, y: 0, r: 0, tracked: 0, goals: 0, goalsDone: 0 };
    let months = '';
    for (let mo = 0; mo < 12; mo++) {
      const first = `${y}-${pad(mo + 1)}-01`;
      const nd = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
      let cells = '<span></span>'.repeat(dow(first));
      for (let d = 1; d <= nd; d++) {
        const k = `${y}-${pad(mo + 1)}-${pad(d)}`;
        const st = dayStats(k), score = scoreOf(st);
        let cls = '', style = '';
        if (score !== null) {
          cls = 'data';
          const hue = Math.round(score * 120);
          style = `--c:hsl(${hue} ${hue > 90 ? 50 : 70}% ${hue > 30 && hue < 70 ? 46 : 44}%)`;
        } else if (st.goals || st.planned) cls = 'goalsonly';
        if (st.goals && st.goalsDone === st.goals) cls += ' allgoals';
        if (k === today) cls += ' today';
        if (k === state.date) cls += ' sel';
        if (st.g + st.y + st.r + st.planned + st.goals) tot.tracked++;
        tot.g += st.g; tot.y += st.y; tot.r += st.r; tot.goals += st.goals; tot.goalsDone += st.goalsDone;
        const tip = `${fmt(k, { weekday: 'short', day: 'numeric', month: 'short' })}` +
          (score !== null ? ` · focus ${Math.round(score * 100)}% · ${dur(st.g)} completed` : '') +
          (st.goals ? ` · goals ${st.goalsDone}/${st.goals}` : '');
        cells += `<button class="yr-day ${cls}" style="${style}" data-act="open-day" data-date="${k}" title="${esc(tip)}">${d}</button>`;
      }
      months += `<div class="card yr-month"><h3>${fmt(first, { month: 'long' })}</h3>
        <div class="yr-dow"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
        <div class="yr-grid">${cells}</div></div>`;
    }
    const ys = scoreOf(tot);
    $('#main').innerHTML = `
      <div class="yr-stats">
        <div class="card"><div class="k">Days tracked</div><div class="v">${tot.tracked}</div></div>
        <div class="card"><div class="k">Time completed</div><div class="v">${dur(tot.g)}</div></div>
        <div class="card"><div class="k">Focus score</div><div class="v">${ys === null ? '—' : Math.round(ys * 100) + '%'}</div></div>
        <div class="card"><div class="k">Goals completed</div><div class="v">${tot.goalsDone}/${tot.goals}</div></div>
      </div>
      <div class="yr-legend"><span>Focus score</span><span>0%</span><span class="grad"></span><span>100%</span>
        <span style="margin-left:12px">• dot = all goals done</span></div>
      <div class="yr-months">${months}</div>`;
  }

  // ----- Live "now" highlight & selection painting -----
  function paintNow() {
    const now = londonNow();
    $('#clock').textContent = now.label;
    if (state.view === 'year') return;
    const cur = unitAt(now.date, now.min);
    const progress = ((now.min - cur.m) * 60 + now.sec) / (cur.L * 60);
    let els = [];
    if (state.view === 'day' && state.date === now.date) els = $$(`.slot[data-m="${cur.m}"]:not(.cont)`);
    else if (state.view === 'week') els = $$(`.wk-slot[data-date="${now.date}"][data-m="${cur.m}"]`);
    $$('.is-now').forEach((e) => { if (!els.includes(e)) e.classList.remove('is-now'); });
    $$('.hour.is-now-hour').forEach((e) => { if (!els.length || +e.dataset.h !== now.h) e.classList.remove('is-now-hour'); });
    for (const el of els) {
      el.classList.add('is-now');
      el.style.setProperty('--p', progress.toFixed(4));
    }
    if (els.length && state.view === 'day') { const hr = $(`.hour[data-h="${now.h}"]`); if (hr) hr.classList.add('is-now-hour'); }
  }
  function scrollToNow(smooth) {
    const el = $('.slot.is-now');
    if (el) el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }

  function paintSel() {
    $$('.is-sel').forEach((e) => e.classList.remove('is-sel'));
    if (sel && state.view === 'day' && sel.date === state.date) {
      const [lo, hi] = selRange();
      $$('.slot').forEach((e) => { const m = +e.dataset.m; if (m >= lo && m <= hi) e.classList.add('is-sel'); });
    } else if (sel && state.view === 'week') {
      const [lo, hi] = selRange();
      $$(`.wk-slot[data-date="${sel.date}"]`).forEach((e) => { const m = +e.dataset.m; if (m >= lo && m <= hi) e.classList.add('is-sel'); });
    }
    renderSelbar();
    renderPopover();
  }

  // ----- Week view inline editor -----
  function renderPopover() {
    const pop = $('#wkpop');
    const anchors = $$('.wk-slot.is-sel');
    if (!sel || state.view !== 'week' || !anchors.length) { pop.hidden = true; pop.innerHTML = ''; return; }
    if (drag) { pop.hidden = true; return; } // wait until the drag finishes
    const ss = selSlots();
    const first = ss[0], last = ss[ss.length - 1];
    const single = ss.length === 1;
    const day = getDay(sel.date);
    const v = single ? ((day && day.slots[first.m]) || {}) : {};
    const statuses = new Set(ss.map((s) => ((day && day.slots[s.m]) || {}).s || ''));
    const common = statuses.size === 1 ? [...statuses][0] : null;
    const hours = [...new Set(ss.map((s) => Math.floor(s.m / 60)))];
    const divs = hours.map((h) => DIVS.indexOf(getDiv(day, h)));
    const canMinus = divs.some((i) => i > 0), canPlus = divs.some((i) => i < DIVS.length - 1);
    const evs = eventsOn(sel.date).filter((ev) => ev.s < last.m + last.L && ev.e > first.m);
    const lens = [...new Set(ss.map((s) => s.L))];

    pop.innerHTML = `
      <div class="pop-head">
        <div><b>${fmt(sel.date, { weekday: 'short', day: 'numeric', month: 'short' })}</b>
          <span class="muted">· ${hm(first.m)}–${hm(last.m + last.L)}${single ? '' : ` · ${ss.length} slots`}</span></div>
        <button class="x-btn" data-pa="close" title="Close (Esc)">✕</button>
      </div>
      ${evs.length ? `<div class="pop-evs">${evs.map((ev) => `<div class="ev" title="${esc(evTip(ev))}">📅 ${hm(ev.s)} ${esc(ev.t)}</div>`).join('')}</div>` : ''}
      <form data-pa-form="text">
        <input id="popText" value="${esc(v.t)}" placeholder="${single ? 'What will you do?' : 'Label all selected slots…'}" autocomplete="off">
      </form>
      <div class="pop-marks">
        <button class="mark g ${common === 'g' ? 'on' : ''}" data-pa="g" title="${STATUS_LABEL.g}">Done</button>
        <button class="mark y ${common === 'y' ? 'on' : ''}" data-pa="y" title="${STATUS_LABEL.y}">Inefficient</button>
        <button class="mark r ${common === 'r' ? 'on' : ''}" data-pa="r" title="${STATUS_LABEL.r}">Missed</button>
        <button data-pa="clear" title="Clear rating">Clear</button>
      </div>
      <div class="pop-foot">
        <span class="grp"><span class="lbl">Slot size ${lens.length === 1 ? lens[0] + 'm' : ''}</span>
          <button data-pa="minus" ${canMinus ? '' : 'disabled'} title="Fewer, longer slots">−</button>
          <button data-pa="plus" ${canPlus ? '' : 'disabled'} title="More, shorter slots">+</button>
        </span>
        <span class="grp">
          ${single ? '' : '<button data-pa="erase" title="Erase text in selected slots">Erase text</button>'}
          ${single ? '' : '<button data-pa="merge" title="Merge into one slot">⇲ Merge</button>'}
          ${single && first.block ? '<button data-pa="split" title="Split back into normal slots">Split</button>' : ''}
          <button data-pa="open" title="Open this in the day view">Day view →</button>
        </span>
      </div>
      <div class="pop-hint muted">${single ? 'Enter: next slot · Esc: close' : 'Enter: apply label · Esc: close'}</div>`;
    pop.hidden = false;
    positionPopover(anchors);
  }
  function positionPopover(anchors) {
    const pop = $('#wkpop');
    if (window.innerWidth <= 600) { pop.style.left = ''; pop.style.top = ''; return; } // bottom sheet via CSS
    const a = anchors[0].getBoundingClientRect(), b = anchors[anchors.length - 1].getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, gap = 8;
    let left = a.right + gap;
    if (left + w > window.innerWidth - 12) left = a.left - w - gap;
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
    let top = (a.top + b.bottom) / 2 - h / 2;
    top = Math.max(70, Math.min(top, window.innerHeight - h - 12));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  function focusPopText() {
    const inp = $('#popText');
    if (inp) { inp.focus(); inp.select(); }
  }
  function closePopover() { sel = null; paintSel(); }

  function renderSelbar() {
    const bar = $('#selbar');
    if (!sel || state.view !== 'day' || sel.date !== state.date) { bar.hidden = true; bar.innerHTML = ''; return; }
    const ss = selSlots();
    if (!ss.length) { bar.hidden = true; return; }
    const first = ss[0], last = ss[ss.length - 1];
    const hours = [...new Set(ss.map((s) => Math.floor(s.m / 60)))];
    const divs = hours.map((h) => DIVS.indexOf(getDiv(getDay(sel.date), h)));
    const canMinus = divs.some((i) => i > 0), canPlus = divs.some((i) => i < DIVS.length - 1);
    const focusedLabel = document.activeElement && document.activeElement.id === 'selLabel';
    if (focusedLabel) return; // don't rebuild while the user is typing a label
    bar.innerHTML = `
      <span class="selbar-info"><b>${ss.length} slot${ss.length > 1 ? 's' : ''}</b> · ${hm(first.m)}–${hm(last.m + last.L)}</span>
      <span class="sep"></span>
      <span class="grp"><span class="lbl">Slot size</span>
        <button data-sa="minus" ${canMinus ? '' : 'disabled'} title="Fewer, longer slots in ${hours.length > 1 ? 'these hours' : 'this hour'} (−)">−</button>
        <button data-sa="plus" ${canPlus ? '' : 'disabled'} title="More, shorter slots in ${hours.length > 1 ? 'these hours' : 'this hour'} (+)">+</button>
      </span>
      <span class="sep"></span>
      <span class="grp">
        <button class="mark g" data-sa="g" title="${STATUS_LABEL.g} (G)">Done</button>
        <button class="mark y" data-sa="y" title="${STATUS_LABEL.y} (Y)">Inefficient</button>
        <button class="mark r" data-sa="r" title="${STATUS_LABEL.r} (R)">Missed</button>
        <button data-sa="clear" title="Clear rating (0)">Clear</button>
      </span>
      <span class="sep"></span>
      ${ss.length > 1 ? '<button data-sa="merge" title="Merge into one slot (M)">⇲ Merge</button>' : ''}
      ${ss.length === 1 && ss[0].block ? '<button data-sa="split" title="Split back into normal slots">Split</button>' : ''}
      <form data-sa-form="label"><input id="selLabel" placeholder="Label all selected…" autocomplete="off"></form>
      <button data-sa="erase" title="Erase text in selected slots">Erase text</button>
      <button data-sa="close" title="Deselect (Esc)">✕</button>`;
    bar.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function go(view, date) {
    if (view) state.view = view;
    if (date) state.date = date;
    render();
  }
  function step(dir) {
    if (state.view === 'day') state.date = addDays(state.date, dir);
    else if (state.view === 'week') state.date = addDays(state.date, 7 * dir);
    else state.date = addYears(state.date, dir);
    render();
  }

  function selResize(dir) {
    if (!sel) return;
    const hours = [...new Set(selSlots().map((s) => Math.floor(s.m / 60)))];
    if (!stepDiv(sel.date, hours, dir)) return;
    const lastHour = hours[hours.length - 1];
    sel = { date: sel.date, a: unitAt(sel.date, hours[0] * 60).m, b: lastUnitInHour(sel.date, lastHour).m };
    render();
  }
  function selSet(patch) {
    if (!sel) return;
    for (const s of selSlots()) setSlot(sel.date, s.m, patch);
    render();
  }

  function addGoal(key, text) {
    text = text.trim();
    if (!text) return;
    ensureDay(key).goals.push({ id: uid(), text, done: false });
    save();
  }
  function toggleGoal(key, id, done) {
    const g = (getDay(key) || { goals: [] }).goals.find((x) => x.id === id);
    if (g) { g.done = done; save(); }
  }
  function deleteGoal(key, id) {
    const day = getDay(key);
    if (!day) return;
    day.goals = day.goals.filter((x) => x.id !== id);
    save();
  }
  function carryGoals(key) {
    const prev = getDay(addDays(key, -1));
    const open = prev ? prev.goals.filter((g) => !g.done) : [];
    if (!open.length) { flash('No unfinished goals on the previous day.'); return; }
    const day = ensureDay(key);
    const existing = new Set(day.goals.map((g) => g.text));
    let n = 0;
    for (const g of open) if (!existing.has(g.text)) { day.goals.push({ id: uid(), text: g.text, done: false }); n++; }
    save();
    render();
    flash(n ? `Carried over ${n} goal${n > 1 ? 's' : ''}.` : 'Those goals are already on this day.');
  }
  function copyLayout(key) {
    const prev = getDay(addDays(key, -1));
    for (let h = 0; h < 24; h++) setDiv(key, h, getDiv(prev, h));
    save();
    normalizeSel();
    render();
    flash('Slot layout copied from the previous day.');
  }

  let flashTimer = null;
  function flash(msg) {
    const el = $('#saveState');
    el.textContent = msg;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.textContent = ''; }, 2500);
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  document.addEventListener('click', (e) => {
    const t = e.target;
    const viewBtn = t.closest('#tabs button');
    if (viewBtn) { go(viewBtn.dataset.view); return; }
    if (t.closest('#prev')) { step(-1); return; }
    if (t.closest('#next')) { step(1); return; }
    if (t.closest('#todayBtn')) {
      go(null, londonNow().date);
      if (state.view === 'day') scrollToNow(true);
      return;
    }

    const sa = t.closest('[data-sa]');
    if (sa && !sa.disabled) {
      const a = sa.dataset.sa;
      if (a === 'minus') selResize(-1);
      else if (a === 'plus') selResize(1);
      else if (a === 'g' || a === 'y' || a === 'r') selSet({ s: a });
      else if (a === 'clear') selSet({ s: '' });
      else if (a === 'erase') selSet({ t: '' });
      else if (a === 'close') { sel = null; paintSel(); }
      else if (a === 'merge') mergeSel();
      else if (a === 'split') splitAt(sel.date, selSlots()[0].m);
      return;
    }

    const pa = t.closest('[data-pa]');
    if (pa && !pa.disabled && sel) {
      const a = pa.dataset.pa;
      if (a === 'g' || a === 'y' || a === 'r') {
        const day = getDay(sel.date);
        const allSame = selSlots().every((s) => ((day && day.slots[s.m]) || {}).s === a);
        selSet({ s: allSame ? '' : a }); // clicking the active colour again clears it
      } else if (a === 'clear') selSet({ s: '' });
      else if (a === 'erase') selSet({ t: '' });
      else if (a === 'minus') selResize(-1);
      else if (a === 'plus') selResize(1);
      else if (a === 'close') closePopover();
      else if (a === 'merge') mergeSel();
      else if (a === 'split') splitAt(sel.date, selSlots()[0].m);
      else if (a === 'open') {
        const m = selRange()[0];
        go('day', sel.date);
        const slot = $(`.slot[data-m="${m}"]`);
        if (slot) slot.scrollIntoView({ block: 'center' });
      }
      return;
    }

    const el = t.closest('[data-act]');
    if (!el || el.tagName === 'FORM' || el.type === 'checkbox') return;
    const act = el.dataset.act;
    const key = el.dataset.date || state.date;
    if (act === 'status') {
      const m = +el.dataset.m;
      const cur = ((getDay(state.date) || { slots: {} }).slots[m] || {}).s;
      setSlot(state.date, m, { s: cur === el.dataset.s ? '' : el.dataset.s });
      const row = el.closest('.slot');
      row.classList.remove('s-g', 's-y', 's-r');
      const now = (getDay(state.date) || { slots: {} }).slots[m];
      if (now && now.s) row.classList.add('s-' + now.s);
      $$('.dot', row).forEach((d) => d.classList.toggle('on', !!now && d.dataset.s === now.s));
      updateSummary();
    } else if (act === 'hminus' || act === 'hplus') {
      stepDiv(state.date, [+el.dataset.h], act === 'hplus' ? 1 : -1);
      normalizeSel();
      render();
    } else if (act === 'ev-fill') {
      const ev = eventsOn(key)[+el.dataset.i];
      if (!ev) return;
      let n = 0;
      for (const u of unitsOverlapping(unitsOfDay(key), ev.s, ev.e)) {
        if (!((getDay(key) || { slots: {} }).slots[u.m] || {}).t) { setSlot(key, u.m, { t: ev.t }); n++; }
      }
      render();
      flash(n ? `Copied “${ev.t}” into ${n} slot${n > 1 ? 's' : ''}.` : 'Those slots already have plans.');
    } else if (act === 'cal-sync') {
      syncCalendar();
    } else if (act === 'split') {
      splitAt(state.date, +el.dataset.m);
    } else if (act === 'edit-cats') {
      fillSettings();
      dlg.showModal();
      const c = $('#catSection');
      if (c) c.scrollIntoView({ block: 'start' });
    } else if (act === 'goal-del') {
      deleteGoal(key, el.dataset.id);
      render();
    } else if (act === 'goal-carry') {
      carryGoals(state.date);
    } else if (act === 'copy-layout') {
      copyLayout(state.date);
    } else if (act === 'jump-now') {
      scrollToNow(true);
    } else if (act === 'open-day') {
      go('day', key);
      if (key === londonNow().date) scrollToNow(false);
      else window.scrollTo(0, 0);
    } else if (act === 'open-slot') {
      const m = el.dataset.m;
      go('day', key);
      const slot = $(`.slot[data-m="${m}"]`);
      if (slot) {
        slot.scrollIntoView({ block: 'center' });
        $('.slot-text', slot).focus({ preventScroll: true });
      }
    }
  });

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-act="goal-toggle"]')) {
      toggleGoal(t.dataset.date, t.dataset.id, t.checked);
      render();
    } else if (t.id === 'datePick' && t.value) {
      go(null, t.value);
    }
  });

  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.matches('[data-act="goal-add"]')) {
      e.preventDefault();
      const key = f.dataset.date || state.date;
      addGoal(key, f.elements.g.value);
      render();
      const again = $(`form[data-act="goal-add"][data-date="${key}"] input`);
      if (again) again.focus();
    } else if (f.matches('[data-pa-form="text"]')) {
      e.preventDefault();
      if (!sel) return;
      const ss = selSlots();
      const v = f.elements[0].value.trim();
      if (ss.length === 1) {
        // single slot: text is already saved as you type – move on to the next slot of that day
        const next = unitsOfDay(sel.date).find((u) => u.m > ss[0].m);
        if (next && Math.floor(next.m / 60) < data.settings.endHour) { sel = { date: sel.date, a: next.m, b: next.m }; render(); focusPopText(); }
        else closePopover();
      } else if (v) {
        selSet({ t: v });
        focusPopText();
      }
    } else if (f.matches('[data-sa-form="label"]')) {
      e.preventDefault();
      const v = f.elements[0].value.trim();
      f.elements[0].blur();
      if (v) selSet({ t: v });
    }
  });

  let summaryTimer = null;
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('slot-text')) {
      setSlot(state.date, +t.dataset.m, { t: t.value });
      clearTimeout(summaryTimer);
      summaryTimer = setTimeout(updateSummary, 400);
    } else if (t.id === 'popText' && sel && selSlots().length === 1) {
      const m = selSlots()[0].m;
      setSlot(sel.date, m, { t: t.value });
      const cell = $(`.wk-slot[data-date="${sel.date}"][data-m="${m}"]`);
      if (cell) {
        cell.classList.toggle('has', !!t.value);
        cell.innerHTML = t.value ? `<span>${esc(t.value)}</span>` : '';
      }
    }
  });

  document.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.wk-slot');
    if (!cell) return;
    sel = { date: cell.dataset.date, a: +cell.dataset.m, b: +cell.dataset.m };
    go('day', cell.dataset.date);
    const slot = $(`.slot[data-m="${cell.dataset.m}"]`);
    if (slot) { slot.scrollIntoView({ block: 'center' }); $('.slot-text', slot).focus({ preventScroll: true }); }
  });

  const repositionPop = () => { if (!$('#wkpop').hidden) positionPopover($$('.wk-slot.is-sel')); };
  window.addEventListener('resize', repositionPop);
  window.addEventListener('scroll', repositionPop, { passive: true });
  document.addEventListener('scroll', repositionPop, { passive: true, capture: true });

  const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('slot-text')) {
      if (e.key === 'Enter' || (e.key === 'ArrowDown' && e.altKey) || (e.key === 'ArrowUp' && e.altKey)) {
        e.preventDefault();
        const all = $$('.slot-text');
        const i = all.indexOf(t) + ((e.shiftKey || e.key === 'ArrowUp') ? -1 : 1);
        if (all[i]) { all[i].focus(); all[i].closest('.slot').scrollIntoView({ block: 'nearest' }); }
      } else if (e.key === 'Escape') t.blur();
      return;
    }
    if (t.id === 'popText') {
      if (e.key === 'Escape') { e.preventDefault(); closePopover(); }
      return;
    }
    if (isTyping(t) || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#settings').open) return;

    if (sel && (state.view === 'day' || state.view === 'week')) {
      const k = e.key.toLowerCase();
      if (k === 'g' || k === 'y' || k === 'r') { selSet({ s: k }); e.preventDefault(); return; }
      if (k === '0' || k === 'backspace' || k === 'delete') { selSet({ s: '' }); e.preventDefault(); return; }
      if (k === '-' || k === '_') { selResize(-1); e.preventDefault(); return; }
      if (k === '+' || k === '=') { selResize(1); e.preventDefault(); return; }
      if (k === 'escape') { sel = null; paintSel(); return; }
      if (k === 'm') { mergeSel(); e.preventDefault(); return; }
    }
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
    else if (e.key.toLowerCase() === 't') { go(null, londonNow().date); if (state.view === 'day') scrollToNow(true); }
    else if (e.key.toLowerCase() === 'd') go('day');
    else if (e.key.toLowerCase() === 'w') go('week');
  });

  // ----- Drag selection (mouse + touch via pointer events) -----
  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    if (state.view === 'week') {
      const cell = e.target.closest('.wk-slot');
      if (!cell) {
        // clicking anywhere outside the editor closes it
        if (sel && !e.target.closest('#wkpop')) closePopover();
        return;
      }
      e.preventDefault();
      const m = +cell.dataset.m, date = cell.dataset.date;
      if (e.shiftKey && sel && sel.date === date) sel.b = m;
      else sel = { date, a: m, b: m };
      drag = { week: true, moved: false };
      paintSel();
      return;
    }
    if (state.view !== 'day') return;
    const t = e.target;
    const hourLabel = t.closest('.hour-label');
    if (hourLabel) {
      e.preventDefault();
      const h = +hourLabel.dataset.h;
      const first = unitAt(state.date, h * 60).m, last = lastUnitInHour(state.date, h).m;
      if (e.shiftKey && sel && sel.date === state.date) {
        const [lo, hi] = selRange();
        sel = first < lo ? { date: state.date, a: hi, b: first } : { date: state.date, a: lo, b: last };
      } else {
        sel = { date: state.date, a: first, b: last };
      }
      drag = { moved: true, hour: true, anchorH: Math.floor(sel.a / 60) }; // sel.a is the fixed end
      paintSel();
      return;
    }
    if (t.closest('input, button, select, textarea, form')) return;
    const slot = t.closest('.slot');
    if (!slot) return;
    e.preventDefault();
    if (document.activeElement && isTyping(document.activeElement)) document.activeElement.blur();
    const m = +slot.dataset.m;
    const same = sel && sel.date === state.date && sel.a === m && sel.b === m;
    if (e.shiftKey && sel && sel.date === state.date) sel.b = m;
    else sel = { date: state.date, a: m, b: m };
    drag = { moved: false, same };
    paintSel();
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag || !sel) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (drag.week) {
      const cell = el && el.closest('.wk-slot');
      if (cell && cell.dataset.date === sel.date && +cell.dataset.m !== sel.b) {
        sel.b = +cell.dataset.m;
        drag.moved = true;
        paintSel();
      }
      if (e.clientY < 90) window.scrollBy(0, -14);
      else if (e.clientY > window.innerHeight - 50) window.scrollBy(0, 14);
      return;
    }
    const slot = el && el.closest('.slot');
    if (slot) {
      const m = +slot.dataset.m;
      if (drag.hour) {
        // dragging from an hour label extends by whole hours
        const hourEl = slot.closest('.hour');
        const h = hourEl ? +hourEl.dataset.h : Math.floor(m / 60);
        const lo = Math.min(drag.anchorH, h), hi = Math.max(drag.anchorH, h);
        sel = { date: state.date, a: unitAt(state.date, lo * 60).m, b: lastUnitInHour(state.date, hi).m };
        paintSel();
      } else if (m !== sel.b) {
        sel.b = m;
        drag.moved = true;
        paintSel();
      }
    }
    // auto-scroll while dragging near the viewport edges
    if (e.clientY < 90) window.scrollBy(0, -14);
    else if (e.clientY > window.innerHeight - 50) window.scrollBy(0, 14);
  });

  const endDrag = () => {
    if (!drag) return;
    if (drag.week) {
      drag = null;
      renderPopover();
      focusPopText();
      return;
    }
    if (!drag.moved && drag.same) { sel = null; paintSel(); }
    drag = null;
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);

  // ----- Settings -----
  const dlg = $('#settings');
  function fillSettings() {
    const s = data.settings;
    $('#setDefault').value = String(s.defaultSlots);
    $('#setStart').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hm(h * 60)}</option>`).join('');
    $('#setEnd').innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}">${hm((i + 1) * 60)}</option>`).join('');
    $('#setStart').value = String(s.startHour);
    $('#setEnd').value = String(s.endHour);
    $('#icsUrl').value = cal.url || '';
    $('#setMerge').checked = !!s.mergeEvents;
    renderCatList();
    updateCalStatus();
  }

  // ----- Category editor -----
  function renderCatList() {
    const cats = data.settings.categories;
    $('#catList').innerHTML = cats.map((c, i) => `
      <div class="cat-row" data-i="${i}">
        <input type="color" data-f="color" value="${esc(c.color)}" title="Colour">
        <div class="cat-fields">
          <input data-f="name" value="${esc(c.name)}" placeholder="Category name" autocomplete="off">
          <input data-f="kw" value="${esc(c.kw)}" placeholder="Keywords, comma separated" autocomplete="off">
        </div>
        <div class="cat-btns">
          <button type="button" class="mini" data-cat="up" ${i === 0 ? 'disabled' : ''} title="Move up (checked earlier)">↑</button>
          <button type="button" class="mini" data-cat="del" title="Delete category">×</button>
        </div>
      </div>`).join('') + `
      <div class="cat-row other">
        <input type="color" data-f="other" value="${esc(data.settings.otherColor)}" title="Colour">
        <div class="cat-fields"><span>Other <span class="muted small">(no keyword matched)</span></span></div>
      </div>`;
  }
  let catRenderTimer = null;
  function categoriesChanged() {
    resetCategoryCache();
    save();
    clearTimeout(catRenderTimer);
    catRenderTimer = setTimeout(render, 250);
  }
  $('#catList').addEventListener('input', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    if (f === 'other') { data.settings.otherColor = e.target.value; categoriesChanged(); return; }
    const row = e.target.closest('.cat-row');
    const c = data.settings.categories[+row.dataset.i];
    if (!c) return;
    c[f] = e.target.value;
    categoriesChanged();
  });
  $('#catList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]');
    if (!b || b.disabled) return;
    const i = +b.closest('.cat-row').dataset.i;
    const cats = data.settings.categories;
    if (b.dataset.cat === 'del') cats.splice(i, 1);
    else if (b.dataset.cat === 'up' && i > 0) [cats[i - 1], cats[i]] = [cats[i], cats[i - 1]];
    renderCatList();
    categoriesChanged();
  });
  $('#catAdd').addEventListener('click', () => {
    const palette = ['#2f9e8f', '#9c36b5', '#f08c00', '#5c940d', '#c2255c', '#3b5bdb', '#495057'];
    data.settings.categories.push({ id: uid(), name: 'New category', color: palette[data.settings.categories.length % palette.length], kw: '' });
    renderCatList();
    categoriesChanged();
    const rows = $$('#catList .cat-row:not(.other)');
    const name = rows.length && $('input[data-f="name"]', rows[rows.length - 1]);
    if (name) { name.focus(); name.select(); }
  });
  $('#catReset').addEventListener('click', () => {
    if (!confirm('Reset categories to the defaults? Your custom categories will be removed.')) return;
    data.settings.categories = defaultCategories();
    data.settings.otherColor = '#868e96';
    renderCatList();
    categoriesChanged();
  });
  $('#setMerge').addEventListener('change', (e) => {
    data.settings.mergeEvents = e.target.checked;
    save();
    if (sel) normalizeSel();
    render();
  });
  // Enter inside a settings text field shouldn't close the dialog
  $('#settings').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.id !== 'icsUrl') e.preventDefault();
  });
  $('#icsSave').addEventListener('click', async () => {
    const url = $('#icsUrl').value.trim();
    if (!url) { $('#icsStatus').textContent = 'Paste your Outlook ICS link first.'; return; }
    if (url !== cal.url) cal = { url, fetchedAt: 0, error: '', byDate: {}, allDay: {} };
    saveCal();
    await syncCalendar();
  });
  $('#icsUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#icsSave').click(); } });
  $('#icsRemove').addEventListener('click', () => {
    cal = { url: '', fetchedAt: 0, error: '', byDate: {}, allDay: {} };
    saveCal();
    $('#icsUrl').value = '';
    updateCalStatus();
    render();
  });
  $('#settingsBtn').addEventListener('click', () => { fillSettings(); dlg.showModal(); });
  $('#setDefault').addEventListener('change', (e) => { data.settings.defaultSlots = +e.target.value; save(); render(); });
  function setHours() {
    let a = +$('#setStart').value, b = +$('#setEnd').value;
    if (b <= a) { b = Math.min(24, a + 1); $('#setEnd').value = String(b); }
    data.settings.startHour = a;
    data.settings.endHour = b;
    save();
    render();
  }
  $('#setStart').addEventListener('change', setHours);
  $('#setEnd').addEventListener('change', setHours);

  $('#exportBtn').addEventListener('click', () => {
    flush();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `planner365-backup-${londonNow().date}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  });
  $('#importBtn').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      if (!parsed || typeof parsed.days !== 'object') throw new Error('Not a planner backup');
      const n = Object.keys(parsed.days).length;
      if (!confirm(`Replace all current data with this backup (${n} day${n === 1 ? '' : 's'})?`)) return;
      data = normalize(parsed);
      resetCategoryCache();
      sel = null;
      flush();
      fillSettings();
      render();
      flash('Backup imported.');
    } catch (err) {
      alert('Could not import that file: ' + err.message);
    }
  });
  $('#wipeBtn').addEventListener('click', () => {
    if (!confirm('Delete ALL planner data in this browser? Export a backup first if unsure.')) return;
    data = normalize(null);
    resetCategoryCache();
    sel = null;
    flush();
    fillSettings();
    render();
  });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  render();
  if (state.view === 'day') scrollToNow(false);
  setInterval(paintNow, 1000);
  if (cal.url && Date.now() - (cal.fetchedAt || 0) > 60 * 1000) syncCalendar();
  setInterval(() => { if (cal.url) syncCalendar(); }, CAL_REFRESH_MS);
})();
