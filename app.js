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
  const ATTEND_LABEL = { g: 'Attended', r: 'Missed' };

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
  const validKey = (k) => /^\d{4}-\d{2}-\d{2}$/.test(k || '');

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
      { id: 'lecture', name: 'Lecture', color: '#7048e8', attend: true, kw: 'lecture, lec, seminar, tutorial, workshop, lab, class, module, practical' },
      { id: 'meeting', name: 'Meeting', color: '#1971c2', attend: true, kw: 'meeting, call, sync, stand-up, standup, 1:1, interview, catch up, catch-up, review, teams' },
      { id: 'study', name: 'Study', color: '#0c8599', attend: false, kw: 'study, revision, revise, exam, assignment, coursework, homework, reading, deadline, essay' },
      { id: 'exercise', name: 'Exercise', color: '#e8590c', attend: false, kw: 'gym, run, workout, football, yoga, swim, training, tennis, climbing, walk' },
      { id: 'social', name: 'Social', color: '#d6336c', attend: true, kw: 'dinner, lunch, drinks, party, birthday, coffee, brunch, date' },
      { id: 'personal', name: 'Personal', color: '#8d6e63', attend: true, kw: 'dentist, doctor, gp, appointment, haircut, bank, errand, travel, flight, train' },
    ];
  }
  // Categories saved before the attendance option existed: events default to attendance,
  // except study/exercise-type categories, which keep the done/inefficient/missed rating.
  const defaultAttend = (c) => !['study', 'exercise'].includes(c.id);
  function defaultReady() {
    return [
      ['📧', 'Read emails', 30], ['🥣', 'Breakfast', 30], ['🥗', 'Lunch', 45], ['🍝', 'Dinner', 45],
      ['☕', 'Take a break', 15], ['🧠', 'Deep work', 90], ['🏃', 'Exercise', 60], ['📚', 'Study', 60],
      ['🚌', 'Commute', 30], ['🚶', 'Walk', 30], ['🧹', 'Chores', 30], ['📝', 'Plan tomorrow', 15],
    ].map(([icon, t, dur], i) => ({ id: 'r' + i, icon, t, dur }));
  }
  const reflHas = (r) => !!(r && (r.mood || r.energy || (r.note && r.note.trim())));
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
    const res = found || { id: 'other', name: 'Other', color: data.settings.otherColor, attend: data.settings.otherAttend };
    catCache.set(cacheKey, res);
    return res;
  }
  const evStyle = (ev) => `--evc:${esc(categoryOf(ev).color)}`;

  // ---------------------------------------------------------------------------
  // Outlook calendar state (ICS feed relayed through server.py / api/ics.js).
  // Kept separate from planner data so backups don't contain the private link.
  // ---------------------------------------------------------------------------
  const CAL_STORE = 'planner365.cal';
  const CAL_REFRESH_MS = 15 * 60 * 1000;
  let cal = { url: '', fetchedAt: 0, error: '', byDate: {}, allDay: {} };
  try { cal = { ...cal, ...(JSON.parse(localStorage.getItem(CAL_STORE)) || {}) }; } catch (e) { /* ignore */ }
  const saveCal = () => { try { localStorage.setItem(CAL_STORE, JSON.stringify(cal)); } catch (e) { /* quota */ } };
  let calSyncing = false;

  // Events for a day, with your renames applied. A renamed event keeps its Outlook title in
  // `ot`, which stays its identity (so ratings survive a rename). Cached per day so the same
  // objects are returned until the calendar or a rename changes.
  const evCache = new Map();
  const resetEvCache = () => evCache.clear();
  function eventsOn(key) {
    if (evCache.has(key)) return evCache.get(key);
    const per = (data.days[key] && data.days[key].evt) || {};
    const glob = data.settings.evRename || {};
    const list = (cal.byDate[key] || []).map((ev) => {
      const t = per[`${ev.s}-${ev.e}-${ev.t}`] || glob[ev.t] || ev.t;
      return t === ev.t ? ev : { ...ev, t, ot: ev.t };
    });
    evCache.set(key, list);
    return list;
  }
  const allDayOn = (key) => (cal.allDay[key] || []).map((ev) => {
    const t = (data.settings.evRename || {})[ev.t];
    return t ? { ...ev, t, ot: ev.t } : ev;
  });
  const eventsIn = (key, m, L) => eventsOn(key).filter((ev) => ev.s < m + L && ev.e > m);
  const evTip = (ev) => `${hm(ev.s)}–${hm(ev.e)} · ${ev.t}${ev.ot ? ` (Outlook: ${ev.ot})` : ''}${ev.loc ? ' · ' + ev.loc : ''}`;
  const evKey = (ev) => `${ev.s}-${ev.e}-${ev.ot || ev.t}`;
  const evPart = (ev) => !!categoryOf(ev).attend; // rated Attended / Missed

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  // Day record: { base, div, goals, blocks (manual merges), split (events not merged),
  //               items: [{ id, s, e, t, st }]  – tasks with their own time window,
  //               evr: { eventKey: status }      – ratings of Outlook events }
  function normalize(d) {
    d = d && typeof d === 'object' ? d : {};
    d.settings = { defaultSlots: 4, startHour: 6, endHour: 24, mergeEvents: true, otherColor: '#868e96', ...(d.settings || {}) };
    if (!DIVS.includes(+d.settings.defaultSlots)) d.settings.defaultSlots = 4;
    if (!Array.isArray(d.settings.categories)) d.settings.categories = defaultCategories();
    d.settings.notify = { on: false, scope: 'all', sound: true, ...(d.settings.notify || {}) };
    if (!d.settings.evRename || typeof d.settings.evRename !== 'object') d.settings.evRename = {};
    // repeating tasks: [{ id, t, s, e, freq, anchor, start, until }]
    d.series = Array.isArray(d.series) ? d.series.filter((x) => x && x.id && x.e > x.s && validKey(x.start)) : [];
    // unscheduled to-dos: [{ id, t, dur }]
    d.inbox = Array.isArray(d.inbox) ? d.inbox.filter((x) => x && x.id) : [];
    // reusable "ready tasks" to drag into the day: [{ id, t, dur, icon }]
    d.ready = Array.isArray(d.ready) ? d.ready.filter((x) => x && x.id) : defaultReady();
    // day templates: [{ id, name, items: [{ s, e, t }], div, base }]
    d.templates = Array.isArray(d.templates) ? d.templates.filter((x) => x && x.id) : [];
    for (const c of d.settings.categories) if (typeof c.attend !== 'boolean') c.attend = defaultAttend(c);
    if (typeof d.settings.otherAttend !== 'boolean') d.settings.otherAttend = true;
    d.days = d.days && typeof d.days === 'object' ? d.days : {};
    for (const k of Object.keys(d.days)) {
      const x = d.days[k];
      if (!x || typeof x !== 'object' || !validKey(k)) { delete d.days[k]; continue; }
      x.div = x.div || {};
      x.goals = Array.isArray(x.goals) ? x.goals : [];
      x.blocks = x.blocks && typeof x.blocks === 'object' ? x.blocks : {};
      x.split = Array.isArray(x.split) ? x.split : [];
      x.items = Array.isArray(x.items) ? x.items.filter((i) => i && i.id && i.e > i.s) : [];
      x.evr = x.evr && typeof x.evr === 'object' ? x.evr : {};
      x.evt = x.evt && typeof x.evt === 'object' ? x.evt : {}; // renamed single events
      x.sro = x.sro && typeof x.sro === 'object' ? x.sro : {}; // per-date changes to repeating tasks
      x.refl = x.refl && typeof x.refl === 'object' ? x.refl : {}; // reflection: { mood, energy, note }
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
      if (!x.items.length && !x.goals.length && !Object.keys(x.div).length && !Object.keys(x.blocks).length &&
          !x.split.length && !Object.keys(x.evr).length && !Object.keys(x.evt || {}).length && !Object.keys(x.sro || {}).length && !reflHas(x.refl) && !x.slots && !x.subs) delete data.days[k];
    }
    try {
      localStorage.setItem(STORE, JSON.stringify(data));
      setSaveState('saved');
      try { schedulePush(); } catch (e) { /* sync not ready yet */ }
    } catch (e) {
      setSaveState('error');
    }
  }
  window.addEventListener('beforeunload', () => { if (saveTimer) flush(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden && saveTimer) flush(); });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // ---------------------------------------------------------------------------
  // Grid & data model
  // ---------------------------------------------------------------------------
  const getDay = (key) => data.days[key];
  function ensureDay(key) {
    if (!data.days[key]) data.days[key] = { base: data.settings.defaultSlots, div: {}, goals: [], blocks: {}, split: [], items: [], evr: {}, evt: {} };
    if (!data.days[key].evt) data.days[key].evt = {};
    if (!data.days[key].sro) data.days[key].sro = {};
    if (!data.days[key].refl) data.days[key].refl = {};
    return data.days[key];
  }
  const getDiv = (day, h) => (day && day.div[h]) || (day && day.base) || data.settings.defaultSlots;
  function slotsOf(day, h) {
    const n = getDiv(day, h), L = 60 / n;
    return Array.from({ length: n }, (_, i) => ({ m: h * 60 + i * L, L }));
  }
  function gridBoundsOf(day) {
    const b = [];
    for (let h = 0; h < 24; h++) for (const s of slotsOf(day, h)) b.push(s.m);
    b.push(1440);
    return b;
  }
  const gridBounds = (key) => gridBoundsOf(getDay(key));

  // ----- Converting data from the earlier "one task per slot" format -----
  const MAX_MERGE_MIN = 4 * 60; // longer events (e.g. "working hours") are not merged
  function migrateDay(key, x) {
    if (!x.slots && !x.subs && !x.subOpen) return false;
    // the old layout: manual merges + Outlook events (overlaps dropped), grid slots elsewhere
    const blocks = [];
    for (const [s, e] of Object.entries(x.blocks || {})) blocks.push({ s: +s, e: +e, manual: true });
    if (data.settings.mergeEvents) {
      const split = new Set(x.split || []);
      for (const ev of eventsOn(key)) {
        const len = ev.e - ev.s;
        if (len > 0 && len <= MAX_MERGE_MIN && !split.has(`${ev.s}-${ev.e}`)) blocks.push({ s: ev.s, e: ev.e, ev });
      }
    }
    blocks.sort((a, b) => (b.manual ? 1 : 0) - (a.manual ? 1 : 0) || a.s - b.s || b.e - a.e);
    const kept = [];
    for (const b of blocks) if (!kept.some((k) => b.s < k.e && b.e > k.s)) kept.push(b);
    const bounds = gridBoundsOf(x);
    const nextBound = (m) => bounds.find((v) => v > m) ?? 1440;
    for (const [ms, v] of Object.entries(x.slots || {})) {
      const m = +ms;
      if (!v || (!v.t && !v.s)) continue;
      const b = kept.find((k) => k.s <= m && m < k.e);
      if (b && b.ev && b.s === m) {
        // a rating / note on an Outlook event slot
        if (v.s) x.evr[evKey(b.ev)] = v.s;
        if (v.t) x.items.push({ id: uid(), s: b.s, e: b.e, t: v.t, st: '' });
      } else {
        const nextBlock = kept.find((k) => k.s > m);
        const e = b ? b.e : Math.min(nextBound(m), nextBlock ? nextBlock.s : 1440);
        x.items.push({ id: uid(), s: m, e, t: v.t || '', st: v.s || '' });
      }
    }
    for (const [ms, v] of Object.entries(x.subs || {})) { // old sub-tasks become normal tasks
      const m = +ms;
      if (!v || (!v.t && !v.s)) continue;
      const b = kept.find((k) => k.s <= m && m < k.e);
      x.items.push({ id: uid(), s: m, e: Math.min(nextBound(m), b ? b.e : 1440), t: v.t || '', st: v.s || '' });
    }
    delete x.slots; delete x.subs; delete x.subOpen;
    return true;
  }
  function migrateAll() {
    let changed = false;
    for (const k of Object.keys(data.days)) if (migrateDay(k, data.days[k])) changed = true;
    return changed;
  }
  if (migrateAll()) save();

  // ----- Tasks (items) -----
  // A day's tasks = its own tasks + occurrences of repeating tasks. An occurrence has the id
  // "r:<seriesId>:<date>"; its rating / time changes / removal are stored per date in day.sro.
  const REPEAT_LABEL = { daily: 'Every day', weekdays: 'Every weekday', weekly: 'Weekly', biweekly: 'Every 2 weeks', monthly: 'Monthly' };
  const occId = (sid, key) => `r:${sid}:${key}`;
  const parseOcc = (id) => { const m = /^r:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(id || ''); return m ? { sid: m[1], key: m[2] } : null; };
  const findSeries = (sid) => data.series.find((x) => x.id === sid);
  function occursOn(sr, key) {
    if (key < sr.start || (sr.until && key > sr.until)) return false;
    const anchor = sr.anchor || sr.start;
    const days = Math.round((parseKey(key) - parseKey(anchor)) / 864e5);
    switch (sr.freq) {
      case 'daily': return true;
      case 'weekdays': return dow(key) < 5;
      case 'weekly': return dow(key) === dow(anchor);
      case 'biweekly': return dow(key) === dow(anchor) && ((Math.floor(days / 7) % 2) + 2) % 2 === 0;
      case 'monthly': return key.slice(8) === anchor.slice(8);
      default: return false;
    }
  }
  function occurrencesOn(key) {
    if (!data.series.length) return [];
    const sro = (getDay(key) || {}).sro || {};
    const out = [];
    for (const sr of data.series) {
      if (!occursOn(sr, key)) continue;
      const o = sro[sr.id] || {};
      if (o.skip) continue;
      out.push({ id: occId(sr.id, key), sid: sr.id, rec: true, t: sr.t, s: o.s ?? sr.s, e: o.e ?? sr.e, st: o.st || '', moved: o.s != null });
    }
    return out;
  }
  const itemsOf = (key) => [...((getDay(key) || {}).items || []), ...occurrencesOn(key)];
  const findItem = (key, id) => itemsOf(key).find((i) => i.id === id);
  function addItem(key, s, e, patch) {
    const it = { id: uid(), s, e, t: '', st: '', ...(patch || {}) };
    ensureDay(key).items.push(it);
    save();
    return it;
  }
  function updateItem(key, id, patch) {
    const occ = parseOcc(id);
    if (occ) {
      const sr = findSeries(occ.sid);
      if (!sr) return null;
      const { t, ...rest } = patch;
      if (t !== undefined) sr.t = t; // the text is shared by every occurrence
      if (Object.keys(rest).length) {
        const day = ensureDay(key);
        day.sro[sr.id] = { ...(day.sro[sr.id] || {}), ...rest };
      }
      save();
      return findItem(key, id);
    }
    const it = ((getDay(key) || {}).items || []).find((i) => i.id === id);
    if (it) { Object.assign(it, patch); save(); }
    return it;
  }
  function removeItem(key, id) {
    const occ = parseOcc(id);
    if (occ) { // remove just this date's occurrence; the series continues
      const day = ensureDay(key);
      day.sro[occ.sid] = { ...(day.sro[occ.sid] || {}), skip: true };
      save();
      return;
    }
    const day = getDay(key);
    if (!day) return;
    day.items = day.items.filter((i) => i.id !== id);
    save();
  }
  const evStatus = (key, ev) => ((getDay(key) || {}).evr || {})[evKey(ev)] || '';
  function setEvStatus(key, ev, st) {
    const day = ensureDay(key);
    if (st) day.evr[evKey(ev)] = st; else delete day.evr[evKey(ev)];
    save();
  }

  // ----- Slots ("units") -----
  // A day's slots are the per-hour grid slots, except where something spans more: a task stretched
  // over several slots, an Outlook event, or a manual merge. Overlapping ones join into one slot box
  // and everything inside it is shown side by side.
  function clustersOf(key) {
    const day = getDay(key);
    const cand = [];
    if (day) for (const [s, e] of Object.entries(day.blocks)) cand.push({ s: +s, e: +e, manual: true });
    if (data.settings.mergeEvents) {
      const split = new Set(day ? day.split : []);
      for (const ev of eventsOn(key)) {
        const len = ev.e - ev.s;
        if (len <= 0 || len > MAX_MERGE_MIN || split.has(`${ev.s}-${ev.e}`)) continue;
        cand.push({ s: ev.s, e: ev.e, ev });
      }
    }
    for (const it of itemsOf(key)) cand.push({ s: it.s, e: it.e, item: it });
    cand.sort((a, b) => a.s - b.s || b.e - a.e);
    const out = [];
    for (const c of cand) {
      let cl = out[out.length - 1];
      if (cl && c.s < cl.e) cl.e = Math.max(cl.e, c.e);
      else { cl = { s: c.s, e: c.e, manual: false, evs: [], items: [] }; out.push(cl); }
      if (c.manual) cl.manual = true;
      if (c.ev) cl.evs.push(c.ev);
      if (c.item) cl.items.push(c.item);
    }
    return out;
  }
  function unitsOfDay(key) { return buildUnits(key, clustersOf(key)); }
  // Background slots of the day-view time grid: the grid plus manual merges only
  // (tasks and events are drawn on top as their own blocks).
  function bgUnitsOfDay(key) {
    const day = getDay(key);
    const cl = day ? Object.entries(day.blocks).map(([s, e]) => ({ s: +s, e: +e, manual: true, evs: [], items: [] })).sort((a, b) => a.s - b.s) : [];
    return buildUnits(key, cl);
  }
  // The slots that selection / arrow keys move through in the current view
  const viewUnits = (key) => bgUnitsOfDay(key);
  const viewUnitAt = (key, minute) => viewUnits(key).find((u) => u.m <= minute && minute < u.m + u.L);
  function buildUnits(key, clusters) {
    const bounds = gridBounds(key);
    const isGridSlot = (c) => { const i = bounds.indexOf(c.s); return i >= 0 && bounds[i + 1] === c.e; };
    const units = [];
    let t = 0, ci = 0, gi = 0;
    while (t < 1440) {
      while (ci < clusters.length && clusters[ci].e <= t) ci++;
      const c = clusters[ci];
      if (c && c.s <= t) {
        const items = [...c.items].sort((a, b) => a.s - b.s || a.e - b.e);
        // "block" = a merged box (longer than one grid slot, an event, or a manual merge)
        const block = c.manual || c.evs.length || !isGridSlot(c) ? c : null;
        units.push({ m: t, L: c.e - t, block, items, evs: c.evs });
        t = c.e; ci++;
        continue;
      }
      while (bounds[gi] <= t) gi++;
      const end = Math.min(bounds[gi], c ? c.s : 1440);
      units.push({ m: t, L: end - t, block: null, items: [], evs: [] });
      t = end;
    }
    return units;
  }
  const unitsOverlapping = (units, from, to) => units.filter((u) => u.m < to && u.m + u.L > from);
  const unitAt = (key, minute) => unitsOfDay(key).find((u) => u.m <= minute && minute < u.m + u.L);
  const lastUnitInHour = (key, h) => { const us = unitsOverlapping(viewUnits(key), h * 60, h * 60 + 60); return us[us.length - 1]; };
  const looseEvents = (key, u) => eventsIn(key, u.m, u.L).filter((ev) => !u.evs.includes(ev)); // long / split events

  // Change the number of slots in an hour (tasks keep their own times).
  function setDiv(key, h, n) {
    const day = ensureDay(key);
    if (n === getDiv(day, h)) return;
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
    for (const it of itemsOf(key)) {
      const L = it.e - it.s;
      if (it.st) r[it.st] += L;
      else if (it.t) r.unrated += L;
      if (it.t) r.planned += L;
    }
    if (!day) return r;
    if (Object.keys(day.evr).length) {
      for (const ev of eventsOn(key)) { const st = day.evr[evKey(ev)]; if (st) r[st] += ev.e - ev.s; }
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
  let sel = null;          // selected slots: { date, a, b } (slot start minutes)
  let activeItem = null;   // the task being edited: { date, id }
  let activeEvent = null;  // the event being edited in the week view: { date, i }
  let drag = null;         // active pointer gesture

  const selRange = () => [Math.min(sel.a, sel.b), Math.max(sel.a, sel.b)];
  function selSlots() {
    if (!sel) return [];
    const [lo, hi] = selRange();
    return viewUnits(sel.date).filter((u) => u.m >= lo && u.m <= hi);
  }
  const selSpan = () => { const ss = selSlots(); return ss.length ? [ss[0].m, ss[ss.length - 1].m + ss[ss.length - 1].L] : null; };
  function normalizeSel() {
    if (!sel) return;
    const [lo, hi] = selRange();
    sel = { date: sel.date, a: viewUnitAt(sel.date, lo).m, b: viewUnitAt(sel.date, hi).m };
  }
  function clearFocus() { sel = null; activeItem = null; activeEvent = null; }
  function setActiveItem(date, id) { sel = null; activeEvent = null; activeItem = { date, id }; }

  // Merge the selected slots into one, or split a merged slot back into the grid.
  function mergeSel() {
    const ss = selSlots();
    if (ss.length < 2) return;
    const key = sel.date;
    checkpoint([key]);
    const day = ensureDay(key);
    const s = ss[0].m, e = ss[ss.length - 1].m + ss[ss.length - 1].L;
    for (const k of Object.keys(day.blocks)) if (+k >= s && +k < e) delete day.blocks[k];
    day.blocks[s] = e;
    save();
    sel = { date: key, a: s, b: s };
    render();
  }
  function splitAt(key, m) {
    const u = bgUnitsOfDay(key).find((x) => x.m === m);
    if (!u || !u.block) return;
    checkpoint([key]);
    const day = ensureDay(key);
    for (const k of Object.keys(day.blocks)) if (+k >= u.m && +k < u.m + u.L) delete day.blocks[k];
    save();
    if (sel && sel.date === key) normalizeSel();
    render();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  // Tasks added with "+" (or by typing) that are left empty once you move on are removed again.
  const freshItems = new Map(); // id -> date
  function pruneEmpty() {
    let removed = false;
    for (const [id, key] of freshItems) {
      const it = findItem(key, id);
      if (!it || it.t || it.st) { freshItems.delete(id); continue; }
      if (activeItem && activeItem.id === id) continue; // still being edited
      if (drag && (drag.id === id || (drag.from && drag.from.ids.includes(id)))) continue;
      removeItem(key, id);
      freshItems.delete(id);
      removed = true;
    }
    return removed;
  }

  function render() {
    resetEvCache();
    pruneEmpty();
    $$('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === state.view));
    $('#datePick').value = state.date;
    $('#quickAddWrap').hidden = state.view === 'year';
    if (activeItem && !findItem(activeItem.date, activeItem.id)) activeItem = null;
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
      actions += '<button class="btn" data-act="templates" title="Save this day as a template, or apply one">📋 Templates</button>';
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

  // ----- Rating controls -----
  function dotsHTML(cur, act, attrs) {
    return `<span class="status">${['g', 'y', 'r'].map((c) =>
      `<button class="dot dot-${c} ${cur === c ? 'on' : ''}" data-act="${act}" data-s="${c}" ${attrs} title="${STATUS_LABEL[c]}" aria-label="${STATUS_LABEL[c]}"></button>`).join('')}</span>`;
  }
  function attendHTML(cur, attrs, compact) {
    return `<span class="status attend">${['g', 'r'].map((c) =>
      `<button class="att att-${c} ${cur === c ? 'on' : ''}" data-act="ev-status" data-s="${c}" ${attrs} title="${ATTEND_LABEL[c]}">${c === 'g' ? '✓' : '✗'}${compact ? '' : c === 'g' ? ' Attended' : ' Missed'}</button>`).join('')}</span>`;
  }

  // ----- Day view: a time grid, like a calendar -----
  // Time runs top to bottom at a fixed scale. Background rows are your slots (per-hour slot
  // length); every task and event is drawn on top as ONE block from its start to its end.
  // Things that overlap share the width in columns; a thin strip on the right always stays
  // free so you can click beside a long event to add something next to it.
  const PPM = 2.4; // pixels per minute (15 min ≈ 36px)
  const dayRange = () => [data.settings.startHour * 60, data.settings.endHour * 60];

  // Lay out overlapping blocks in columns (Google Calendar style).
  function layoutBlocks(key) {
    const [lo, hi] = dayRange();
    const list = [];
    eventsOn(key).forEach((ev, i) => { if (ev.e > lo && ev.s < hi && ev.e > ev.s) list.push({ kind: 'event', s: ev.s, e: ev.e, ev, i }); });
    itemsOf(key).forEach((it) => { if (it.e > lo && it.s < hi) list.push({ kind: 'item', s: it.s, e: it.e, it }); });
    list.sort((a, b) => a.s - b.s || (b.e - b.s) - (a.e - a.s) || (a.kind === 'event' ? -1 : 1));
    const groups = [];
    let cur = null, curEnd = -1;
    for (const b of list) {
      if (!cur || b.s >= curEnd) { cur = []; groups.push(cur); curEnd = b.e; } else curEnd = Math.max(curEnd, b.e);
      cur.push(b);
    }
    for (const g of groups) {
      const cols = [];
      for (const b of g) {
        let c = cols.findIndex((col) => col[col.length - 1].e <= b.s);
        if (c < 0) { c = cols.length; cols.push([]); }
        cols[c].push(b);
        b.col = c;
      }
      for (const b of g) {
        // stretch into columns to the right that are free for this block's whole time
        let span = 1;
        for (let c = b.col + 1; c < cols.length; c++) {
          if (cols[c].some((o) => o.s < b.e && o.e > b.s)) break;
          span++;
        }
        b.ncols = cols.length;
        b.span = span;
      }
    }
    return list;
  }
  function blockGeom(b) {
    const [lo, hi] = dayRange();
    const s = Math.max(b.s, lo), e = Math.min(b.e, hi);
    const top = (s - lo) * PPM, h = Math.max((e - s) * PPM - 2, 18);
    const left = `calc(var(--tg-left) + (100% - var(--tg-left) - var(--tg-gutter)) * ${b.col / b.ncols})`;
    const width = `calc((100% - var(--tg-left) - var(--tg-gutter)) * ${b.span / b.ncols} - 3px)`;
    return { style: `top:${top}px;height:${h}px;left:${left};width:${width};`, h };
  }
  const sizeClass = (h) => (h < 30 ? 'xs' : h < 56 ? 'short' : 'tall');

  function itemBlockHTML(key, b) {
    const it = b.it;
    const g = blockGeom(b);
    const active = activeItem && activeItem.date === key && activeItem.id === it.id;
    return `<div class="tblock item ${it.st ? 's-' + it.st : ''} ${sizeClass(g.h)} ${active ? 'active' : ''}" data-id="${it.id}" style="${g.style}" title="${hm(it.s)}–${hm(it.e)}${it.t ? ' · ' + esc(it.t) : ''}">
      <div class="rz rz-top" data-id="${it.id}" data-rz="s" title="Drag to change the start"></div>
      <div class="tb-row">
        <span class="grip" data-id="${it.id}" title="Drag to move">⠿</span>${it.rec ? `<span class="rec-ico" title="Repeats: ${esc(REPEAT_LABEL[(findSeries(it.sid) || {}).freq] || '')}">↻</span>` : ''}
        <input class="item-text" data-id="${it.id}" value="${esc(it.t)}" placeholder="Task…" aria-label="Task ${hm(it.s)}–${hm(it.e)}" autocomplete="off">
        ${dotsHTML(it.st, 'item-status', `data-id="${it.id}"`)}
      </div>
      <div class="tb-time">${hm(it.s)}–${hm(it.e)} · ${dur(it.e - it.s)}</div>
      <button class="tb-more" data-act="item-menu" data-id="${it.id}" title="Time & repeat options" aria-label="Task options">⋯</button>
      <button class="del-x" data-act="item-del" data-id="${it.id}" title="Remove this task" aria-label="Remove task">×</button>
      <div class="rz rz-bottom" data-id="${it.id}" data-rz="e" title="Drag to change the end"></div>
    </div>`;
  }
  function eventBlockHTML(key, b) {
    const ev = b.ev;
    const g = blockGeom(b);
    const st = evStatus(key, ev);
    const attrs = `data-ei="${b.i}"`;
    const compact = b.ncols > 1 || g.h < 56;
    // the title sits in the middle of the block, however long the event is
    return `<div class="tblock event ${st ? 's-' + st : ''} ${sizeClass(g.h)}" data-ei="${b.i}" style="${g.style}${evStyle(ev)}" title="${esc(evTip(ev))} · ${esc(categoryOf(ev).name)}">
      <div class="ev-center">
        <span class="ev-title" title="Double-click to rename">${esc(ev.t)}</span>
        <span class="tb-time">${hm(ev.s)}–${hm(ev.e)}${ev.loc ? ' · ' + esc(ev.loc) : ''} · ${esc(categoryOf(ev).name)}</span>
      </div>
      <div class="ev-controls">
        ${evPart(ev) ? attendHTML(st, attrs, compact) : dotsHTML(st, 'ev-status', attrs)}
        <button class="ev-edit" data-act="ev-rename" data-ei="${b.i}" title="Rename this event">✎</button>
        <button class="add-beside" data-act="add-beside" data-ei="${b.i}" title="Add a task alongside this event">+</button>
      </div>
    </div>`;
  }

  function renderDay() {
    const key = state.date, day = getDay(key);
    const [lo, hi] = dayRange();
    const { startHour: sh, endHour: eh } = data.settings;
    let html = '<div class="day-layout"><section class="timeline tgrid-wrap" id="timeline">';
    const ad = allDayOn(key);
    if (ad.length) html += `<div class="allday"><span class="allday-lbl">All day</span>${ad.map((e) => `<span class="ev" style="${evStyle(e)}">${esc(e.t)}</span>`).join('')}</div>`;
    // hour labels with the slot-length controls
    let hours = '';
    for (let h = sh; h < eh; h++) {
      const n = getDiv(day, h), i = DIVS.indexOf(n);
      hours += `<div class="tg-hour" data-h="${h}" style="top:${(h * 60 - lo) * PPM}px;height:${60 * PPM}px">
        <span class="hour-label" data-h="${h}" title="Click to select this hour">${hm(h * 60)}</span>
        <div class="div-ctl">
          <button class="mini" data-act="hminus" data-h="${h}" ${i <= 0 ? 'disabled' : ''} title="Fewer, longer slots">−</button>
          <span class="div-len">${60 / n}m</span>
          <button class="mini" data-act="hplus" data-h="${h}" ${i >= DIVS.length - 1 ? 'disabled' : ''} title="More, shorter slots">+</button>
        </div>
      </div>`;
    }
    // background slot rows
    const rows = bgUnitsOfDay(key).filter((u) => u.m + u.L > lo && u.m < hi).map((u) => {
      const s = Math.max(u.m, lo), e = Math.min(u.m + u.L, hi);
      return `<div class="slot bg ${u.m % 60 === 0 ? 'hour-start' : ''} ${u.block ? 'block' : ''}" data-m="${u.m}" data-len="${u.L}" style="top:${(s - lo) * PPM}px;height:${(e - s) * PPM}px">
        <span class="slot-time">${hm(u.m)}${u.block ? `<small>→${hm(u.m + u.L)}</small>` : ''}</span>
        <span class="bg-hint">+ ${hm(u.m)}–${hm(u.m + u.L)}</span>
        ${u.block ? `<button class="split-btn" data-act="split" data-m="${u.m}" title="Split back into normal slots">split</button>` : ''}
      </div>`;
    }).join('');
    const blocks = layoutBlocks(key).map((b) => (b.kind === 'event' ? eventBlockHTML(key, b) : itemBlockHTML(key, b))).join('');
    html += `<div class="tgrid" style="height:${(hi - lo) * PPM}px">
        <div class="tg-hours">${hours}</div>
        <div class="tg-lane">${rows}${blocks}<div class="now-line" hidden></div></div>
      </div>`;
    html += `</section><aside class="side">${goalsCard(key)}${summaryCard(key)}${reflectionCard(key)}${inboxCard()}${readyCard()}${categoryCard(key)}</aside></div>`;
    $('#main').innerHTML = html;
  }
  // Minute of the day under a screen Y position in the day grid
  function laneMinute(clientY) {
    const lane = $('.tg-lane');
    if (!lane) return 0;
    const r = lane.getBoundingClientRect();
    return dayRange()[0] + (clientY - r.top) / PPM;
  }
  const nearestBound = (key, minute) => gridBounds(key).reduce((best, b) => (Math.abs(b - minute) < Math.abs(best - minute) ? b : best), 0);
  // Redraw one block at a new time while it's being dragged
  function moveBlockEl(el, s, e) {
    const [lo] = dayRange();
    el.style.top = `${(s - lo) * PPM}px`;
    el.style.height = `${Math.max((e - s) * PPM - 2, 18)}px`;
    const t = $('.tb-time', el);
    if (t) t.textContent = `${hm(s)}–${hm(e)} · ${dur(e - s)}`;
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
        ${row('var(--green)', 'Completed / attended', st.g)}
        ${row('var(--yellow)', "Wasn't efficient", st.y)}
        ${row('var(--red)', 'Missed / distracted', st.r)}
        ${row('var(--border)', 'Planned, not rated', st.unrated)}
      </div>
      ${attendanceStats(key)}
    </div>`;
  }
  function attendanceStats(key) {
    let att = 0, miss = 0, pending = 0;
    for (const ev of eventsOn(key)) {
      if (!evPart(ev)) continue;
      const s = evStatus(key, ev);
      if (s === 'g') att++; else if (s === 'r') miss++; else pending++;
    }
    if (!(att + miss + pending)) return '';
    return `<div class="extra-stat"><b>Attendance</b> <span class="ok">✓ ${att} attended</span> · <span class="bad">✗ ${miss} missed</span>${pending ? ` · <span class="muted">${pending} to mark</span>` : ''}</div>`;
  }
  const updateSummary = () => { const el = $('#summary'); if (el) el.outerHTML = summaryCard(state.date); };

  // ----- Daily reflection: mood, energy and a short note -----
  const MOODS = ['😞', '🙁', '😐', '🙂', '😄'];
  const MOOD_LABEL = ['Rough', 'Meh', 'Okay', 'Good', 'Great'];
  function reflectionCard(key) {
    const r = (getDay(key) || {}).refl || {};
    return `<div class="card" id="reflCard">
      <div class="card-head"><h2>Reflection</h2><span class="muted">${r.mood ? MOOD_LABEL[r.mood - 1] : 'How did today go?'}</span></div>
      <div class="refl-row"><span class="lbl">Mood</span>${MOODS.map((m, i) =>
        `<button class="refl-btn ${r.mood === i + 1 ? 'on' : ''}" data-refl="mood" data-v="${i + 1}" title="${MOOD_LABEL[i]}">${m}</button>`).join('')}</div>
      <div class="refl-row"><span class="lbl">Energy</span>${[1, 2, 3, 4, 5].map((v) =>
        `<button class="refl-btn energy ${r.energy >= v ? 'on' : ''}" data-refl="energy" data-v="${v}" title="Energy ${v}/5">⚡</button>`).join('')}</div>
      <textarea id="reflNote" rows="3" placeholder="A short note: what went well, what to change tomorrow…">${esc(r.note || '')}</textarea>
    </div>`;
  }

  // ----- Inbox: to-dos without a time yet -----
  const DURS = [15, 30, 45, 60, 90, 120];
  const durOptions = (cur) => [...new Set([...DURS, +cur || 30])].sort((a, b) => a - b)
    .map((d) => `<option value="${d}" ${+cur === d ? 'selected' : ''}>${dur(d)}</option>`).join('');
  function inboxCard() {
    const n = data.inbox.length;
    return `<div class="card" id="inboxCard">
      <div class="card-head"><h2>Inbox</h2><span class="muted">${n ? `${n} to schedule` : 'empty'}</span></div>
      <form class="goal-form" data-inbox-add><input name="t" placeholder="Add a to-do…" autocomplete="off"><button type="submit">Add</button></form>
      <ul class="inbox">${data.inbox.map((x) => `<li class="drag-src" data-src="inbox" data-id="${x.id}" title="Drag into the day to schedule it">
        <span class="grip">⠿</span><span class="ib-t">${esc(x.t)}</span>
        <select data-ib-dur="${x.id}" title="How long it takes">${durOptions(x.dur)}</select>
        <button class="x" data-ib-del="${x.id}" title="Remove from inbox">×</button></li>`).join('')}</ul>
      <div class="muted small ib-hint">${n ? 'Drag a to-do into a time slot to schedule it.' : 'Unscheduled to-dos go here.'} Drag a task back here to unschedule it.</div>
    </div>`;
  }

  // ----- Ready tasks: reusable blocks to drag into the day -----
  function readyCard() {
    return `<div class="card" id="readyCard">
      <div class="card-head"><h2>Ready tasks</h2><span class="muted">drag into a slot</span></div>
      <div class="ready">${data.ready.map((x) => `<span class="ready-chip drag-src" data-src="ready" data-id="${x.id}" title="Drag into the day (${dur(x.dur)})">
        <span class="rc-ico">${esc(x.icon || '•')}</span>${esc(x.t)} <em>${dur(x.dur)}</em>
        <button class="x" data-rd-del="${x.id}" title="Remove this ready task">×</button></span>`).join('')}</div>
      <form class="ready-add" data-ready-add>
        <input name="icon" maxlength="2" placeholder="🙂" title="Emoji (optional)" autocomplete="off">
        <input name="t" placeholder="New ready task…" autocomplete="off">
        <select name="dur">${durOptions(30)}</select>
        <button type="submit">Add</button>
      </form>
    </div>`;
  }

  function helpCard() {
    return `<div class="help"><ul>
      <li><b>Quick add:</b> type in the bar at the top, e.g. “gym tomorrow 7–8 weekly” or “call mum fri 6pm for 30m”. Without a time it goes to the inbox.</li>
      <li><b>Inbox &amp; ready tasks</b> (day view sidebar): drag them into a time slot. Drag a scheduled task back onto the inbox to unschedule it.</li>
      <li><b>Templates:</b> 📋 Templates saves a day's tasks and slot layout, and applies them to any other day.</li>
      <li><b>Add a task:</b> click an empty slot. To put something next to an event, click the free strip on the right or the event's <b>+</b>.</li>
      <li><b>Change its time:</b> drag the top or bottom edge of the block, or use the slider in its <b>⋯</b> menu. It snaps to your slots.</li>
      <li><b>Move it:</b> drag the block up or down (week view: drag it to another day).</li>
      <li><b>Repeat it:</b> click the task's <b>⋯</b> and pick <b>↻ Repeat</b> (every day, weekdays, weekly, every 2 weeks, monthly). Ratings and time changes apply to that date only; the text applies to all.</li>
      <li><b>Remove it:</b> click the × in its corner, or select it and press <kbd>Delete</kbd>. <kbd>⌘Z</kbd> / <kbd>Ctrl Z</kbd> undoes.</li>
      <li>Overlapping tasks and events sit side by side; each stays one block for its whole length.</li>
      <li>Use <b>−</b> / <b>+</b> next to an hour to change its slot length (60 → 30 → 20 → 15 → 12 → 10 → 6 → 5 min).</li>
      <li>Drag over empty slots (or click an hour label) to select a window, then label it as one task, or rate it, from the bar at the bottom.</li>
      <li>Lectures, meetings and other events are rated <b>✓ Attended / ✗ Missed</b> (set per category in ⚙ Settings).</li>
      <li><kbd>G</kbd> <kbd>Y</kbd> <kbd>R</kbd> rate (press again to remove) · <kbd>↑</kbd> <kbd>↓</kbd> move between slots · <kbd>←</kbd> <kbd>→</kbd> previous/next day · <kbd>Enter</kbd> type · <kbd>Esc</kbd> deselect · <kbd>[</kbd> <kbd>]</kbd> change page · <kbd>T</kbd> today.</li>
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
  // Week grid: each day is a column on the same time scale; every task / event is one block
  // (title centred), clashes side by side, background rows are the day's slots.
  const WPPM = 1; // pixels per minute in the week grid (1 hour = 60px)
  function wkBlockHTML(k, b) {
    const [lo, hi] = dayRange();
    const s = Math.max(b.s, lo), e = Math.min(b.e, hi);
    const h = Math.max((e - s) * WPPM - 1, 13);
    const style = `top:${(s - lo) * WPPM}px;height:${h}px;left:calc((100% - 6px) * ${b.col / b.ncols});width:calc((100% - 6px) * ${b.span / b.ncols} - 2px);`;
    const size = h < 24 ? 'xs' : h < 40 ? 'short' : 'tall';
    const time = `${hm(b.s)}–${hm(b.e)}`;
    if (b.kind === 'event') {
      const ev = b.ev, st = evStatus(k, ev);
      const active = activeEvent && activeEvent.date === k && activeEvent.i === b.i;
      const tip = `${evTip(ev)} · ${categoryOf(ev).name}${st ? ' · ' + (evPart(ev) ? ATTEND_LABEL : STATUS_LABEL)[st] : ''}\nClick to rate or rename · double-click for day view`;
      return `<div class="wk-card event ${st ? 's-' + st : ''} ${size} ${active ? 'active' : ''}" style="${style}${evStyle(ev)}" data-kind="event" data-date="${k}" data-ei="${b.i}" title="${esc(tip)}">
        <span class="wk-title">${esc(ev.t)}</span>${size === 'tall' ? `<span class="wk-time">${time}</span>` : ''}</div>`;
    }
    const it = b.it;
    const active = activeItem && activeItem.date === k && activeItem.id === it.id;
    const tip = `${time} · ${it.t || 'Task'}${it.st ? ' · ' + STATUS_LABEL[it.st] : ''}\nClick to edit · drag to move · double-click for day view`;
    return `<div class="wk-card item ${it.st ? 's-' + it.st : ''} ${size} ${active ? 'active' : ''}" style="${style}" data-kind="item" data-date="${k}" data-id="${it.id}" title="${esc(tip)}">
      <span class="wk-title">${it.rec ? '<span class="rec-ico">↻</span> ' : ''}${esc(it.t || '·')}</span>${size === 'tall' ? `<span class="wk-time">${time}</span>` : ''}
      <button class="wk-del" data-act="wk-del" data-date="${k}" data-id="${it.id}" title="Remove this task" aria-label="Remove task">×</button></div>`;
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
        <span class="wk-meta">${st.g ? `<span>${dur(st.g)} done</span>` : ''}${score !== null ? `<span>${Math.round(score * 100)}%</span>` : ''}${((getDay(k) || {}).refl || {}).mood ? `<span title="Mood">${MOODS[getDay(k).refl.mood - 1]}</span>` : ''}</span>
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
    const [lo, hi] = dayRange();
    const H = (hi - lo) * WPPM;
    let labels = '';
    for (let h = sh; h < eh; h++) labels += `<span class="wk-hl" style="top:${(h * 60 - lo) * WPPM}px">${hm(h * 60)}</span>`;
    html += `<div class="wk-hours" style="height:${H}px">${labels}</div>`;
    for (const k of days) {
      const rows = bgUnitsOfDay(k).filter((u) => u.m + u.L > lo && u.m < hi).map((u) => {
        const s = Math.max(u.m, lo), e = Math.min(u.m + u.L, hi);
        return `<div class="wk-slot ${u.m % 60 === 0 ? 'hour-start' : ''} ${u.block ? 'block' : ''}" data-date="${k}" data-m="${u.m}" data-len="${u.L}" style="top:${(s - lo) * WPPM}px;height:${(e - s) * WPPM}px" title="${hm(u.m)}–${hm(u.m + u.L)} · click to add a task, drag to select"></div>`;
      }).join('');
      const blocks = layoutBlocks(k).map((b) => wkBlockHTML(k, b)).join('');
      html += `<div class="wk-col ${k === today ? 'today' : ''}" data-date="${k}" style="height:${H}px">${rows}${blocks}<div class="now-line wk-now" hidden></div></div>`;
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
    const isToday = state.view === 'day' && state.date === now.date;
    const cur = viewUnitAt(now.date, now.min);
    const progress = ((now.min - cur.m) * 60 + now.sec) / (cur.L * 60);
    let els = [];
    if (isToday) els = $$(`.slot.bg[data-m="${cur.m}"]`);
    else if (state.view === 'week') els = $$(`.wk-slot[data-date="${now.date}"][data-m="${cur.m}"]`);
    $$('.is-now').forEach((e) => { if (!els.includes(e)) e.classList.remove('is-now'); });
    $$('.is-now-hour').forEach((e) => { if (!isToday || +e.dataset.h !== now.h) e.classList.remove('is-now-hour'); });
    for (const el of els) {
      el.classList.add('is-now');
      el.style.setProperty('--p', progress.toFixed(4));
    }
    // red "now" line: across the day grid, or across today's column in the week grid
    const [lo, hi] = dayRange();
    const m = now.min + now.sec / 60;
    const inHours = m >= lo && m < hi;
    const dayLine = $('.tg-lane .now-line');
    if (dayLine) {
      dayLine.hidden = !(isToday && inHours);
      if (!dayLine.hidden) dayLine.style.top = `${(m - lo) * PPM}px`;
    }
    $$('.wk-now').forEach((l) => {
      const show = inHours && l.parentElement.dataset.date === now.date;
      l.hidden = !show;
      if (show) l.style.top = `${(m - lo) * WPPM}px`;
    });
    if (isToday) { const hr = $(`.tg-hour[data-h="${now.h}"]`); if (hr) hr.classList.add('is-now-hour'); }
  }
  function scrollToNow(smooth) {
    const el = $('.now-line:not([hidden])') || $('.slot.is-now');
    if (el) el.scrollIntoView({ block: 'center', behavior: smooth ? 'smooth' : 'auto' });
  }

  function paintSel() {
    if (pruneEmpty()) { render(); return; }
    $$('.is-sel').forEach((e) => e.classList.remove('is-sel'));
    $$('.tblock.active, .wk-card.active').forEach((e) => e.classList.remove('active'));
    if (sel && state.view === 'day' && sel.date === state.date) {
      const [lo, hi] = selRange();
      $$('.slot').forEach((e) => { const m = +e.dataset.m; if (m >= lo && m <= hi) e.classList.add('is-sel'); });
    } else if (sel && state.view === 'week') {
      const [lo, hi] = selRange();
      $$(`.wk-slot[data-date="${sel.date}"]`).forEach((e) => { const m = +e.dataset.m; if (m >= lo && m <= hi) e.classList.add('is-sel'); });
    }
    if (activeItem) $$(`.tblock.item[data-id="${activeItem.id}"], .wk-card[data-id="${activeItem.id}"]`).forEach((e) => e.classList.add('active'));
    if (activeEvent) $$(`.wk-card.event[data-date="${activeEvent.date}"][data-ei="${activeEvent.i}"]`).forEach((e) => e.classList.add('active'));
    renderSelbar();
    renderPopover();
    renderItemMenu();
  }

  // ----- Rating targets -----
  // What G / Y / R and the rating buttons apply to: the active task, the active event,
  // or everything inside the selected slots.
  function selTargets() {
    const span = sel && selSpan();
    if (!span) return [];
    const [a, b] = span;
    const out = [];
    for (const ev of eventsOn(sel.date)) if (ev.s < b && ev.e > a) out.push({ ev, part: evPart(ev), st: evStatus(sel.date, ev) });
    for (const it of itemsOf(sel.date)) if (it.s < b && it.e > a) out.push({ it, part: false, st: it.st });
    return out;
  }
  const commonOf = (targets) => { const s = new Set(targets.map((t) => t.st || '')); return s.size === 1 ? [...s][0] : null; };
  function markButtons(targets, attr) {
    const common = commonOf(targets);
    const k = (c) => (attr === 'sa' ? ` (${c.toUpperCase()})` : '');
    if (targets.length && targets.every((t) => t.part)) {
      return `<button class="mark g ${common === 'g' ? 'on' : ''}" data-${attr}="g" title="Attended${k('g')}">✓ Attended</button>
        <button class="mark r ${common === 'r' ? 'on' : ''}" data-${attr}="r" title="Missed${k('r')}">✗ Missed</button>`;
    }
    return `<button class="mark g ${common === 'g' ? 'on' : ''}" data-${attr}="g" title="${STATUS_LABEL.g}${k('g')}">Done</button>
      <button class="mark y ${common === 'y' ? 'on' : ''}" data-${attr}="y" title="${STATUS_LABEL.y}${k('y')}">Inefficient</button>
      <button class="mark r ${common === 'r' ? 'on' : ''}" data-${attr}="r" title="${STATUS_LABEL.r}${k('r')}">Missed</button>`;
  }

  // ----- Repeating tasks -----
  function repeatHTML(key, it) {
    const sr = it.rec ? findSeries(it.sid) : null;
    const anchor = sr ? (sr.anchor || sr.start) : key;
    const wd = fmt(anchor, { weekday: 'long' });
    const opt = (v, label) => `<option value="${v}" ${(sr ? sr.freq : '') === v ? 'selected' : ''}>${label}</option>`;
    return `<div class="repeat-row" data-date="${key}" data-id="${it.id}">
      <span class="lbl">↻ Repeat</span>
      <select data-repeat aria-label="Repeat">
        ${opt('', "Doesn't repeat")}${opt('daily', 'Every day')}${opt('weekdays', 'Every weekday (Mon–Fri)')}
        ${opt('weekly', `Weekly on ${wd}`)}${opt('biweekly', `Every 2 weeks on ${wd}`)}${opt('monthly', `Monthly on day ${+anchor.slice(8)}`)}
      </select>
      ${sr ? `<label class="rep-until">until <input type="date" data-until value="${sr.until || ''}" min="${sr.start}" title="Leave empty to repeat forever"></label>
        ${it.moved ? '<button data-rep="all-time" title="Give every occurrence this start and end time">Use this time for all</button>' : ''}
        <button data-rep="del-series" class="danger-link" title="Delete every occurrence of this task">Delete series</button>` : ''}
    </div>`;
  }
  function setRepeat(key, id, freq) {
    const it = findItem(key, id);
    if (!it) return;
    checkpoint([key]);
    if (!it.rec) {
      if (!freq) return;
      // turn a one-off task into a repeating one starting on this date
      const sr = { id: uid(), t: it.t, s: it.s, e: it.e, freq, anchor: key, start: key, until: null };
      data.series.push(sr);
      const day = ensureDay(key);
      day.items = day.items.filter((i) => i.id !== id);
      if (it.st) day.sro[sr.id] = { st: it.st };
      save();
      setActiveItem(key, occId(sr.id, key));
      if (itemMenuFor === id) itemMenuFor = occId(sr.id, key); // keep its menu open
      render();
      toast(`Repeats: ${REPEAT_LABEL[freq].toLowerCase()}`, true);
      return;
    }
    const sr = findSeries(it.sid);
    if (!sr) return;
    if (freq) {
      sr.freq = freq;
      sr.anchor = key; // weekday / day of month are taken from the date you changed it on
      save();
      render();
      toast(`Repeats: ${REPEAT_LABEL[freq].toLowerCase()}`, true);
      return;
    }
    // "Doesn't repeat": end the series before this date; this date keeps a one-off copy
    const day = ensureDay(key);
    day.items.push({ id: uid(), s: it.s, e: it.e, t: it.t, st: it.st });
    delete day.sro[sr.id];
    sr.until = addDays(key, -1);
    if (sr.until < sr.start) data.series = data.series.filter((x) => x !== sr);
    save();
    activeItem = null;
    render();
    toast('Stopped repeating from this date', true);
  }
  document.addEventListener('change', (e) => {
    const row = e.target.closest('.repeat-row');
    if (!row) return;
    const key = row.dataset.date, id = row.dataset.id;
    if (e.target.matches('[data-repeat]')) setRepeat(key, id, e.target.value);
    else if (e.target.matches('[data-until]')) {
      const occ = parseOcc(id), sr = occ && findSeries(occ.sid);
      if (!sr) return;
      checkpoint([key]);
      sr.until = e.target.value || null;
      save();
      render();
      toast(sr.until ? `Repeats until ${fmt(sr.until, { day: 'numeric', month: 'short', year: 'numeric' })}` : 'Repeats with no end date', true);
    }
  });
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-rep]');
    if (!b) return;
    const row = b.closest('.repeat-row');
    const key = row.dataset.date, it = findItem(key, row.dataset.id);
    const sr = it && it.rec && findSeries(it.sid);
    if (!sr) return;
    checkpoint([key]);
    if (b.dataset.rep === 'all-time') {
      sr.s = it.s; sr.e = it.e;
      const day = ensureDay(key);
      const o = { ...(day.sro[sr.id] || {}) };
      delete o.s; delete o.e;
      if (Object.keys(o).length) day.sro[sr.id] = o; else delete day.sro[sr.id];
      save();
      render();
      toast(`Every occurrence is now ${hm(sr.s)}–${hm(sr.e)}`, true);
    } else if (b.dataset.rep === 'del-series') {
      data.series = data.series.filter((x) => x !== sr);
      save();
      activeItem = null;
      render();
      toast(`Deleted the repeating task “${sr.t || 'Task'}”`, true);
    }
  });

  // ----- Time slider (stretch a task both ways) -----
  function sliderHTML(key, it) {
    const lo = Math.max(0, Math.floor((it.s - 120) / 60) * 60);
    const hi = Math.min(1440, Math.ceil((it.e + 120) / 60) * 60);
    const pos = (m) => ((m - lo) / (hi - lo)) * 100;
    const ticks = gridBounds(key).filter((b) => b >= lo && b <= hi)
      .map((b) => `<span class="range-tick ${b % 60 === 0 ? 'major' : ''}" style="left:${pos(b)}%">${b % 60 === 0 && b !== lo && b !== hi ? `<em>${hm(b)}</em>` : ''}</span>`).join('');
    return `<div class="range" data-date="${key}" data-id="${it.id}" data-lo="${lo}" data-hi="${hi}" data-s="${it.s}" data-e="${it.e}">
      <div class="range-track">
        ${ticks}
        <div class="range-fill" style="left:${pos(it.s)}%;width:${pos(it.e) - pos(it.s)}%"></div>
        <button class="range-thumb" data-thumb="s" style="left:${pos(it.s)}%" title="Drag to change the start" aria-label="Start time ${hm(it.s)}"></button>
        <button class="range-thumb" data-thumb="e" style="left:${pos(it.e)}%" title="Drag to change the end" aria-label="End time ${hm(it.e)}"></button>
      </div>
      <div class="range-labels"><span>${hm(lo)}</span><b class="range-value">${hm(it.s)} → ${hm(it.e)} · ${dur(it.e - it.s)}</b><span>${hm(hi)}</span></div>
    </div>`;
  }
  function paintSlider(el, s, e) {
    const lo = +el.dataset.lo, hi = +el.dataset.hi;
    const pos = (m) => ((Math.min(hi, Math.max(lo, m)) - lo) / (hi - lo)) * 100;
    $('.range-fill', el).style.left = `${pos(s)}%`;
    $('.range-fill', el).style.width = `${pos(e) - pos(s)}%`;
    $('[data-thumb="s"]', el).style.left = `${pos(s)}%`;
    $('[data-thumb="e"]', el).style.left = `${pos(e)}%`;
    $('.range-value', el).textContent = `${hm(s)} → ${hm(e)} · ${dur(e - s)}`;
  }
  // Snap a minute to the nearest slot boundary, keeping start < end.
  function snapThumb(key, which, minute, s, e, lo, hi) {
    const bounds = gridBounds(key).filter((b) => b >= lo && b <= hi);
    const ok = bounds.filter((b) => (which === 's' ? b < e : b > s));
    if (!ok.length) return which === 's' ? s : e;
    return ok.reduce((best, b) => (Math.abs(b - minute) < Math.abs(best - minute) ? b : best), ok[0]);
  }
  function previewRange(key, s, e) {
    $$('.range-preview').forEach((x) => x.classList.remove('range-preview'));
    if (state.view === 'day' && key === state.date) {
      $$('.slot').forEach((x) => { const m = +x.dataset.m, L = +x.dataset.len || 0; if (m < e && m + Math.max(L, 1) > s) x.classList.add('range-preview'); });
    } else if (state.view === 'week') {
      $$(`.wk-slot[data-date="${key}"]`).forEach((x) => { const m = +x.dataset.m, L = +x.dataset.len || 1; if (m < e && m + L > s) x.classList.add('range-preview'); });
    }
  }
  function applyItemTime(key, id, s, e) {
    const it = findItem(key, id);
    if (!it || (it.s === s && it.e === e)) return;
    checkpoint([key]);
    updateItem(key, id, { s, e });
    render();
  }

  // ----- Week view popover editor -----
  function renderPopover() {
    const pop = $('#wkpop');
    if (state.view !== 'week') { pop.hidden = true; pop.innerHTML = ''; return; }
    if (drag) { pop.hidden = true; return; } // wait until the gesture finishes
    let anchors = [], html = '';
    const head = (key, from, to, extra) => `<div class="pop-head">
        <div><b>${fmt(key, { weekday: 'short', day: 'numeric', month: 'short' })}</b> <span class="muted">· ${hm(from)}–${hm(to)}${extra || ''}</span></div>
        <button class="x-btn" data-pa="close" title="Close (Esc)">✕</button></div>`;

    if (activeItem && findItem(activeItem.date, activeItem.id)) {
      const { date } = activeItem, it = findItem(date, activeItem.id);
      anchors = $$(`.wk-card[data-id="${it.id}"]`);
      html = `${head(date, it.s, it.e)}
        <input id="popText" data-id="${it.id}" value="${esc(it.t)}" placeholder="What will you do?" autocomplete="off">
        <div class="pop-marks">${markButtons([{ it, st: it.st, part: false }], 'pa')}</div>
        <div class="pop-label">Time</div>
        ${sliderHTML(date, it)}
        ${repeatHTML(date, it)}
        <div class="pop-foot"><span class="grp"><button data-pa="add-here" title="Add another task in this slot">+ Another task here</button></span>
          <span class="grp"><button data-pa="open" title="Open in the day view">Day view →</button></span></div>
        <div class="pop-hint muted">Drag the slider's ends to change the time · Enter: done · Del: remove · Esc: close</div>`;
    } else if (activeEvent && eventsOn(activeEvent.date)[activeEvent.i]) {
      const { date, i } = activeEvent, ev = eventsOn(date)[i];
      const st = evStatus(date, ev);
      anchors = $$(`.wk-card.event[data-date="${date}"][data-ei="${i}"]`);
      html = `${head(date, ev.s, ev.e)}
        <div class="ev pop-ev" style="${evStyle(ev)}">📅 ${esc(ev.t)}${ev.loc ? ` · ${esc(ev.loc)}` : ''} <span class="muted">· ${esc(categoryOf(ev).name)}</span></div>
        <div class="pop-marks ${evPart(ev) ? 'two' : ''}">${markButtons([{ ev, st, part: evPart(ev) }], 'pa')}</div>
        <div class="pop-foot"><span class="grp"><button data-pa="rename" title="Change this event's title">✎ Rename</button>
            <button data-pa="add-here" title="Add your own task alongside this event">+ Task alongside</button></span>
          <span class="grp"><button data-pa="open">Day view →</button></span></div>`;
    } else if (sel) {
      const ss = selSlots();
      if (!ss.length) { pop.hidden = true; return; }
      anchors = $$('.wk-slot.is-sel');
      const first = ss[0], last = ss[ss.length - 1], single = ss.length === 1;
      const targets = selTargets();
      const day = getDay(sel.date);
      const hours = [...new Set(ss.map((s) => Math.floor(s.m / 60)))];
      const divs = hours.map((h) => DIVS.indexOf(getDiv(day, h)));
      const canMinus = divs.some((x) => x > 0), canPlus = divs.some((x) => x < DIVS.length - 1);
      const [ua, ub] = [first.m, first.m + first.L];
      const list = single ? [...eventsOn(sel.date).map((ev, i) => (ev.s < ub && ev.e > ua ? `<button class="pop-row" data-pa-ev="${i}" style="${evStyle(ev)}">📅 ${esc(ev.t)}</button>` : '')),
        ...itemsOf(sel.date).filter((it) => it.s < ub && it.e > ua).map((it) => `<button class="pop-row ${it.st ? 'sv-' + it.st : ''}" data-pa-item="${it.id}">• ${esc(it.t || 'Task')} <span class="muted">${hm(it.s)}–${hm(it.e)}</span></button>`)].join('') : '';
      html = `${head(sel.date, first.m, last.m + last.L, single ? '' : ` · ${ss.length} slots`)}
        ${list ? `<div class="pop-list">${list}</div>` : ''}
        <form data-pa-form="text"><input id="popText" placeholder="${single ? (list ? 'Add another task here…' : 'What will you do?') : 'Label all selected slots…'}" autocomplete="off"></form>
        <div class="pop-marks">${markButtons(targets, 'pa')}</div>
        <div class="pop-foot">
          <span class="grp"><span class="lbl">Slot size</span>
            <button data-pa="minus" ${canMinus ? '' : 'disabled'} title="Fewer, longer slots">−</button>
            <button data-pa="plus" ${canPlus ? '' : 'disabled'} title="More, shorter slots">+</button></span>
          <span class="grp">
            ${single ? '' : '<button data-pa="merge" title="Merge into one slot">⇲ Merge</button>'}
            ${single && first.block && (first.block.manual || first.evs.length) ? '<button data-pa="split" title="Split back into normal slots">Split</button>' : ''}
            <button data-pa="open" title="Open in the day view">Day view →</button></span>
        </div>
        <div class="pop-hint muted">${single ? 'Type to add a task · ↑↓←→ move · Esc: close' : 'Enter: label all · Del: remove tasks · Esc: close'}</div>`;
    }
    if (!html || !anchors.length) { pop.hidden = true; pop.innerHTML = ''; return; }
    pop.innerHTML = html;
    pop.hidden = false;
    positionPopover(anchors);
  }
  function positionPopover(anchors, box) {
    const pop = box || $('#wkpop');
    if (!anchors || !anchors.length) return;
    if (window.innerWidth <= 600) { pop.style.left = ''; pop.style.top = ''; return; } // bottom sheet via CSS
    const a = anchors[0].getBoundingClientRect(), b = anchors[anchors.length - 1].getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight, gap = 8;
    let left = Math.max(a.right, b.right) + gap;
    if (left + w > window.innerWidth - 12) left = Math.min(a.left, b.left) - w - gap;
    left = Math.max(12, Math.min(left, window.innerWidth - w - 12));
    let top = (a.top + b.bottom) / 2 - h / 2;
    top = Math.max(70, Math.min(top, window.innerHeight - h - 12));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  const popAnchors = () => (activeItem ? $$(`.wk-card[data-id="${activeItem.id}"]`)
    : activeEvent ? $$(`.wk-card.event[data-date="${activeEvent.date}"][data-ei="${activeEvent.i}"]`) : $$('.wk-slot.is-sel'));
  function focusPopText() {
    const inp = $('#popText');
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
  function closePopover() { clearFocus(); paintSel(); }

  // ----- Renaming Outlook events -----
  // "Only this one" stores a title for that occurrence; "All events called X" renames every
  // event with that Outlook title (e.g. a weekly lecture). Ratings stay attached either way.
  let evEditing = null; // { date, i }
  function countTitle(t) {
    let n = 0;
    for (const k of Object.keys(cal.byDate)) for (const ev of cal.byDate[k]) if (ev.t === t) n++;
    return n;
  }
  function openEventEditor(date, i, anchor) {
    const ev = eventsOn(date)[i];
    if (!ev) return;
    const orig = ev.ot || ev.t;
    const n = countTitle(orig);
    const perDay = !!((getDay(date) || {}).evt || {})[evKey(ev)];
    const all = n > 1 && !perDay;
    evEditing = { date, i };
    const box = $('#evEdit');
    box.innerHTML = `
      <div class="pop-head"><div><b>Rename event</b> <span class="muted">· ${fmt(date, { weekday: 'short', day: 'numeric', month: 'short' })} ${hm(ev.s)}</span></div>
        <button class="x-btn" data-ee="close" title="Cancel (Esc)">✕</button></div>
      <input id="evTitle" value="${esc(ev.t)}" placeholder="Event title" autocomplete="off">
      <div class="muted small">Outlook title: ${esc(orig)}</div>
      ${n > 1 ? `<label class="check small"><input type="radio" name="evScope" value="all" ${all ? 'checked' : ''}> All ${n} events called “${esc(orig)}”</label>
        <label class="check small"><input type="radio" name="evScope" value="one" ${all ? '' : 'checked'}> Only this one</label>` : ''}
      <div class="pop-foot">
        <span class="grp"><button data-ee="reset" ${ev.ot ? '' : 'disabled'} title="Go back to the title from Outlook">Use Outlook title</button></span>
        <span class="grp"><button class="btn primary" data-ee="save">Save</button></span>
      </div>`;
    box.hidden = false;
    positionPopover([anchor].filter(Boolean), box);
    const inp = $('#evTitle');
    inp.focus();
    inp.select();
  }
  function closeEventEditor() { evEditing = null; $('#evEdit').hidden = true; }
  function saveEventTitle(reset) {
    if (!evEditing) return;
    const { date, i } = evEditing;
    const ev = eventsOn(date)[i];
    if (!ev) { closeEventEditor(); return; }
    const orig = ev.ot || ev.t, k = evKey(ev);
    const val = $('#evTitle').value.trim();
    const scope = ($('input[name="evScope"]:checked') || {}).value || 'one';
    checkpoint([date]);
    const day = ensureDay(date);
    if (reset) {
      delete day.evt[k];
      delete data.settings.evRename[orig];
    } else if (scope === 'all') {
      delete day.evt[k];
      if (!val || val === orig) delete data.settings.evRename[orig]; else data.settings.evRename[orig] = val;
    } else if (!val || val === orig) delete day.evt[k];
    else day.evt[k] = val;
    save();
    resetCategoryCache();
    closeEventEditor();
    render();
    toast(reset ? `Back to “${orig}”` : scope === 'all' ? `Renamed all “${orig}” events` : 'Event renamed', true);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-ee]');
    if (!b || b.disabled) return;
    if (b.dataset.ee === 'close') closeEventEditor();
    else if (b.dataset.ee === 'save') saveEventTitle(false);
    else if (b.dataset.ee === 'reset') saveEventTitle(true);
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id !== 'evTitle') return;
    if (e.key === 'Enter') { e.preventDefault(); saveEventTitle(false); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeEventEditor(); }
  }, true);
  // clicking elsewhere closes the rename box
  document.addEventListener('pointerdown', (e) => {
    if (evEditing && !e.target.closest('#evEdit') && !e.target.closest('[data-act="ev-rename"], [data-pa="rename"]')) closeEventEditor();
  }, true);

  // ----- Day view bottom bar -----
  // ----- Day view task menu (⋯ on a block): time slider + repeat options -----
  let itemMenuFor = null; // id of the task whose menu is open
  function renderItemMenu() {
    const box = $('#itemMenu');
    const it = itemMenuFor && state.view === 'day' && activeItem && activeItem.id === itemMenuFor && activeItem.date === state.date
      ? findItem(state.date, itemMenuFor) : null;
    if (!it) { if (!drag || !drag.slider) { box.hidden = true; box.innerHTML = ''; } return; }
    if (drag && drag.slider) return; // don't rebuild while the slider is being dragged
    box.innerHTML = `
      <div class="pop-head"><div><b>${esc(it.t || 'New task')}</b> <span class="muted">· ${hm(it.s)}–${hm(it.e)}</span></div>
        <button class="x-btn" data-im="close" title="Close (Esc)">✕</button></div>
      <div class="pop-label">Time</div>
      ${sliderHTML(state.date, it)}
      ${repeatHTML(state.date, it)}`;
    box.hidden = false;
    const anchor = $(`.tblock.item[data-id="${it.id}"]`);
    if (anchor) positionPopover([anchor], box);
  }
  function openItemMenu(key, id) {
    setActiveItem(key, id);
    itemMenuFor = id;
    paintSel();
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-im="close"]')) { itemMenuFor = null; paintSel(); } });
  // clicking outside the menu (and not on the task's ⋯) closes it
  document.addEventListener('pointerdown', (e) => {
    if (itemMenuFor && !e.target.closest('#itemMenu') && !e.target.closest('[data-act="item-menu"]')) {
      itemMenuFor = null;
      $('#itemMenu').hidden = true;
    }
  }, true);
  window.addEventListener('scroll', () => { const b = $('#itemMenu'); if (b && !b.hidden && itemMenuFor) { const a = $(`.tblock.item[data-id="${itemMenuFor}"]`); if (a) positionPopover([a], b); } }, { passive: true });

  function renderSelbar() {
    const bar = $('#selbar');
    if (state.view !== 'day') { bar.hidden = true; bar.innerHTML = ''; return; }
    if (document.activeElement && document.activeElement.id === 'selLabel') return; // don't rebuild while typing a label
    // a clicked task has no bottom bar: its controls live on the block and in its ⋯ menu
    if (activeItem && activeItem.date === state.date && findItem(activeItem.date, activeItem.id)) {
      bar.hidden = true; bar.innerHTML = ''; bar.classList.remove('item-mode');
      return;
    }
    bar.classList.remove('item-mode');
    if (!sel || sel.date !== state.date) { bar.hidden = true; bar.innerHTML = ''; return; }
    const ss = selSlots();
    if (!ss.length) { bar.hidden = true; return; }
    const first = ss[0], last = ss[ss.length - 1];
    const hours = [...new Set(ss.map((s) => Math.floor(s.m / 60)))];
    const divs = hours.map((h) => DIVS.indexOf(getDiv(getDay(sel.date), h)));
    const canMinus = divs.some((i) => i > 0), canPlus = divs.some((i) => i < DIVS.length - 1);
    bar.innerHTML = `
      <span class="selbar-info"><b>${ss.length} slot${ss.length > 1 ? 's' : ''}</b> · ${hm(first.m)}–${hm(last.m + last.L)}</span>
      <span class="sep"></span>
      <span class="grp"><span class="lbl">Slot size</span>
        <button data-sa="minus" ${canMinus ? '' : 'disabled'} title="Fewer, longer slots in ${hours.length > 1 ? 'these hours' : 'this hour'} (−)">−</button>
        <button data-sa="plus" ${canPlus ? '' : 'disabled'} title="More, shorter slots in ${hours.length > 1 ? 'these hours' : 'this hour'} (+)">+</button>
      </span>
      <span class="sep"></span>
      <span class="grp" title="Click the highlighted rating again to remove it">${markButtons(selTargets(), 'sa')}</span>
      <span class="sep"></span>
      ${ss.length > 1 ? '<button data-sa="merge" title="Merge into one slot (M)">⇲ Merge</button>' : ''}
      ${ss.length === 1 && first.block && (first.block.manual || first.evs.length) ? '<button data-sa="split" title="Split back into normal slots">Split</button>' : ''}
      <form data-sa-form="label"><input id="selLabel" placeholder="${ss.length > 1 ? 'Label all selected…' : 'Add a task here…'}" autocomplete="off"></form>
      <button data-sa="close" title="Deselect (Esc)">✕</button>`;
    bar.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  function go(view, date) {
    if (view && view !== state.view) { activeEvent = null; if (view === 'year') clearFocus(); }
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
    sel = { date: sel.date, a: viewUnitAt(sel.date, hours[0] * 60).m, b: lastUnitInHour(sel.date, lastHour).m };
    render();
  }

  // Rate whatever is in focus. Clicking the rating that's already set removes it.
  function rateCurrent(c) {
    if (activeItem) {
      const it = findItem(activeItem.date, activeItem.id);
      if (!it) return;
      checkpoint([activeItem.date]);
      updateItem(activeItem.date, it.id, { st: it.st === c ? '' : c });
      render();
      return;
    }
    if (activeEvent) {
      const ev = eventsOn(activeEvent.date)[activeEvent.i];
      if (!ev) return;
      if (c === 'y' && evPart(ev)) { toast('Events are Attended (G) or Missed (R)'); return; }
      checkpoint([activeEvent.date]);
      setEvStatus(activeEvent.date, ev, evStatus(activeEvent.date, ev) === c ? '' : c);
      render();
      return;
    }
    if (!sel) return;
    const targets = selTargets();
    if (c === 'y' && targets.length && targets.every((t) => t.part)) { toast('Events are Attended (G) or Missed (R)'); return; }
    const clear = targets.length && commonOf(targets) === c;
    checkpoint([sel.date]);
    if (!targets.length) {
      // empty slots: record the rating as an (untitled) task so the time still counts
      const span = selSpan();
      if (span) addItem(sel.date, span[0], span[1], { st: c });
    } else {
      for (const t of targets) {
        if (t.it) updateItem(sel.date, t.it.id, { st: clear ? '' : c });
        else if (!(t.part && c === 'y')) setEvStatus(sel.date, t.ev, clear ? '' : c);
      }
    }
    render();
  }
  // Turn the selected time window into one task with this label.
  function labelSel(text) {
    const span = sel && selSpan();
    if (!span || !text) return;
    checkpoint([sel.date]);
    const blank = itemsOf(sel.date).find((i) => !i.t && i.s === span[0] && i.e === span[1]);
    if (blank) updateItem(sel.date, blank.id, { t: text });
    else addItem(sel.date, span[0], span[1], { t: text });
    sel = null;
    render();
  }

  // ----- Undo -----
  const undoStack = [];
  function checkpoint(keys) {
    const snap = {};
    for (const k of new Set(keys)) snap[k] = data.days[k] ? JSON.parse(JSON.stringify(data.days[k])) : null;
    // repeating tasks, the inbox, ready tasks and templates are undoable too
    const extra = JSON.parse(JSON.stringify({ series: data.series, inbox: data.inbox, ready: data.ready, templates: data.templates }));
    undoStack.push({ days: snap, ...extra });
    if (undoStack.length > 50) undoStack.shift();
  }
  function undo() {
    const snap = undoStack.pop();
    if (!snap) { toast('Nothing to undo'); return; }
    for (const k of Object.keys(snap.days)) {
      if (snap.days[k]) data.days[k] = snap.days[k];
      else delete data.days[k];
    }
    data.series = snap.series;
    data.inbox = snap.inbox;
    data.ready = snap.ready;
    data.templates = snap.templates;
    save();
    if (sel) normalizeSel();
    render();
    toast('Undone');
  }

  let toastTimer = null;
  let toastAction = null;
  function toast(msg, withUndo, action) {
    const el = $('#toast');
    toastAction = action || null;
    el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button data-toast="action">${esc(action.label)}</button>` : ''}${withUndo ? '<button data-toast="undo">Undo</button>' : ''}`;
    el.hidden = false;
    el.classList.toggle('lift', !$('#selbar').hidden);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, withUndo ? 6000 : 2200);
  }

  // ----- Delete -----
  function deleteItems(key, ids) {
    const gone = ids.filter((id) => findItem(key, id));
    if (!gone.length) { toast('No tasks there to remove'); return; }
    checkpoint([key]);
    for (const id of gone) removeItem(key, id); // a repeating task only loses this date's occurrence
    if (activeItem && gone.includes(activeItem.id)) activeItem = null;
    render();
    const rec = gone.some((id) => parseOcc(id));
    toast(gone.length > 1 ? `Removed ${gone.length} tasks` : rec ? 'Removed this occurrence (the series continues)' : 'Task removed', true);
  }
  function deleteCurrent() {
    if (activeItem) deleteItems(activeItem.date, [activeItem.id]);
    else if (sel) {
      const span = selSpan();
      if (span) deleteItems(sel.date, itemsOf(sel.date).filter((i) => i.s < span[1] && i.e > span[0]).map((i) => i.id));
    }
  }

  // ----- Move tasks (drag & drop) -----
  // Tasks keep their length and move by the distance between the slot they were picked up
  // from and the slot they're dropped on. Overlaps are fine: they sit side by side.
  function moveItems(fromDate, ids, toDate, delta) {
    const src = getDay(fromDate);
    const moving = ids.map((id) => findItem(fromDate, id)).filter(Boolean);
    if (!moving.length || (fromDate === toDate && delta === 0)) return false;
    if (moving.some((it) => it.s + delta < 0 || it.e + delta > 1440)) { toast("That would go past the end of the day"); return false; }
    checkpoint([fromDate, toDate]);
    for (const it of moving) {
      if (it.rec && fromDate === toDate) {
        // a repeating task moved within its day: only this occurrence's time changes
        updateItem(fromDate, it.id, { s: it.s + delta, e: it.e + delta });
      } else if (it.rec) {
        // moved to another day: this date's occurrence becomes a one-off task there
        removeItem(fromDate, it.id);
        ensureDay(toDate).items.push({ id: uid(), s: it.s + delta, e: it.e + delta, t: it.t, st: it.st });
      } else {
        src.items = src.items.filter((i) => i.id !== it.id);
        ensureDay(toDate).items.push({ ...it, s: it.s + delta, e: it.e + delta });
      }
    }
    save();
    return true;
  }

  // ----- Keyboard navigation between slots -----
  function visibleUnits(key) {
    const { startHour: sh, endHour: eh } = data.settings;
    return viewUnits(key).filter((u) => u.m + u.L > sh * 60 && u.m < eh * 60);
  }
  function weekStartOf(k) { return addDays(k, -dow(k)); }
  function navSel(dir, extend) {
    if (state.view === 'year') return;
    const now = londonNow();
    if (!sel && activeItem) {
      const it = findItem(activeItem.date, activeItem.id);
      if (it) { const u = viewUnitAt(activeItem.date, it.s); sel = { date: activeItem.date, a: u.m, b: u.m }; }
    }
    activeItem = null; activeEvent = null;
    if (!sel || (state.view === 'day' && sel.date !== state.date)) {
      // nothing selected yet: start at the current slot (today) or the first visible slot
      let date = state.date;
      if (state.view === 'week') date = weekStartOf(now.date) === weekStartOf(state.date) ? now.date : weekStartOf(state.date);
      const vis = visibleUnits(date);
      const u = (date === now.date && vis.find((x) => x.m <= now.min && now.min < x.m + x.L)) || vis[0];
      sel = { date, a: u.m, b: u.m };
    } else if (dir === 'up' || dir === 'down') {
      const vis = visibleUnits(sel.date);
      const i = vis.findIndex((u) => u.m === sel.b);
      const next = vis[i + (dir === 'up' ? -1 : 1)];
      if (!next) { paintSel(); return; }
      sel = extend ? { ...sel, b: next.m } : { date: sel.date, a: next.m, b: next.m };
    } else {
      // left/right: same time on the previous/next day
      const date = addDays(sel.date, dir === 'left' ? -1 : 1);
      const u = viewUnitAt(date, sel.b);
      sel = { date, a: u.m, b: u.m };
      if (state.view === 'day' || weekStartOf(date) !== weekStartOf(state.date)) { state.date = date; render(); }
    }
    paintSel();
    scrollSelIntoView();
  }
  function scrollSelIntoView() {
    const el = $$(state.view === 'week' ? '.wk-slot.is-sel' : '.slot.is-sel').pop();
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    if (state.view === 'week' && !$('#wkpop').hidden) positionPopover(popAnchors());
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

  // Focus a task's text box after a re-render (day view card, or the week editor).
  function focusItemInput(id) {
    const inp = state.view === 'week' ? $('#popText') : $(`.item-text[data-id="${id}"]`);
    if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
  }
  // Add a task covering a slot and start typing in it.
  function addItemAt(key, m, L, text) {
    const it = addItem(key, m, m + L, { t: text || '' });
    freshItems.set(it.id, key);
    setActiveItem(key, it.id);
    render();
    focusItemInput(it.id);
    return it;
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
    if (t.closest('[data-toast="undo"]')) { $('#toast').hidden = true; undo(); return; }
    if (t.closest('[data-toast="action"]')) { $('#toast').hidden = true; if (toastAction) toastAction.fn(); return; }
    if (t.closest('.range')) return; // slider handled by pointer events

    const sa = t.closest('[data-sa]');
    if (sa && !sa.disabled) {
      const a = sa.dataset.sa;
      if (a === 'minus') selResize(-1);
      else if (a === 'plus') selResize(1);
      else if (a === 'g' || a === 'y' || a === 'r') rateCurrent(a);
      else if (a === 'close') { clearFocus(); paintSel(); }
      else if (a === 'merge') mergeSel();
      else if (a === 'split') splitAt(sel.date, selSlots()[0].m);
      return;
    }

    const pRow = t.closest('[data-pa-item], [data-pa-ev]');
    if (pRow && sel) {
      const date = sel.date;
      if (pRow.dataset.paItem) setActiveItem(date, pRow.dataset.paItem);
      else { clearFocus(); activeEvent = { date, i: +pRow.dataset.paEv }; }
      paintSel();
      return;
    }
    const pa = t.closest('[data-pa]');
    if (pa && !pa.disabled) {
      const a = pa.dataset.pa;
      if (a === 'g' || a === 'y' || a === 'r') rateCurrent(a);
      else if (a === 'minus') selResize(-1);
      else if (a === 'plus') selResize(1);
      else if (a === 'close') closePopover();
      else if (a === 'merge') mergeSel();
      else if (a === 'rename' && activeEvent) openEventEditor(activeEvent.date, activeEvent.i, $(`.wk-card.event[data-date="${activeEvent.date}"][data-ei="${activeEvent.i}"]`) || $('#wkpop'));
      else if (a === 'split' && sel) splitAt(sel.date, selSlots()[0].m);
      else if (a === 'add-here') {
        let date, m, L;
        if (activeItem) { const it = findItem(activeItem.date, activeItem.id); const u = viewUnitAt(activeItem.date, it.s); date = activeItem.date; m = u.m; L = u.L; }
        else if (activeEvent) { const ev = eventsOn(activeEvent.date)[activeEvent.i]; date = activeEvent.date; m = ev.s; L = ev.e - ev.s; }
        if (date) addItemAt(date, m, L);
      } else if (a === 'open') {
        let date = state.date, m = null;
        if (activeItem) { date = activeItem.date; m = (findItem(date, activeItem.id) || {}).s; }
        else if (activeEvent) { date = activeEvent.date; m = (eventsOn(date)[activeEvent.i] || {}).s; activeEvent = null; }
        else if (sel) { date = sel.date; m = selRange()[0]; }
        go('day', date);
        if (m != null) { const u = viewUnitAt(date, m); const slot = u && $(`.slot[data-m="${u.m}"]:not(.cont)`); if (slot) slot.scrollIntoView({ block: 'center' }); }
      }
      return;
    }

    const el = t.closest('[data-act]');
    if (!el || el.tagName === 'FORM' || el.type === 'checkbox') return;
    const act = el.dataset.act;
    const key = el.dataset.date || state.date;
    if (act === 'item-status') {
      const it = findItem(key, el.dataset.id);
      if (!it) return;
      checkpoint([key]);
      updateItem(key, it.id, { st: it.st === el.dataset.s ? '' : el.dataset.s });
      render();
    } else if (act === 'ev-status') {
      const ev = eventsOn(key)[+el.dataset.ei];
      if (!ev) return;
      checkpoint([key]);
      setEvStatus(key, ev, evStatus(key, ev) === el.dataset.s ? '' : el.dataset.s);
      render();
    } else if (act === 'ghost-status') {
      checkpoint([key]);
      addItem(key, +el.dataset.m, +el.dataset.m + +el.dataset.len, { st: el.dataset.s });
      render();
    } else if (act === 'item-del') {
      deleteItems(key, [el.dataset.id]);
    } else if (act === 'wk-del') {
      deleteItems(key, [el.dataset.id]);
    } else if (act === 'item-menu') {
      if (itemMenuFor === el.dataset.id) { itemMenuFor = null; paintSel(); }
      else openItemMenu(key, el.dataset.id);
    } else if (act === 'ev-rename') {
      openEventEditor(key, +el.dataset.ei, el.closest('.tblock') || el);
    } else if (act === 'add-beside') {
      // a task next to an event, in the event's first slot (stretch it from there)
      const ev = eventsOn(key)[+el.dataset.ei];
      if (!ev) return;
      const u = viewUnitAt(key, ev.s);
      checkpoint([key]);
      addItemAt(key, u.m, u.L);
    } else if (act === 'add-item') {
      checkpoint([key]);
      addItemAt(key, +el.dataset.m, +el.dataset.len);
    } else if (act === 'hminus' || act === 'hplus') {
      stepDiv(state.date, [+el.dataset.h], act === 'hplus' ? 1 : -1);
      normalizeSel();
      render();
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
      const v = f.elements[0].value.trim();
      if (v && sel && selSlots().length > 1) { labelSel(v); focusPopText(); }
    } else if (f.matches('[data-sa-form="label"]')) {
      e.preventDefault();
      const v = f.elements[0].value.trim();
      f.elements[0].blur();
      if (v) labelSel(v);
    }
  });

  // Typing: task text saves as you type; typing in an empty slot (or the week editor) creates a task.
  let summaryTimer = null;
  document.addEventListener('input', (e) => {
    const t = e.target;
    if (t.classList.contains('item-text')) {
      updateItem(state.date, t.dataset.id, { t: t.value });
      const info = $('#selbar .selbar-info b');
      if (info && activeItem && activeItem.id === t.dataset.id) info.textContent = t.value || 'New task';
      clearTimeout(summaryTimer);
      summaryTimer = setTimeout(updateSummary, 400);
    } else if (t.classList.contains('ghost-text')) {
      const value = t.value;
      checkpoint([state.date]);
      addItemAt(state.date, +t.dataset.m, +t.dataset.len, value);
    } else if (t.id === 'popText') {
      if (t.dataset.id) {
        // editing a task in the week editor
        const it = updateItem(activeItem.date, t.dataset.id, { t: t.value });
        const card = it && $(`.wk-card[data-id="${it.id}"] span`);
        if (card) card.textContent = t.value || '·';
      } else if (sel && selSlots().length === 1 && t.value.trim()) {
        // first letters typed into an empty slot's editor: create the task and keep typing in it
        const u = selSlots()[0], value = t.value;
        checkpoint([sel.date]);
        addItemAt(sel.date, u.m, u.L, value);
      }
    }
  });
  // Clicking into a task makes it the active one (shows its time slider)
  document.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t.classList && t.classList.contains('item-text')) {
      if (!activeItem || activeItem.id !== t.dataset.id) { setActiveItem(state.date, t.dataset.id); paintSel(); }
    }
  });

  document.addEventListener('dblclick', (e) => {
    // day view: double-click an event's title to rename it
    const title = e.target.closest('.tblock.event .ev-title');
    if (title) { const blk = title.closest('.tblock'); openEventEditor(state.date, +blk.dataset.ei, blk); return; }
    // week view: double-click a slot or block to open that day
    const cell = e.target.closest('.wk-slot, .wk-card');
    if (!cell) return;
    const date = cell.dataset.date;
    let m = +cell.dataset.m;
    if (cell.classList.contains('wk-card')) {
      const it = cell.dataset.id ? findItem(date, cell.dataset.id) : null;
      const ev = cell.dataset.ei != null ? eventsOn(date)[+cell.dataset.ei] : null;
      m = viewUnitAt(date, (it || ev || { s: 0 }).s).m;
    }
    clearFocus();
    sel = { date, a: m, b: m };
    go('day', date);
    const slot = $(`.slot[data-m="${m}"]:not(.cont)`);
    if (slot) slot.scrollIntoView({ block: 'center' });
  });

  const repositionPop = () => { if (!$('#wkpop').hidden) positionPopover(popAnchors()); };
  window.addEventListener('resize', repositionPop);
  window.addEventListener('scroll', repositionPop, { passive: true });
  document.addEventListener('scroll', repositionPop, { passive: true, capture: true });

  const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
  const ARROWS = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' };

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    // Undo (inside text boxes the browser's own text undo applies instead)
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && !isTyping(t)) {
      e.preventDefault();
      undo();
      return;
    }

    // Slider thumbs: ← / → move to the previous / next slot boundary
    if (t.classList && t.classList.contains('range-thumb') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      const r = t.closest('.range');
      const key = r.dataset.date, id = r.dataset.id;
      const it = findItem(key, id);
      if (!it) return;
      const which = t.dataset.thumb;
      const bounds = gridBounds(key);
      const cur = which === 's' ? it.s : it.e;
      const next = e.key === 'ArrowLeft' ? [...bounds].reverse().find((b) => b < cur) : bounds.find((b) => b > cur);
      if (next == null) return;
      const s = which === 's' ? next : it.s, en = which === 'e' ? next : it.e;
      if (s >= en) return;
      applyItemTime(key, id, s, en);
      const again = $(`.range [data-thumb="${which}"]`);
      if (again) again.focus();
      return;
    }

    // Typing in a slot: Enter / ↑ / ↓ jump between boxes, Esc stops typing
    if (t.classList && (t.classList.contains('item-text') || t.classList.contains('ghost-text'))) {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const all = $$('.item-text, .ghost-text');
        const j = all.indexOf(t) + ((e.key === 'ArrowUp' || (e.key === 'Enter' && e.shiftKey)) ? -1 : 1);
        if (all[j]) { all[j].focus(); all[j].scrollIntoView({ block: 'nearest' }); }
      } else if (e.key === 'Escape') {
        t.blur();
      }
      return;
    }

    // Typing in the week editor
    if (t.id === 'popText') {
      if (e.key === 'Escape') { e.preventDefault(); closePopover(); return; }
      if (e.key === 'Enter' && t.dataset.id) { e.preventDefault(); closePopover(); return; }
      const dir = ARROWS[e.key];
      const atStart = t.selectionStart === 0 && t.selectionEnd === 0;
      const atEnd = t.selectionStart === t.value.length && t.selectionEnd === t.value.length;
      if (!t.dataset.id && (dir === 'up' || dir === 'down' || (dir === 'left' && atStart) || (dir === 'right' && atEnd))) {
        e.preventDefault();
        navSel(dir, e.shiftKey && (dir === 'up' || dir === 'down'));
        focusPopText();
      }
      return;
    }

    if (isTyping(t) || e.metaKey || e.ctrlKey || e.altKey) return;
    if ($('#settings').open) return;

    const dir = ARROWS[e.key];
    if (dir) {
      e.preventDefault();
      if (state.view === 'year') { if (dir === 'left' || dir === 'right') step(dir === 'left' ? -1 : 1); return; }
      navSel(dir, e.shiftKey);
      return;
    }

    const k = e.key.toLowerCase();
    if ((sel || activeItem || activeEvent) && state.view !== 'year') {
      if (k === 'g' || k === 'y' || k === 'r') { rateCurrent(k); e.preventDefault(); return; }
      if (k === 'backspace' || k === 'delete') { deleteCurrent(); e.preventDefault(); return; }
      if (k === 'escape') { if (itemMenuFor) { itemMenuFor = null; paintSel(); return; } clearFocus(); paintSel(); return; }
    }
    if (sel && state.view !== 'year') {
      if (k === '-' || k === '_') { selResize(-1); e.preventDefault(); return; }
      if (k === '+' || k === '=') { selResize(1); e.preventDefault(); return; }
      if (k === 'm') { mergeSel(); e.preventDefault(); return; }
      if (k === 'enter') {
        e.preventDefault();
        if (state.view === 'week') { focusPopText(); return; }
        // open the task that starts in this slot, or create one covering the selection
        const u = viewUnitAt(sel.date, sel.b);
        const existing = itemsOf(sel.date).find((i) => i.s >= u.m && i.s < u.m + u.L);
        if (existing) { setActiveItem(sel.date, existing.id); render(); focusItemInput(existing.id); }
        else { const span = selSpan(); checkpoint([sel.date]); addItemAt(sel.date, span[0], span[1] - span[0]); }
        return;
      }
    }
    if (e.key === '[') step(-1);
    else if (e.key === ']') step(1);
    else if (k === 't') { go(null, londonNow().date); if (state.view === 'day') scrollToNow(true); }
    else if (k === 'd') go('day');
    else if (k === 'w') go('week');
  });

  // ----- Pointer handling: selection, drag & drop, time slider (mouse and touch) -----
  function startMoveDrag(e, date, id) {
    // dragging a task that sits in a multi-slot selection moves every task in that selection
    const it = findItem(date, id);
    const u = unitAt(date, it.s);
    const inSel = sel && sel.date === date && u.m >= selRange()[0] && u.m <= selRange()[1] && selSlots().length > 1;
    const ids = inSel ? selSlots().flatMap((x) => x.items.map((i) => i.id)) : [id];
    drag = { move: true, started: false, x: e.clientX, y: e.clientY, from: { date, ids, anchor: u.m, grab: id }, target: null };
  }
  function showGhost(d) {
    const it = findItem(d.from.date, d.from.grab) || {};
    const g = $('#dragGhost');
    g.textContent = d.from.ids.length > 1 ? `${d.from.ids.length} tasks` : (it.t || STATUS_LABEL[it.st] || 'Task');
    g.className = 'drag-ghost' + (it.st ? ' s-' + it.st : '');
    g.hidden = false;
  }
  function clearDropMarks() { $$('.drop-target').forEach((x) => x.classList.remove('drop-target')); }
  function startSliderDrag(e, rangeEl, which) {
    const key = rangeEl.dataset.date, id = rangeEl.dataset.id;
    const it = findItem(key, id);
    if (!it) return;
    drag = { slider: true, el: rangeEl, which, key, id, s: it.s, e: it.e, lo: +rangeEl.dataset.lo, hi: +rangeEl.dataset.hi };
    rangeEl.classList.add('dragging');
    moveSlider(e);
  }
  function moveSlider(e) {
    const d = drag;
    const r = $('.range-track', d.el).getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const minute = d.lo + frac * (d.hi - d.lo);
    const v = snapThumb(d.key, d.which, minute, d.s, d.e, d.lo, d.hi);
    if (d.which === 's') d.s = v; else d.e = v;
    paintSlider(d.el, d.s, d.e);
    previewRange(d.key, d.s, d.e);
  }

  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    const t = e.target;

    // time slider: grab a thumb, or click the track to move the nearest end there
    const rangeEl = t.closest('.range');
    if (rangeEl) {
      e.preventDefault();
      let which = t.dataset && t.dataset.thumb;
      if (!which) {
        const r = $('.range-track', rangeEl).getBoundingClientRect();
        const lo = +rangeEl.dataset.lo, hi = +rangeEl.dataset.hi;
        const minute = lo + ((e.clientX - r.left) / r.width) * (hi - lo);
        which = Math.abs(minute - +rangeEl.dataset.s) <= Math.abs(minute - +rangeEl.dataset.e) ? 's' : 'e';
      }
      startSliderDrag(e, rangeEl, which);
      return;
    }

    if (state.view === 'week') {
      if (t.closest('.wk-del')) return; // handled as a click
      const card = t.closest('.wk-card');
      if (card) {
        e.preventDefault();
        const date = card.dataset.date;
        if (card.dataset.kind === 'item') {
          const it = findItem(date, card.dataset.id);
          if (!it) return;
          const r = card.closest('.wk-col').getBoundingClientRect();
          const grab = dayRange()[0] + (e.clientY - r.top) / WPPM;
          drag = { weekMove: true, id: it.id, from: date, to: date, el: card, x: e.clientX, y: e.clientY, started: false, offset: grab - it.s, s: it.s, e: it.e, ns: it.s };
        }
        else { clearFocus(); activeEvent = { date, i: +card.dataset.ei }; paintSel(); }
        return;
      }
      const cell = t.closest('.wk-slot');
      if (!cell) {
        // clicking anywhere outside the editor closes it
        if ((sel || activeItem || activeEvent) && !t.closest('#wkpop') && !t.closest('#toast') && !t.closest('#evEdit')) closePopover();
        return;
      }
      e.preventDefault();
      const m = +cell.dataset.m, date = cell.dataset.date;
      activeItem = null; activeEvent = null;
      if (e.shiftKey && sel && sel.date === date) sel.b = m;
      else sel = { date, a: m, b: m };
      drag = { week: true, moved: false };
      paintSel();
      return;
    }
    if (state.view !== 'day') return;

    // resize a task by dragging its top / bottom edge
    const rz = t.closest('.rz');
    if (rz) {
      e.preventDefault();
      const it = findItem(state.date, rz.dataset.id);
      if (!it) return;
      if (!activeItem || activeItem.id !== it.id) { setActiveItem(state.date, it.id); paintSel(); }
      const el = $(`.tblock.item[data-id="${it.id}"]`);
      drag = { dayResize: true, key: state.date, id: it.id, which: rz.dataset.rz, s: it.s, e: it.e, el };
      if (el) el.classList.add('resizing');
      document.body.classList.add('resizing-v');
      return;
    }
    // move a task: drag the block (or its ⠿ handle); a plain click puts the cursor in its text
    const block = t.closest('.tblock.item');
    if (block && !t.closest('input, button')) {
      e.preventDefault();
      const it = findItem(state.date, block.dataset.id);
      if (!it) return;
      drag = { dayMove: true, key: state.date, id: it.id, el: block, x: e.clientX, y: e.clientY, started: false, offset: laneMinute(e.clientY) - it.s, s: it.s, e: it.e, ns: it.s };
      return;
    }
    const hourLabel = t.closest('.hour-label');
    if (hourLabel) {
      e.preventDefault();
      activeItem = null;
      const h = +hourLabel.dataset.h;
      const first = viewUnitAt(state.date, h * 60).m, last = lastUnitInHour(state.date, h).m;
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
    if (t.closest('input, button, select, textarea, form, .tblock')) return;
    // empty slot: click to add a task there, drag to select a time window
    const slot = t.closest('.slot.bg');
    if (!slot) return;
    e.preventDefault();
    const ae = document.activeElement;
    const wasEditing = !!activeItem || !!(ae && ae.classList && ae.classList.contains('item-text'));
    if (ae && isTyping(ae)) ae.blur();
    const m = +slot.dataset.m;
    activeItem = null;
    if (e.shiftKey && sel && sel.date === state.date) { sel.b = m; drag = { daySel: true, moved: true }; }
    else { sel = { date: state.date, a: m, b: m }; drag = { daySel: true, moved: false, create: !wasEditing }; }
    paintSel();
  });

  document.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const autoScroll = () => {
      if (e.clientY < 90) window.scrollBy(0, -14);
      else if (e.clientY > window.innerHeight - 50) window.scrollBy(0, 14);
    };
    if (drag.slider) { moveSlider(e); return; }

    // week grid: drag a task to another time and/or day
    if (drag.weekMove) {
      const d = drag;
      if (!d.started) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return; // still a click
        d.started = true;
        d.el.classList.add('moving');
        document.body.classList.add('dragging');
        $('#wkpop').hidden = true;
      }
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const col = under && under.closest('.wk-col');
      if (col) {
        const [lo] = dayRange();
        const r = col.getBoundingClientRect();
        const len = d.e - d.s;
        d.to = col.dataset.date;
        d.ns = Math.min(1440 - len, Math.max(0, nearestBound(d.to, lo + (e.clientY - r.top) / WPPM - d.offset)));
        if (d.el.parentElement !== col) col.appendChild(d.el);
        d.el.style.top = `${(d.ns - lo) * WPPM}px`;
        d.el.style.left = '0';
        d.el.style.width = 'calc(100% - 6px)';
        const tm = $('.wk-time', d.el);
        if (tm) tm.textContent = `${hm(d.ns)}–${hm(d.ns + len)}`;
      }
      autoScroll();
      return;
    }
    // day grid: stretch a task by its edge
    if (drag.dayResize) {
      const d = drag;
      const v = snapThumb(d.key, d.which, laneMinute(e.clientY), d.s, d.e, 0, 1440);
      if (d.which === 's') d.s = v; else d.e = v;
      if (d.el) moveBlockEl(d.el, d.s, d.e);
      const r = $(`#selbar .range[data-id="${d.id}"]`);
      if (r) paintSlider(r, d.s, d.e);
      autoScroll();
      return;
    }
    // day grid: move a task up or down, snapping to slot boundaries
    if (drag.dayMove) {
      const d = drag;
      if (!d.started) {
        if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return; // still a click
        d.started = true;
        d.el.classList.add('moving');
        document.body.classList.add('dragging');
      }
      const len = d.e - d.s;
      // dropping on the inbox card unschedules the task
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const inbox = under && under.closest('#inboxCard');
      d.toInbox = !!inbox;
      $$('#inboxCard').forEach((x) => x.classList.toggle('drop-into', d.toInbox));
      d.el.classList.toggle('to-inbox', d.toInbox);
      if (!d.toInbox) {
        d.ns = Math.min(1440 - len, Math.max(0, nearestBound(d.key, laneMinute(e.clientY) - d.offset)));
        moveBlockEl(d.el, d.ns, d.ns + len);
        autoScroll();
      }
      return;
    }
    // day grid: drag across empty slots to select a time window
    if (drag.daySel) {
      if (!sel) return;
      const u = viewUnitAt(sel.date, Math.max(0, Math.min(1439, laneMinute(e.clientY))));
      if (u && u.m !== sel.b) { sel.b = u.m; drag.moved = true; paintSel(); }
      autoScroll();
      return;
    }

    if (drag.move) {
      if (!drag.started) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return; // still a click
        drag.started = true;
        document.body.classList.add('dragging');
        $('#wkpop').hidden = true;
        showGhost(drag);
      }
      const g = $('#dragGhost');
      g.style.left = `${e.clientX + 14}px`;
      g.style.top = `${e.clientY + 10}px`;
      clearDropMarks();
      drag.target = null;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const cell = el && el.closest(state.view === 'week' ? '.wk-slot' : '.slot');
      if (cell) {
        const toDate = cell.dataset.date || state.date;
        const delta = +cell.dataset.m - drag.from.anchor;
        const moving = drag.from.ids.map((id) => findItem(drag.from.date, id)).filter(Boolean);
        if (moving.every((it) => it.s + delta >= 0 && it.e + delta <= 1440)) {
          drag.target = { date: toDate, delta };
          const units = unitsOfDay(toDate);
          for (const it of moving) {
            for (const u of unitsOverlapping(units, it.s + delta, it.e + delta)) {
              const sel2 = state.view === 'week' ? `.wk-slot[data-date="${toDate}"][data-m="${u.m}"]` : `.slot[data-m="${u.m}"]`;
              $$(sel2).forEach((x) => x.classList.add('drop-target'));
            }
          }
        }
      }
      autoScroll();
      return;
    }

    if (!sel) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (drag.week) {
      const cell = el && el.closest('.wk-slot');
      if (cell && cell.dataset.date === sel.date && +cell.dataset.m !== sel.b) {
        sel.b = +cell.dataset.m;
        drag.moved = true;
        paintSel();
      }
      autoScroll();
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
        sel = { date: state.date, a: viewUnitAt(state.date, lo * 60).m, b: lastUnitInHour(state.date, hi).m };
        paintSel();
      } else if (m !== sel.b) {
        sel.b = m;
        drag.moved = true;
        paintSel();
      }
    }
    autoScroll();
  });

  const endDrag = (e) => {
    if (!drag) return;
    const up = e && e.type === 'pointerup';
    if (drag.weekMove) {
      const d = drag;
      drag = null;
      document.body.classList.remove('dragging');
      if (!d.started) { // just a click: open its editor
        setActiveItem(d.from, d.id);
        paintSel();
        focusPopText();
        return;
      }
      if (up && (d.to !== d.from || d.ns !== d.s) && moveItems(d.from, [d.id], d.to, d.ns - d.s)) {
        setActiveItem(d.to, d.id);
        render();
        toast(`Moved to ${fmt(d.to, { weekday: 'short' })} ${hm(d.ns)}`, true);
      } else render();
      return;
    }
    if (drag.dayResize) {
      const d = drag;
      drag = null;
      document.body.classList.remove('resizing-v');
      if (d.el) d.el.classList.remove('resizing');
      if (up) applyItemTime(d.key, d.id, d.s, d.e);
      if (!up || !findItem(d.key, d.id) || (findItem(d.key, d.id).s === d.s && findItem(d.key, d.id).e === d.e)) render();
      return;
    }
    if (drag.dayMove) {
      const d = drag;
      drag = null;
      document.body.classList.remove('dragging');
      if (!d.started) { // just a click: start typing in it
        setActiveItem(d.key, d.id);
        paintSel();
        focusItemInput(d.id);
        return;
      }
      $$('#inboxCard').forEach((x) => x.classList.remove('drop-into'));
      if (up && d.toInbox) {
        const it = findItem(d.key, d.id);
        if (!it) { render(); return; }
        checkpoint([d.key]);
        addToInbox(it.t || 'Task', it.e - it.s);
        removeItem(d.key, d.id);
        activeItem = null;
        render();
        toast(`“${it.t || 'Task'}” moved to the inbox${it.rec ? ' (this date only)' : ''}`, true);
        return;
      }
      if (up && d.ns !== d.s) {
        checkpoint([d.key]);
        updateItem(d.key, d.id, { s: d.ns, e: d.ns + (d.e - d.s) });
        setActiveItem(d.key, d.id);
        render();
        toast(`Moved to ${hm(d.ns)}`, true);
      } else render();
      return;
    }
    if (drag.daySel) {
      const d = drag;
      drag = null;
      if (!d.moved && up) {
        if (d.create && sel) {
          // a plain click on an empty slot adds a task there
          const u = viewUnitAt(sel.date, sel.a);
          const date = sel.date;
          sel = null;
          checkpoint([date]);
          addItemAt(date, u.m, u.L);
        } else { sel = null; paintSel(); } // clicking away from a task just deselects it
      }
      return;
    }
    if (drag.slider) {
      const d = drag;
      drag = null;
      d.el.classList.remove('dragging');
      $$('.range-preview').forEach((x) => x.classList.remove('range-preview'));
      if (e && e.type === 'pointerup') applyItemTime(d.key, d.id, d.s, d.e);
      else paintSel();
      return;
    }
    if (drag.move) {
      const d = drag;
      drag = null;
      $('#dragGhost').hidden = true;
      document.body.classList.remove('dragging');
      clearDropMarks();
      if (!d.started) {
        // just a click on a task: make it the active one
        setActiveItem(d.from.date, d.from.grab);
        paintSel();
        if (state.view === 'week') focusPopText();
        return;
      }
      if (e && e.type === 'pointerup' && d.target && moveItems(d.from.date, d.from.ids, d.target.date, d.target.delta)) {
        if (d.from.ids.length === 1) setActiveItem(d.target.date, d.from.grab);
        else { activeItem = null; const u = viewUnitAt(d.target.date, (findItem(d.target.date, d.from.grab) || {}).s || 0); sel = { date: d.target.date, a: u.m, b: u.m }; }
        render();
        toast(d.from.ids.length > 1 ? `Moved ${d.from.ids.length} tasks` : 'Task moved', true);
      } else {
        paintSel();
      }
      return;
    }
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

  // ---------------------------------------------------------------------------
  // Outlook sync
  // ---------------------------------------------------------------------------
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
          if (res.status === 404 || res.status === 405 || res.status === 501) {
            msg = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
              ? 'Calendar sync needs the planner server. Start it with "python3 server.py".'
              : 'This site has no calendar relay yet. Redeploy it with the api/ folder (api/ics.js) included.';
          }
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
  // Settings
  // ---------------------------------------------------------------------------
  const dlg = $('#settings');
  function fillSettings() {
    const s = data.settings;
    $('#setDefault').value = String(s.defaultSlots);
    $('#setStart').innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hm(h * 60)}</option>`).join('');
    $('#setEnd').innerHTML = Array.from({ length: 24 }, (_, i) => `<option value="${i + 1}">${hm((i + 1) * 60)}</option>`).join('');
    $('#setStart').value = String(s.startHour);
    $('#setEnd').value = String(s.endHour);
    $('#icsUrl').value = cal.url || '';
    renderCatList();
    updateCalStatus();
    updateNotifyStatus();
    updateSyncUI();
    $('#helpBox').innerHTML = helpCard();
  }

  function renderCatList() {
    const cats = data.settings.categories;
    $('#catList').innerHTML = cats.map((c, i) => `
      <div class="cat-row" data-i="${i}">
        <input type="color" data-f="color" value="${esc(c.color)}" title="Colour">
        <div class="cat-fields">
          <input data-f="name" value="${esc(c.name)}" placeholder="Category name" autocomplete="off">
          <input data-f="kw" value="${esc(c.kw)}" placeholder="Keywords, comma separated" autocomplete="off">
          <label class="check small"><input type="checkbox" data-f="attend" ${c.attend ? 'checked' : ''}> Rate as Attended / Missed</label>
        </div>
        <div class="cat-btns">
          <button type="button" class="mini" data-cat="up" ${i === 0 ? 'disabled' : ''} title="Move up (checked earlier)">↑</button>
          <button type="button" class="mini" data-cat="del" title="Delete category">×</button>
        </div>
      </div>`).join('') + `
      <div class="cat-row other">
        <input type="color" data-f="other" value="${esc(data.settings.otherColor)}" title="Colour">
        <div class="cat-fields"><span>Other <span class="muted small">(no keyword matched)</span></span>
          <label class="check small"><input type="checkbox" data-f="otherAttend" ${data.settings.otherAttend ? 'checked' : ''}> Rate as Attended / Missed</label></div>
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
    if (f === 'otherAttend') { data.settings.otherAttend = e.target.checked; categoriesChanged(); return; }
    const row = e.target.closest('.cat-row');
    const c = data.settings.categories[+row.dataset.i];
    if (!c) return;
    c[f] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
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
    data.settings.categories.push({ id: uid(), name: 'New category', color: palette[data.settings.categories.length % palette.length], kw: '', attend: true });
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
    data.settings.otherAttend = true;
    renderCatList();
    categoriesChanged();
  });
  // Clicking the dimmed backdrop (outside the box) closes Settings
  let backdropDown = false;
  const outsideBox = (e) => {
    if (e.target !== dlg) return false;
    const r = dlg.getBoundingClientRect();
    return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
  };
  dlg.addEventListener('pointerdown', (e) => { backdropDown = outsideBox(e); });
  dlg.addEventListener('click', (e) => {
    if (backdropDown && outsideBox(e)) dlg.close();
    backdropDown = false;
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
      migrateAll();
      clearFocus();
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
    clearFocus();
    flush();
    fillSettings();
    render();
  });

  // ---------------------------------------------------------------------------
  // Reflection, inbox and ready tasks (day view sidebar)
  // ---------------------------------------------------------------------------
  const replaceCard = (id, html) => { const el = $(`#${id}`); if (el) el.outerHTML = html; };
  document.addEventListener('click', (e) => {
    const t = e.target;
    const rb = t.closest('[data-refl]');
    if (rb) {
      const day = ensureDay(state.date);
      const f = rb.dataset.refl, v = +rb.dataset.v;
      day.refl[f] = day.refl[f] === v ? 0 : v; // click the same value again to clear it
      save();
      replaceCard('reflCard', reflectionCard(state.date));
      return;
    }
    const ibDel = t.closest('[data-ib-del]');
    if (ibDel) {
      checkpoint([]);
      data.inbox = data.inbox.filter((x) => x.id !== ibDel.dataset.ibDel);
      save();
      replaceCard('inboxCard', inboxCard());
      toast('Removed from inbox', true);
      return;
    }
    const rdDel = t.closest('[data-rd-del]');
    if (rdDel) {
      checkpoint([]);
      data.ready = data.ready.filter((x) => x.id !== rdDel.dataset.rdDel);
      save();
      replaceCard('readyCard', readyCard());
      toast('Ready task removed', true);
    }
  });
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'reflNote') return;
    ensureDay(state.date).refl.note = e.target.value;
    save();
  });
  document.addEventListener('change', (e) => {
    const sel2 = e.target.closest('[data-ib-dur]');
    if (!sel2) return;
    const x = data.inbox.find((i) => i.id === sel2.dataset.ibDur);
    if (x) { x.dur = +sel2.value; save(); }
  });
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f.matches('[data-inbox-add]')) {
      e.preventDefault();
      const t = f.elements.t.value.trim();
      if (!t) return;
      addToInbox(t, 30);
      replaceCard('inboxCard', inboxCard());
      const again = $('#inboxCard input[name="t"]');
      if (again) again.focus();
    } else if (f.matches('[data-ready-add]')) {
      e.preventDefault();
      const t = f.elements.t.value.trim();
      if (!t) return;
      data.ready.push({ id: uid(), icon: f.elements.icon.value.trim(), t, dur: +f.elements.dur.value || 30 });
      save();
      replaceCard('readyCard', readyCard());
    }
  });
  function addToInbox(t, d) {
    data.inbox.push({ id: uid(), t, dur: DURS.includes(+d) ? +d : Math.max(5, Math.min(240, +d || 30)) });
    save();
  }

  // ----- Drag a to-do / ready task from the sidebar into the day -----
  let pdrag = null;
  document.addEventListener('pointerdown', (e) => {
    if (e.button > 0 || state.view !== 'day') return;
    const src = e.target.closest('.drag-src');
    if (!src || e.target.closest('button, select, input')) return;
    const list = src.dataset.src === 'inbox' ? data.inbox : data.ready;
    const x = list.find((i) => i.id === src.dataset.id);
    if (!x) return;
    e.preventDefault();
    e.stopPropagation();
    pdrag = { src: src.dataset.src, id: x.id, t: x.t, dur: x.dur || 30, x: e.clientX, y: e.clientY, started: false, s: null };
  }, true);
  document.addEventListener('pointermove', (e) => {
    if (!pdrag) return;
    if (!pdrag.started) {
      if (Math.hypot(e.clientX - pdrag.x, e.clientY - pdrag.y) < 5) return;
      pdrag.started = true;
      document.body.classList.add('dragging');
      const g = $('#dragGhost');
      g.className = 'drag-ghost';
      g.hidden = false;
    }
    const g = $('#dragGhost');
    g.style.left = `${e.clientX + 14}px`;
    g.style.top = `${e.clientY + 10}px`;
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const lane = under && under.closest('.tg-lane');
    pdrag.s = null;
    if (lane) {
      const u = viewUnitAt(state.date, Math.max(0, Math.min(1439, laneMinute(e.clientY))));
      if (u) {
        pdrag.s = u.m;
        const end = Math.min(1440, u.m + pdrag.dur);
        previewRange(state.date, u.m, end);
        g.textContent = `${pdrag.t} · ${hm(u.m)}–${hm(end)}`;
      }
    } else {
      $$('.range-preview').forEach((x) => x.classList.remove('range-preview'));
      g.textContent = pdrag.t;
    }
    if (e.clientY < 90) window.scrollBy(0, -14);
    else if (e.clientY > window.innerHeight - 50) window.scrollBy(0, 14);
  });
  const endPdrag = (e) => {
    if (!pdrag) return;
    const d = pdrag;
    pdrag = null;
    $('#dragGhost').hidden = true;
    document.body.classList.remove('dragging');
    $$('.range-preview').forEach((x) => x.classList.remove('range-preview'));
    if (!d.started || e.type !== 'pointerup' || d.s == null) return;
    checkpoint([state.date]);
    const it = addItem(state.date, d.s, Math.min(1440, d.s + d.dur), { t: d.t });
    if (d.src === 'inbox') data.inbox = data.inbox.filter((x) => x.id !== d.id);
    save();
    setActiveItem(state.date, it.id);
    render();
    toast(`${d.t} scheduled at ${hm(d.s)}`, true);
  };
  document.addEventListener('pointerup', endPdrag);
  document.addEventListener('pointercancel', endPdrag);

  // ---------------------------------------------------------------------------
  // Quick add by typing, e.g. "gym tomorrow 7-8 weekly", "call mum fri 6pm for 30m", "buy milk"
  // ---------------------------------------------------------------------------
  const WD_NAMES = { mon: 0, monday: 0, tue: 1, tues: 1, tuesday: 1, wed: 2, weds: 2, wednesday: 2, thu: 3, thur: 3, thurs: 3, thursday: 3, fri: 4, friday: 4, sat: 5, saturday: 5, sun: 6, sunday: 6 };
  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const WD_RE = '(monday|mon|tuesday|tues|tue|wednesday|weds|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun)';
  const MON_RE = '(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)';
  function nextWeekday(fromKey, wd, forceNext) {
    let k = fromKey;
    for (let i = 0; i < 7; i++) { if (dow(k) === wd && !(forceNext && i === 0)) break; k = addDays(k, 1); }
    if (forceNext && k === fromKey) k = addDays(k, 7);
    return k;
  }
  function parseQuick(text) {
    let s = ` ${text.trim()} `;
    const today = londonNow().date;
    const r = { title: '', date: null, s: null, e: null, freq: null, dur: null };
    const take = (re, fn) => {
      const m = re.exec(s);
      if (!m) return false;
      fn(m);
      s = s.slice(0, m.index) + ' ' + s.slice(m.index + m[0].length);
      return true;
    };
    // repeat
    take(/\b(every\s*day|daily)\b/i, () => { r.freq = 'daily'; }) ||
      take(/\b(every\s+weekday|weekdays)\b/i, () => { r.freq = 'weekdays'; }) ||
      take(/\b(every\s+(2|two|other)\s+weeks?|fortnightly|biweekly)\b/i, () => { r.freq = 'biweekly'; }) ||
      take(/\b(every\s+month|monthly)\b/i, () => { r.freq = 'monthly'; }) ||
      take(new RegExp(`\\bevery\\s+${WD_RE}\\b`, 'i'), (m) => { r.freq = 'weekly'; r.date = nextWeekday(today, WD_NAMES[m[1].toLowerCase()]); }) ||
      take(/\b(every\s+week|weekly)\b/i, () => { r.freq = 'weekly'; });
    // duration
    take(/\bfor\s+(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b/i, (m) => { r.dur = Math.round(parseFloat(m[1]) * (/^h/i.test(m[2]) ? 60 : 1)); });
    // time range or single time
    const T = '(\\d{1,2})(?:[:.](\\d{2}))?\\s*(am|pm)?';
    const toMin = (h, mm, ap, fallbackAp) => {
      h = +h; mm = +(mm || 0);
      const a = (ap || fallbackAp || '').toLowerCase();
      if (a === 'pm' && h < 12) h += 12;
      else if (a === 'am' && h === 12) h = 0;
      else if (!a && h >= 1 && h <= 6) h += 12; // "3" without am/pm most likely means 3pm
      return h * 60 + mm;
    };
    let matched = take(new RegExp(`\\b(?:from\\s+)?${T}\\s*(?:-|–|—|to|until|till)\\s*${T}(?![\\w:])`, 'i'), (m) => {
      const ap2 = m[6] || '';
      let a = toMin(m[1], m[2], m[3] || (ap2 && +m[1] <= +m[4] ? ap2 : ''), '');
      let b = toMin(m[4], m[5], ap2, m[3]);
      if (b <= a && b + 720 <= 1440) b += 720;
      r.s = a; r.e = Math.min(1440, b);
    });
    if (!matched) {
      take(new RegExp(`\\b(?:at\\s+)?(\\d{1,2})(?:[:.](\\d{2}))\\s*(am|pm)?\\b|\\b(?:at\\s+)?(\\d{1,2})\\s*(am|pm)\\b|\\bat\\s+(\\d{1,2})\\b`, 'i'), (m) => {
        if (m[1] != null) r.s = toMin(m[1], m[2], m[3]);
        else if (m[4] != null) r.s = toMin(m[4], 0, m[5]);
        else r.s = toMin(m[6], 0, '');
      });
      if (r.s != null) r.e = Math.min(1440, r.s + (r.dur || 60));
    }
    if (/\btonight\b/i.test(s) && r.s != null && r.s < 720) { r.s += 720; r.e = Math.min(1440, r.e + 720); }
    // dates
    if (!r.date) {
      take(/\b(today|tonight)\b/i, () => { r.date = today; }) ||
        take(/\b(day after tomorrow)\b/i, () => { r.date = addDays(today, 2); }) ||
        take(/\b(tomorrow|tmrw|tmr)\b/i, () => { r.date = addDays(today, 1); }) ||
        take(/\bin\s+(\d+)\s+days?\b/i, (m) => { r.date = addDays(today, +m[1]); }) ||
        // explicit dates first, so "tue 10 nov" uses the date (and drops the weekday word)
        take(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => { r.date = `${m[1]}-${m[2]}-${m[3]}`; }) ||
        take(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MON_RE}\\b`, 'i'), (m) => { r.date = dateFrom(+m[1], MONTHS[m[2].slice(0, 3).toLowerCase()] || MONTHS[m[2].slice(0, 4).toLowerCase()], today); }) ||
        take(new RegExp(`\\b${MON_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, 'i'), (m) => { r.date = dateFrom(+m[2], MONTHS[m[1].slice(0, 3).toLowerCase()], today); }) ||
        take(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/, (m) => { r.date = dateFrom(+m[1], +m[2], today, m[3]); }) ||
        take(new RegExp(`\\b(next\\s+)?${WD_RE}\\b`, 'i'), (m) => { r.date = nextWeekday(today, WD_NAMES[m[2].toLowerCase()], !!m[1]); });
    }
    if (r.date) take(new RegExp(`\\b(on\\s+)?${WD_RE}\\b,?`, 'i'), () => {}); // a leftover weekday word isn't part of the title
    r.title = s.replace(/\s+/g, ' ').trim().replace(/^(at|on|from|to|for)\s+/i, '').replace(/\s+(at|on|from|to|for)$/i, '').trim();
    if (r.title) r.title = r.title[0].toUpperCase() + r.title.slice(1);
    return r;
  }
  function dateFrom(d, mo, today, y) {
    if (!mo || !d) return null;
    let year = y ? (+y < 100 ? 2000 + +y : +y) : +today.slice(0, 4);
    let k = `${year}-${pad(mo)}-${pad(d)}`;
    if (!y && k < today) k = `${year + 1}-${pad(mo)}-${pad(d)}`; // "12 Jan" in December means next January
    return validKey(k) && !isNaN(parseKey(k)) ? k : null;
  }
  function describeQuick(r) {
    if (!r.title && r.s == null) return '';
    if (r.s == null) return `📥 Inbox · “${r.title || 'Untitled'}”${r.dur ? ` · ${dur(r.dur)}` : ''}`;
    const date = r.date || quickDefaultDate();
    return `📅 ${fmt(date, { weekday: 'short', day: 'numeric', month: 'short' })} · ${hm(r.s)}–${hm(r.e)}${r.freq ? ` · ↻ ${REPEAT_LABEL[r.freq].toLowerCase()}` : ''} · “${r.title || 'Untitled'}”`;
  }
  const quickDefaultDate = () => (state.view === 'day' ? state.date : londonNow().date);
  function quickAdd(text) {
    const r = parseQuick(text);
    if (!r.title && r.s == null) return;
    if (r.s == null) {
      checkpoint([]);
      addToInbox(r.title || 'Untitled', r.dur || 30);
      render();
      toast(`Added “${r.title}” to the inbox`, true);
      return;
    }
    const date = r.date || quickDefaultDate();
    checkpoint([date]);
    if (r.freq) {
      data.series.push({ id: uid(), t: r.title, s: r.s, e: r.e, freq: r.freq, anchor: date, start: date, until: null });
      save();
    } else addItem(date, r.s, r.e, { t: r.title });
    render();
    const where = `${fmt(date, { weekday: 'short', day: 'numeric', month: 'short' })} ${hm(r.s)}`;
    const onScreen = (state.view === 'day' && state.date === date) || (state.view === 'week' && weekStartOf(date) === weekStartOf(state.date));
    toast(`Added “${r.title}” · ${where}${r.freq ? ' · repeating' : ''}`, true, onScreen ? null : { label: 'Show', fn: () => go('day', date) });
  }
  document.addEventListener('input', (e) => {
    if (e.target.id !== 'quickAdd') return;
    $('#qaPreview').textContent = e.target.value.trim() ? describeQuick(parseQuick(e.target.value)) : '';
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.id !== 'quickAdd') return;
    if (e.key === 'Enter') {
      e.preventDefault();
      const v = e.target.value.trim();
      if (!v) return;
      quickAdd(v);
      e.target.value = '';
      $('#qaPreview').textContent = '';
    } else if (e.key === 'Escape') { e.target.value = ''; $('#qaPreview').textContent = ''; e.target.blur(); }
  });

  // ---------------------------------------------------------------------------
  // Day templates: save a day's tasks + slot layout, apply them to another day
  // ---------------------------------------------------------------------------
  function renderTplMenu(anchor) {
    const box = $('#tplMenu');
    const list = data.templates.map((tp) => `<div class="tpl-row">
        <span class="tpl-name" title="${esc(tp.items.map((i) => `${hm(i.s)} ${i.t}`).join('\n'))}">${esc(tp.name)} <span class="muted">· ${tp.items.length} task${tp.items.length === 1 ? '' : 's'}</span></span>
        <button class="btn primary" data-tpl-apply="${tp.id}">Apply</button>
        <button class="x" data-tpl-del="${tp.id}" title="Delete template">×</button></div>`).join('');
    box.innerHTML = `
      <div class="pop-head"><div><b>Day templates</b> <span class="muted">· ${fmt(state.date, { weekday: 'short', day: 'numeric', month: 'short' })}</span></div>
        <button class="x-btn" data-tpl-close title="Close (Esc)">✕</button></div>
      ${list ? `<div class="tpl-list">${list}</div>
        <label class="check small"><input type="checkbox" id="tplReplace"> Clear this day's tasks first</label>` : '<div class="muted small">No templates yet. Plan a typical day, then save it here.</div>'}
      <div class="pop-label">Save this day as a template</div>
      <form class="tpl-save" data-tpl-save><input id="tplName" placeholder="Name, e.g. “Uni day”" autocomplete="off"><button class="btn" type="submit">Save</button></form>`;
    box.hidden = false;
    if (anchor) positionPopover([anchor], box);
  }
  const closeTplMenu = () => { const b = $('#tplMenu'); if (b) b.hidden = true; };
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-act="templates"]')) {
      if (!$('#tplMenu').hidden) closeTplMenu(); else renderTplMenu(t.closest('[data-act="templates"]'));
      return;
    }
    if (t.closest('[data-tpl-close]')) { closeTplMenu(); return; }
    const del = t.closest('[data-tpl-del]');
    if (del) {
      checkpoint([]);
      data.templates = data.templates.filter((x) => x.id !== del.dataset.tplDel);
      save();
      renderTplMenu($('[data-act="templates"]'));
      toast('Template deleted', true);
      return;
    }
    const ap = t.closest('[data-tpl-apply]');
    if (ap) {
      const tp = data.templates.find((x) => x.id === ap.dataset.tplApply);
      if (!tp) return;
      const key = state.date;
      checkpoint([key]);
      const day = ensureDay(key);
      if ($('#tplReplace') && $('#tplReplace').checked) day.items = [];
      for (const i of tp.items) day.items.push({ id: uid(), s: i.s, e: i.e, t: i.t, st: '' });
      if (tp.div) { day.div = { ...tp.div }; day.base = tp.base || day.base; }
      save();
      closeTplMenu();
      render();
      toast(`Applied “${tp.name}” (${tp.items.length} tasks)`, true);
    }
  });
  document.addEventListener('submit', (e) => {
    if (!e.target.matches('[data-tpl-save]')) return;
    e.preventDefault();
    const name = $('#tplName').value.trim();
    const day = getDay(state.date);
    const items = itemsOf(state.date).filter((i) => !i.rec && (i.t || '').trim()).map((i) => ({ s: i.s, e: i.e, t: i.t }));
    if (!items.length) { toast('Add some tasks to this day first'); return; }
    if (!name) { $('#tplName').focus(); return; }
    checkpoint([]);
    const existing = data.templates.find((x) => x.name.toLowerCase() === name.toLowerCase());
    const tp = { id: existing ? existing.id : uid(), name, items, div: day ? { ...day.div } : {}, base: day ? day.base : data.settings.defaultSlots };
    data.templates = existing ? data.templates.map((x) => (x === existing ? tp : x)) : [...data.templates, tp];
    save();
    renderTplMenu($('[data-act="templates"]'));
    toast(existing ? `Updated template “${name}”` : `Saved template “${name}”`, true);
  });
  document.addEventListener('pointerdown', (e) => {
    const b = $('#tplMenu');
    if (b && !b.hidden && !e.target.closest('#tplMenu') && !e.target.closest('[data-act="templates"]')) closeTplMenu();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeTplMenu(); });

  // ---------------------------------------------------------------------------
  // Keep several open tabs in sync (otherwise the last tab to save wins)
  // ---------------------------------------------------------------------------
  window.addEventListener('storage', (e) => {
    if (e.key === STORE && e.newValue) {
      if (saveTimer) return; // this tab has unsaved edits of its own; they'll be written shortly
      try { data = normalize(JSON.parse(e.newValue)); } catch (err) { return; }
      resetCategoryCache();
      if (migrateAll()) save();
      if (sel) { try { normalizeSel(); } catch (err) { sel = null; } }
      if (!isTypingSomewhere() && !drag) render();
    } else if (e.key === CAL_STORE && e.newValue) {
      try { cal = { ...cal, ...JSON.parse(e.newValue) }; } catch (err) { return; }
      if (!isTypingSomewhere() && !drag) render();
    }
  });

  // ---------------------------------------------------------------------------
  // Sync across devices (end-to-end encrypted; server side: api/sync.js on Vercel, server.py locally)
  // Your username + password derive (a) an account id and (b) an encryption key, in the browser.
  // Only the id and the encrypted data are sent; the server never sees your plans or password.
  // ---------------------------------------------------------------------------
  const SYNC_STORE = 'planner365.sync', SYNC_BASE = 'planner365.syncbase';
  let sync = null;     // { user, id, key, rev, last }
  let syncBase = null; // JSON of the last version both sides agreed on (for merging)
  try { sync = JSON.parse(localStorage.getItem(SYNC_STORE)) || null; } catch (e) { sync = null; }
  try { syncBase = localStorage.getItem(SYNC_BASE); } catch (e) { syncBase = null; }
  const syncState = { busy: false, error: '', again: false };
  const saveSyncCfg = () => { try { if (sync) localStorage.setItem(SYNC_STORE, JSON.stringify(sync)); else localStorage.removeItem(SYNC_STORE); } catch (e) { /* ignore */ } };
  const setSyncBase = (json) => { syncBase = json; try { if (json == null) localStorage.removeItem(SYNC_BASE); else localStorage.setItem(SYNC_BASE, json); } catch (e) { /* quota */ } };

  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  async function deriveSync(user, pass) {
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('planner365|' + user.trim().toLowerCase()), iterations: 250000 }, base, 512));
    const idBytes = new Uint8Array(await crypto.subtle.digest('SHA-256', bits.slice(32)));
    return { id: [...idBytes].map((b) => b.toString(16).padStart(2, '0')).join(''), key: b64(bits.slice(0, 32)) };
  }
  const aesKey = () => crypto.subtle.importKey('raw', unb64(sync.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
  async function zip(u8, inflate) {
    const S = inflate ? window.DecompressionStream : window.CompressionStream;
    const stream = new Blob([u8]).stream().pipeThrough(new S('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  async function seal(obj) {
    let bytes = new TextEncoder().encode(JSON.stringify(obj));
    let z = false;
    if (window.CompressionStream) { try { bytes = await zip(bytes); z = true; } catch (e) { /* send uncompressed */ } }
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(), bytes));
    return JSON.stringify({ v: 1, z, iv: b64(iv), ct: b64(ct) });
  }
  async function unseal(payload) {
    const p = JSON.parse(payload);
    let bytes = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(p.iv) }, await aesKey(), unb64(p.ct)));
    if (p.z) bytes = await zip(bytes, true);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async function syncApi(body) {
    if (location.protocol === 'file:') throw new Error('Open the planner via "python3 server.py" or your website to sync.');
    const res = await fetch('/api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = {};
    try { j = await res.json(); } catch (e) { /* not JSON */ }
    if (res.status === 404 && j.notFound) return { notFound: true };
    if (res.status === 409) return { conflict: true, ...j };
    if (!res.ok) {
      if (!j.error && [404, 405, 501].includes(res.status)) {
        throw new Error(/^(localhost|127\.0\.0\.1)$/.test(location.hostname)
          ? 'Sync needs the planner server: start it with "python3 server.py".'
          : 'This site has no sync storage yet (see the README: connect Upstash Redis in Vercel).');
      }
      throw new Error(j.error || `Sync failed (HTTP ${res.status})`);
    }
    return j;
  }
  const localDoc = () => ({ data, calUrl: cal.url || '' });

  // Three-way merge, day by day: a day changed on only one side takes that side's version;
  // changed on both sides keeps this device's. First sync on a device: the account's copy wins,
  // and days only this device has are kept (and uploaded).
  function mergeDocs(B, L, R) {
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const pick = (b, l, r) => {
      if (!B) return r !== undefined ? r : l;
      if (same(l, b)) return r;
      if (same(r, b)) return l;
      return l;
    };
    const out = { data: { ...R.data }, calUrl: pick(B && B.calUrl, L.calUrl, R.calUrl) || '' };
    for (const f of ['settings', 'series', 'inbox', 'ready', 'templates']) out.data[f] = pick(B && B.data[f], L.data[f], R.data[f]);
    const days = {};
    const keys = new Set([...Object.keys(L.data.days || {}), ...Object.keys(R.data.days || {}), ...Object.keys((B && B.data.days) || {})]);
    for (const k of keys) {
      const v = pick(B ? B.data.days[k] : undefined, L.data.days[k], R.data.days[k]);
      if (v) days[k] = v;
    }
    out.data.days = days;
    return out;
  }
  function adoptDoc(doc) {
    data = normalize(JSON.parse(JSON.stringify(doc.data)));
    migrateAll();
    resetCategoryCache();
    if (doc.calUrl && doc.calUrl !== cal.url) {
      cal = { url: doc.calUrl, fetchedAt: 0, error: '', byDate: {}, allDay: {} };
      saveCal();
      setTimeout(syncCalendar, 0);
    }
    try { localStorage.setItem(STORE, JSON.stringify(data)); } catch (e) { /* quota */ }
    if (sel) { try { normalizeSel(); } catch (e) { sel = null; } }
    if (!isTypingSomewhere() && !drag) render();
  }

  let syncTimer = null;
  function schedulePush() {
    if (!sync) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => syncNow(), 2000);
  }
  async function syncNow(opts = {}) {
    if (!sync) return;
    if (syncState.busy) { syncState.again = true; return; }
    syncState.busy = true;
    syncState.error = '';
    updateSyncUI();
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        const res = await syncApi({ op: 'get', id: sync.id });
        let L = localDoc();
        if (res.notFound) {
          if (opts.signingIn) throw new Error('No account found for that username and password.');
        } else if (res.rev !== sync.rev) {
          // something new on the server: merge it in
          const R = await unseal(res.payload);
          const B = syncBase ? JSON.parse(syncBase) : null;
          const M = mergeDocs(B, L, R);
          sync.rev = res.rev;
          setSyncBase(JSON.stringify(R));
          saveSyncCfg();
          if (JSON.stringify(M) !== JSON.stringify(L)) adoptDoc(M);
          L = localDoc();
          if (JSON.stringify(L) === syncBase) break; // identical to the server now
        } else if (JSON.stringify(L) === syncBase) break; // nothing new on either side
        const put = await syncApi({ op: 'put', id: sync.id, rev: res.notFound ? 0 : res.rev, payload: await seal(L) });
        if (put.conflict) continue; // another device saved in between: merge again
        sync.rev = put.rev;
        setSyncBase(JSON.stringify(L));
        saveSyncCfg();
        break;
      }
      sync.last = Date.now();
      saveSyncCfg();
    } catch (e) {
      syncState.error = e.message || String(e);
      if (opts.signingIn) throw e;
    } finally {
      syncState.busy = false;
      updateSyncUI();
      if (syncState.again) { syncState.again = false; schedulePush(); }
    }
  }
  function updateSyncUI() {
    const txt = !sync
      ? (syncState.error ? `⚠ ${syncState.error}` : 'Not signed in: your plans are saved in this browser only.')
      : syncState.busy ? `Signed in as ${sync.user} · syncing…`
        : syncState.error ? `Signed in as ${sync.user} · ⚠ ${syncState.error}`
          : `Signed in as ${sync.user} · synced ${sync.last ? ago(sync.last) : 'not yet'}`;
    const st = $('#syncStatus');
    if (st) st.textContent = txt;
    if ($('#syncIn')) { $('#syncIn').hidden = !sync; $('#syncOut').hidden = !!sync; }
    const badge = $('#syncBadge');
    if (badge) {
      badge.hidden = !sync;
      badge.textContent = syncState.busy ? '☁ …' : syncState.error ? '☁ ⚠' : '☁ ✓';
      badge.title = txt + ' (click to sync now)';
      badge.classList.toggle('error', !!syncState.error);
    }
  }
  async function signIn(create) {
    const user = $('#syncUser').value.trim(), pass = $('#syncPass').value;
    const st = $('#syncStatus');
    if (!user || pass.length < 8) { st.textContent = 'Enter a username and a password of at least 8 characters.'; return; }
    if (!window.crypto || !crypto.subtle) { st.textContent = 'Sync needs a secure page (https or localhost).'; return; }
    st.textContent = create ? 'Creating your account…' : 'Signing in…';
    const prev = sync, prevBase = syncBase;
    try {
      const k = await deriveSync(user, pass);
      sync = { user, id: k.id, key: k.key, rev: 0, last: 0 };
      setSyncBase(null);
      if (create) {
        const res = await syncApi({ op: 'get', id: sync.id });
        if (!res.notFound) throw new Error('An account with this username and password already exists. Use “Sign in”.');
        await syncNow();
        if (syncState.error) throw new Error(syncState.error);
      } else {
        await syncNow({ signingIn: true });
      }
      saveSyncCfg();
      $('#syncPass').value = '';
      updateSyncUI();
      toast(create ? 'Account created: this device now syncs' : 'Signed in: your planner is synced');
    } catch (e) {
      sync = prev;
      setSyncBase(prevBase);
      saveSyncCfg();
      syncState.error = '';
      updateSyncUI();
      st.textContent = `⚠ ${e.message || e}`;
    }
  }
  $('#syncSignIn').addEventListener('click', () => signIn(false));
  $('#syncCreate').addEventListener('click', () => signIn(true));
  $('#syncPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); signIn(false); } });
  $('#syncNow').addEventListener('click', () => syncNow());
  $('#syncSignOut').addEventListener('click', () => {
    if (!confirm('Sign out on this device? Your plans stay in this browser; they just stop syncing.')) return;
    sync = null;
    setSyncBase(null);
    saveSyncCfg();
    syncState.error = '';
    updateSyncUI();
  });
  $('#syncBadge').addEventListener('click', () => syncNow());
  window.addEventListener('focus', () => { if (sync) syncNow(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && sync) syncNow(); });

  // ---------------------------------------------------------------------------
  // Notifications when a task, event or slot ends, with quick rating buttons (see sw.js)
  // ---------------------------------------------------------------------------
  let swReg = null;
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').then((r) => { swReg = r; }).catch(() => {});
    navigator.serviceWorker.addEventListener('message', (e) => {
      const msg = e.data || {};
      if (msg.type === 'rate') applyQuickRate(msg);
      else if (msg.type === 'open') openSlot(msg.date, +msg.m);
    });
  }
  // msg: { date, kind: 'item' | 'event' | 'slot', id?, ek?, m, L, s }
  function applyQuickRate(msg) {
    const { date, kind, s } = msg;
    if (!validKey(date) || !['g', 'y', 'r'].includes(s)) return;
    checkpoint([date]);
    let label = STATUS_LABEL[s], what = '';
    if (kind === 'item') {
      const it = findItem(date, msg.id);
      if (!it) return;
      updateItem(date, it.id, { st: s });
      what = it.t || 'Task';
    } else if (kind === 'event') {
      const ev = eventsOn(date).find((x) => evKey(x) === msg.ek);
      if (!ev) return;
      setEvStatus(date, ev, s);
      what = ev.t;
      if (evPart(ev)) label = ATTEND_LABEL[s] || label;
    } else {
      const m = +msg.m, L = +msg.L;
      if (!(m >= 0 && m < 1440 && L > 0)) return;
      const existing = itemsOf(date).find((i) => i.s === m && i.e === m + L);
      if (existing) updateItem(date, existing.id, { st: s }); else addItem(date, m, m + L, { st: s });
      what = hm(m);
    }
    flush(); // save now so other tabs see it straight away
    if (!isTypingSomewhere() && !drag) render();
    toast(`${what}: ${label}`, true);
  }
  function openSlot(date, m) {
    if (!validKey(date)) return;
    clearFocus();
    const u = bgUnitsOfDay(date).find((x) => x.m <= (m || 0) && (m || 0) < x.m + x.L);
    sel = { date, a: u.m, b: u.m };
    go('day', date);
    const el = $(`.slot[data-m="${u.m}"]:not(.cont)`);
    if (el) el.scrollIntoView({ block: 'center' });
  }

  // A short two-note chime. Browsers only allow sound after you've clicked/typed in the page once.
  let audioCtx = null;
  function unlockAudio() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) { /* no audio */ }
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true });
  document.addEventListener('keydown', unlockAudio, { passive: true });
  function chime() {
    if (!audioCtx || audioCtx.state !== 'running') return false;
    const t0 = audioCtx.currentTime;
    [[880, 0], [1318.5, 0.18]].forEach(([f, dt]) => {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.25, t0 + dt + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.6);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.65);
    });
    return true;
  }

  // target: { kind: 'item', id } | { kind: 'event', ev } | { kind: 'slot', m, L }
  async function notifyFor(date, target, opts = {}) {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    let s0, e0, label, part = false, d;
    if (target.kind === 'item') {
      const it = findItem(date, target.id);
      if (!it) return;
      s0 = it.s; e0 = it.e; label = it.t || 'Untitled task';
      d = { kind: 'item', id: it.id };
    } else if (target.kind === 'event') {
      const ev = target.ev;
      s0 = ev.s; e0 = ev.e; label = `📅 ${ev.t}`; part = evPart(ev);
      d = { kind: 'event', ek: evKey(ev) };
    } else {
      s0 = target.m; e0 = target.m + target.L; label = 'Nothing planned';
      d = { kind: 'slot' };
    }
    const range = `${hm(s0)}–${hm(e0)}`;
    const tag = `${d.kind}-${date}-${d.id || d.ek || s0}`;
    // with several tabs open, only the first one to notice sends the notification
    try {
      if (!opts.test && localStorage.getItem('planner365.lastNotified') === tag) return;
      localStorage.setItem('planner365.lastNotified', tag);
    } catch (e) { /* ignore */ }
    Object.assign(d, { date, m: s0, L: e0 - s0, range, label, tag });
    let actions, title;
    if (part) {
      title = `${range}: did you attend?`;
      actions = [{ action: 'g', title: '✓ Attended' }, { action: 'r', title: '✗ Missed' }];
    } else {
      title = `${range} is over. How did it go?`;
      actions = Notification.maxActions >= 3
        ? [{ action: 'g', title: '✅ Completed' }, { action: 'y', title: '🟡 Not efficient' }, { action: 'r', title: '🔴 Distracted' }]
        : [{ action: 'g', title: '✅ Completed' }, { action: 'no', title: 'Not completed…' }];
    }
    const played = !opts.quiet && data.settings.notify.sound && chime();
    const body = label + (opts.test ? ' (test: rating it marks your current slot)' : '');
    try {
      if (swReg) {
        await swReg.showNotification(title, { body, tag, data: d, actions, requireInteraction: true, renotify: true, silent: !!played || !!opts.quiet });
        return;
      }
    } catch (e) { /* fall back below */ }
    const plain = new Notification(title, { body: `${body} · click to rate`, tag });
    plain.onclick = () => { window.focus(); openSlot(date, s0); plain.close(); };
  }

  // Each check looks for anything whose end time passed since the previous check
  // (every 10 s; background tabs may only check about once a minute).
  let lastCheck = null;
  function checkSlotEnd() {
    if (!data.settings.notify.on) { lastCheck = null; return; }
    const now = londonNow();
    if (!lastCheck || lastCheck.date !== now.date || now.min < lastCheck.min) { lastCheck = { date: now.date, min: now.min }; return; }
    const from = lastCheck.min, to = now.min;
    if (to === from) return;
    lastCheck.min = to;
    const key = now.date;
    const { startHour: sh, endHour: eh } = data.settings;
    const ended = (e) => e > from && e <= to && e > sh * 60 && e <= eh * 60;
    let n = 0;
    for (const it of itemsOf(key)) if (ended(it.e) && !it.st) notifyFor(key, { kind: 'item', id: it.id }, { quiet: n++ > 0 });
    for (const ev of eventsOn(key)) if (ended(ev.e) && !evStatus(key, ev)) notifyFor(key, { kind: 'event', ev }, { quiet: n++ > 0 });
    if (data.settings.notify.scope === 'all') {
      for (const u of unitsOfDay(key)) {
        if (ended(u.m + u.L) && !u.items.length && !u.evs.length && !looseEvents(key, u).length) notifyFor(key, { kind: 'slot', m: u.m, L: u.L }, { quiet: n++ > 0 });
      }
    }
  }

  function updateNotifyStatus() {
    const n = data.settings.notify;
    const supported = 'Notification' in window && window.isSecureContext;
    const granted = supported && Notification.permission === 'granted';
    let txt;
    if (!('Notification' in window)) txt = 'This browser doesn’t support notifications.';
    else if (!window.isSecureContext) txt = 'Notifications only work over https or on localhost.';
    else if (Notification.permission === 'denied') txt = 'Notifications are blocked for this site. Click the icon left of the address bar → allow Notifications, then try again.';
    else if (n.on && granted) txt = `On: you'll be asked to rate each task, event and slot as it ends.${Notification.maxActions >= 3 ? '' : ' (This browser shows 2 buttons per notification, so “Not completed…” opens a second question.)'}`;
    else txt = 'Off.';
    $('#notifyStatus').textContent = txt;
    $('#notifyOn').textContent = n.on && granted ? 'Turn off notifications' : 'Turn on notifications';
    $('#notifyScope').value = n.scope;
    $('#notifySound').checked = !!n.sound;
  }
  $('#notifyOn').addEventListener('click', async () => {
    const n = data.settings.notify;
    unlockAudio();
    if (n.on && Notification.permission === 'granted') n.on = false;
    else if ('Notification' in window && window.isSecureContext) {
      const p = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      n.on = p === 'granted';
    }
    save();
    lastCheck = null;
    checkSlotEnd();
    updateNotifyStatus();
  });
  $('#notifyTest').addEventListener('click', async () => {
    unlockAudio();
    if (!('Notification' in window)) { updateNotifyStatus(); return; }
    if (Notification.permission !== 'granted' && (await Notification.requestPermission()) !== 'granted') { updateNotifyStatus(); return; }
    const now = londonNow();
    const u = unitAt(now.date, now.min);
    notifyFor(now.date, { kind: 'slot', m: u.m, L: u.L }, { test: true });
    updateNotifyStatus();
  });
  $('#notifyScope').addEventListener('change', (e) => { data.settings.notify.scope = e.target.value; save(); });
  $('#notifySound').addEventListener('change', (e) => { data.settings.notify.sound = e.target.checked; save(); });

  // Rating links opened by a notification when no planner tab was open (?rate=… / ?open=…)
  (() => {
    const qp = new URLSearchParams(location.search);
    const rate = qp.get('rate'), open = qp.get('open');
    if (!rate && !open) return;
    history.replaceState(null, '', location.pathname);
    setTimeout(() => {
      try {
        if (rate) applyQuickRate(JSON.parse(rate));
        if (open) { const o = JSON.parse(open); openSlot(o.date, +o.m); }
      } catch (e) { /* ignore malformed links */ }
    }, 0);
  })();

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  render();
  if (state.view === 'day') scrollToNow(false);
  setInterval(paintNow, 1000);
  setInterval(checkSlotEnd, 10000);
  checkSlotEnd();
  if (cal.url && Date.now() - (cal.fetchedAt || 0) > 60 * 1000) syncCalendar();
  setInterval(() => { if (cal.url) syncCalendar(); }, CAL_REFRESH_MS);
  updateSyncUI();
  if (sync) syncNow();
  setInterval(() => { if (sync && !document.hidden) syncNow(); }, 60 * 1000);
})();
