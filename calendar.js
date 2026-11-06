// ICS (iCalendar) parsing for Outlook calendar feeds.
// Produces an index of events per London date: { byDate: { 'YYYY-MM-DD': [{t, s, e, loc}] }, allDay: { 'YYYY-MM-DD': [{t}] } }
// where s/e are minutes from midnight (London time).
window.PlannerCal = (() => {
  'use strict';
  const DAY = 864e5;
  const WD = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  // Outlook often uses Windows time-zone names instead of IANA ones.
  const WINDOWS_TZ = {
    'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
    'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
    'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
    'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
    'E. Europe Standard Time': 'Europe/Chisinau', 'GTB Standard Time': 'Europe/Bucharest',
    'FLE Standard Time': 'Europe/Kiev', 'Turkey Standard Time': 'Europe/Istanbul',
    'Russian Standard Time': 'Europe/Moscow', 'Israel Standard Time': 'Asia/Jerusalem',
    'South Africa Standard Time': 'Africa/Johannesburg', 'Egypt Standard Time': 'Africa/Cairo',
    'Arabian Standard Time': 'Asia/Dubai', 'Arab Standard Time': 'Asia/Riyadh',
    'India Standard Time': 'Asia/Kolkata', 'Pakistan Standard Time': 'Asia/Karachi',
    'SE Asia Standard Time': 'Asia/Bangkok', 'Singapore Standard Time': 'Asia/Singapore',
    'China Standard Time': 'Asia/Shanghai', 'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul',
    'AUS Eastern Standard Time': 'Australia/Sydney', 'E. Australia Standard Time': 'Australia/Brisbane',
    'W. Australia Standard Time': 'Australia/Perth', 'New Zealand Standard Time': 'Pacific/Auckland',
    'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
    'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
    'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
    'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
    'E. South America Standard Time': 'America/Sao_Paulo', 'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  };
  const tzValid = {};
  function resolveTz(tzid) {
    if (!tzid) return 'Europe/London'; // floating time: assume London
    if (/^(utc|gmt|z)$/i.test(tzid)) return 'UTC';
    if (tzValid[tzid] === undefined) {
      try { new Intl.DateTimeFormat('en-GB', { timeZone: tzid }); tzValid[tzid] = true; } catch (e) { tzValid[tzid] = false; }
    }
    if (tzValid[tzid]) return tzid;
    if (WINDOWS_TZ[tzid]) return WINDOWS_TZ[tzid];
    if (/london|dublin|edinburgh|lisbon/i.test(tzid)) return 'Europe/London';
    return 'Europe/London';
  }

  const fmtCache = {};
  function tzOffset(tz, ms) {
    if (tz === 'UTC') return 0;
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }));
    const p = {};
    for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
    return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  }
  function zonedToUtc(y, mo, d, h, mi, s, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    let ms = guess - tzOffset(tz, guess);
    const off2 = tzOffset(tz, ms);
    if (guess - off2 !== ms) ms = guess - off2;
    return ms;
  }

  const dnFrom = (y, mo, d) => Date.UTC(y, mo - 1, d) / DAY;
  const dnOf = (dt) => dnFrom(dt.y, dt.mo, dt.d);
  const wdOf = (dn) => new Date(dn * DAY).getUTCDay();
  const dnKey = (dn) => new Date(dn * DAY).toISOString().slice(0, 10);
  const dnParts = (dn) => { const x = new Date(dn * DAY); return [x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()]; };
  const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

  function parseDT(value, params) {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec((value || '').trim());
    if (!m) return null;
    return {
      y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
      dateOnly: !m[4] || (params && params.VALUE === 'DATE'),
      tz: m[7] ? 'UTC' : resolveTz(params && params.TZID),
    };
  }
  const dtMs = (dt) => zonedToUtc(dt.y, dt.mo, dt.d, dt.h, dt.mi, dt.s, dt.tz);
  function parseDuration(v) {
    const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v || '');
    if (!m) return null;
    const ms = ((+m[2] || 0) * 7 * 86400 + (+m[3] || 0) * 86400 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
    return m[1] === '-' ? -ms : ms;
  }
  const unescapeText = (v) => v.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1').trim();

  function parseICS(text) {
    const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
    const events = [];
    let cur = null, nested = 0;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; nested = 0; continue; }
      if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
      if (!cur) continue;
      if (line.startsWith('BEGIN:')) { nested++; continue; } // e.g. VALARM
      if (line.startsWith('END:')) { nested--; continue; }
      if (nested > 0) continue;
      const i = line.indexOf(':');
      if (i < 0) continue;
      const [rawName, ...rawParams] = line.slice(0, i).split(';');
      const value = line.slice(i + 1);
      const p = {};
      for (const x of rawParams) { const j = x.indexOf('='); if (j > 0) p[x.slice(0, j).toUpperCase()] = x.slice(j + 1).replace(/^"|"$/g, ''); }
      switch (rawName.toUpperCase()) {
        case 'SUMMARY': cur.title = unescapeText(value); break;
        case 'LOCATION': cur.location = unescapeText(value); break;
        case 'DTSTART': cur.start = parseDT(value, p); break;
        case 'DTEND': cur.end = parseDT(value, p); break;
        case 'DURATION': cur.duration = parseDuration(value); break;
        case 'RRULE': cur.rrule = Object.fromEntries(value.split(';').map((kv) => kv.split('=')).map(([k, v]) => [k.toUpperCase(), v])); break;
        case 'EXDATE': for (const v of value.split(',')) cur.exdates.push(parseDT(v, p)); break;
        case 'RECURRENCE-ID': cur.recurrenceId = parseDT(value, p); break;
        case 'UID': cur.uid = value; break;
        case 'STATUS': cur.status = value.toUpperCase(); break;
        case 'CATEGORIES': cur.categories = (cur.categories || []).concat(value.split(',').map(unescapeText).filter(Boolean)); break;
      }
    }
    return events;
  }

  // Expand one VEVENT into concrete occurrences inside [from, to] (ms).
  function expand(ev, from, to, exclude) {
    const st = ev.start, tz = st.tz, allDay = st.dateOnly;
    const startDn = dnOf(st);
    let durMs;
    if (ev.end) durMs = allDay ? (dnOf(ev.end) - startDn) * DAY : dtMs(ev.end) - dtMs(st);
    else if (ev.duration != null) durMs = ev.duration;
    else durMs = allDay ? DAY : 0;
    const durDays = Math.max(1, Math.round(durMs / DAY));

    const exMs = new Set(), exDn = new Set();
    for (const x of ev.exdates) { if (!x) continue; if (x.dateOnly) exDn.add(dnOf(x)); else { exMs.add(dtMs(x)); } }

    const out = [];
    const emit = (dn) => {
      if (allDay) {
        if (exDn.has(dn) || (exclude && exclude.has('d' + dn))) return;
        if (dn * DAY > to || (dn + durDays) * DAY < from) return;
        out.push({ allDay: true, startDn: dn, endDn: dn + durDays });
        return;
      }
      const [y, mo, d] = dnParts(dn);
      const s = zonedToUtc(y, mo, d, st.h, st.mi, st.s, tz);
      if (exMs.has(s) || exDn.has(dn) || (exclude && exclude.has(s))) return;
      if (s + durMs < from || s > to) return;
      out.push({ start: s, end: s + Math.max(durMs, 60000) });
    };

    if (!ev.rrule) { emit(startDn); return out; }

    const r = ev.rrule;
    const freq = (r.FREQ || '').toUpperCase();
    const interval = Math.max(1, +r.INTERVAL || 1);
    const count = r.COUNT ? +r.COUNT : Infinity;
    let until = null;
    if (r.UNTIL) {
      const u = parseDT(r.UNTIL, {});
      if (u) {
        if (u.tz !== 'UTC') u.tz = tz;
        until = u.dateOnly ? { dn: dnOf(u) } : { ms: dtMs(u) };
      }
    }
    const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => {
      const m = /^([+-]?\d+)?(MO|TU|WE|TH|FR|SA|SU)$/.exec(x.trim().toUpperCase());
      return m ? { n: m[1] ? +m[1] : 0, wd: WD[m[2]] } : null;
    }).filter(Boolean) : null;
    const bymd = r.BYMONTHDAY ? r.BYMONTHDAY.split(',').map(Number) : null;
    const bymonth = r.BYMONTH ? r.BYMONTH.split(',').map(Number) : null;
    const setpos = r.BYSETPOS ? r.BYSETPOS.split(',').map(Number) : null;
    const toDn = Math.ceil(to / DAY) + 2;
    const swd = wdOf(startDn);

    function monthCands(y, mo) {
      const first = dnFrom(y, mo, 1), dim = daysInMonth(y, mo);
      let c = [];
      if (byday) {
        for (const b of byday) {
          const days = [];
          for (let d = 0; d < dim; d++) if (wdOf(first + d) === b.wd) days.push(first + d);
          if (b.n > 0) { if (days[b.n - 1] != null) c.push(days[b.n - 1]); }
          else if (b.n < 0) { if (days[days.length + b.n] != null) c.push(days[days.length + b.n]); }
          else c.push(...days);
        }
        if (bymd) c = c.filter((dn) => bymd.some((md) => dn - first + 1 === (md > 0 ? md : dim + md + 1)));
      } else if (bymd) {
        for (const md of bymd) { const d = md > 0 ? md : dim + md + 1; if (d >= 1 && d <= dim) c.push(first + d - 1); }
      } else if (st.d <= dim) c.push(first + st.d - 1);
      c = [...new Set(c)].sort((a, b) => a - b);
      if (setpos) {
        const picked = [];
        for (const p of setpos) { const v = p > 0 ? c[p - 1] : c[c.length + p]; if (v != null) picked.push(v); }
        c = [...new Set(picked)].sort((a, b) => a - b);
      }
      return c;
    }

    let n = 0;
    outer:
    for (let k = 0; k < 200000; k++) {
      let cands = [];
      if (freq === 'DAILY') {
        const dn = startDn + k * interval;
        if (dn > toDn) break;
        if (!byday || byday.some((b) => b.wd === wdOf(dn))) cands = [dn];
      } else if (freq === 'WEEKLY') {
        const wkst = WD[(r.WKST || 'MO').toUpperCase()] ?? 1;
        const weekStart = startDn - ((swd - wkst + 7) % 7) + k * 7 * interval;
        if (weekStart > toDn) break;
        const wds = byday ? byday.map((b) => b.wd) : [swd];
        cands = [...new Set(wds.map((wd) => weekStart + ((wd - wkst + 7) % 7)))].sort((a, b) => a - b);
      } else if (freq === 'MONTHLY') {
        const mi = (st.mo - 1) + k * interval;
        const y = st.y + Math.floor(mi / 12), mo = (mi % 12) + 1;
        if (dnFrom(y, mo, 1) > toDn) break;
        cands = monthCands(y, mo);
      } else if (freq === 'YEARLY') {
        const y = st.y + k * interval;
        if (dnFrom(y, 1, 1) > toDn) break;
        for (const mo of (bymonth || [st.mo])) cands.push(...monthCands(y, mo));
      } else {
        emit(startDn); // unsupported rule: show the first occurrence only
        break;
      }
      for (const dn of cands) {
        if (dn < startDn) continue;
        if (n >= count) break outer;
        if (until) {
          if (until.dn != null ? dn > until.dn : (() => { const [y, mo, d] = dnParts(dn); return zonedToUtc(y, mo, d, st.h, st.mi, st.s, tz) > until.ms; })()) break outer;
        }
        n++;
        emit(dn);
      }
    }
    return out;
  }

  // Split an absolute time range into per-day pieces in London wall-clock time.
  const londonFmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  function londonWall(ms) {
    const p = {};
    for (const x of londonFmt.formatToParts(new Date(ms))) p[x.type] = x.value;
    return { date: `${p.year}-${p.month}-${p.day}`, min: (+p.hour % 24) * 60 + +p.minute };
  }
  function splitLondon(s, e, cb) {
    let cur = s, guard = 0;
    while (cur < e && guard++ < 400) {
      const w = londonWall(cur);
      const segEnd = Math.min(e, cur + (1440 - w.min) * 60000);
      cb(w.date, w.min, Math.min(1440, w.min + Math.max(1, Math.round((segEnd - cur) / 60000))));
      cur = segEnd;
    }
  }

  function buildIndex(text, daysBack = 400, daysAhead = 400) {
    const raw = parseICS(text);
    const now = Date.now(), from = now - daysBack * DAY, to = now + daysAhead * DAY;
    // Modified occurrences of a recurring series replace the original occurrence.
    const overrides = {};
    for (const ev of raw) {
      if (ev.recurrenceId && ev.uid) {
        (overrides[ev.uid] = overrides[ev.uid] || new Set())
          .add(ev.recurrenceId.dateOnly ? 'd' + dnOf(ev.recurrenceId) : dtMs(ev.recurrenceId));
      }
    }
    const byDate = {}, allDay = {};
    let count = 0;
    for (const ev of raw) {
      if (!ev.start || ev.status === 'CANCELLED') continue;
      const title = ev.title || '(No title)';
      const loc = ev.location || '';
      const cats = ev.categories && ev.categories.length ? ev.categories : null;
      for (const occ of expand(ev, from, to, ev.recurrenceId ? null : overrides[ev.uid])) {
        count++;
        if (occ.allDay) {
          for (let dn = occ.startDn; dn < occ.endDn; dn++) (allDay[dnKey(dn)] = allDay[dnKey(dn)] || []).push({ t: title });
        } else {
          splitLondon(occ.start, occ.end, (k, s, e) => (byDate[k] = byDate[k] || []).push(cats ? { t: title, s, e, loc, c: cats } : { t: title, s, e, loc }));
        }
      }
    }
    for (const k in byDate) byDate[k].sort((a, b) => a.s - b.s || b.e - a.e);
    return { byDate, allDay, count };
  }

  return { parseICS, buildIndex };
})();
