// Vercel serverless function: relays an Outlook calendar (ICS) feed to the planner.
// Browsers can't fetch Outlook's ICS links directly (no CORS), so the app POSTs the
// link here and gets the calendar text back. Same behaviour as server.py, for hosting.
const ALLOWED_HOSTS = ['office365.com', 'outlook.com', 'live.com', 'office.com'];
const MAX_BYTES = 4 * 1024 * 1024; // Vercel functions can return at most ~4.5 MB

function send(res, code, obj) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  let url = String((body && body.url) || '').trim();
  if (url.toLowerCase().startsWith('webcal://')) url = 'https://' + url.slice('webcal://'.length);

  let parsed;
  try { parsed = new URL(url); } catch (e) { parsed = null; }
  const host = parsed ? parsed.hostname.toLowerCase() : '';
  if (!parsed || parsed.protocol !== 'https:' || !ALLOWED_HOSTS.some((d) => host === d || host.endsWith('.' + d))) {
    return send(res, 400, { error: 'Please paste the https ICS link from Outlook (it starts with https://outlook.office365.com/ or https://outlook.live.com/).' });
  }

  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': '365-planner/1.0', Accept: 'text/calendar, */*' },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
    const finalUrl = (r.url || '').toLowerCase();
    if (!r.ok) {
      const gone = finalUrl.includes('error') || [404, 410, 417].includes(r.status);
      return send(res, 502, {
        error: gone
          ? "Outlook says this calendar link doesn't exist. It may have been unpublished or reset; publish it again and paste the new ICS link."
          : `Outlook returned HTTP ${r.status}. Try again in a minute.`,
      });
    }
    const text = await r.text();
    if (!text.includes('BEGIN:VCALENDAR')) {
      return send(res, 502, { error: "That link didn't return a calendar. Check you copied the ICS link, not the HTML one." });
    }
    if (Buffer.byteLength(text) > MAX_BYTES) {
      return send(res, 502, { error: 'This calendar is too large to relay on Vercel’s free tier (over 4 MB).' });
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(text);
  } catch (e) {
    send(res, 502, { error: `Couldn't fetch the calendar: ${e.message || e}` });
  }
};
