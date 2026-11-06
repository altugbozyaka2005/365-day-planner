// Vercel serverless function: stores each account's ENCRYPTED planner data in Upstash Redis.
// The browser encrypts everything before sending it, so this function (and the database) only
// ever sees an opaque account id and ciphertext — never your plans or your password.
//
// Setup (once): Vercel dashboard → your project → Storage → Create / connect "Upstash for Redis"
// (a.k.a. Vercel KV). That adds KV_REST_API_URL + KV_REST_API_TOKEN to the project; redeploy.
const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const MAX_PAYLOAD = 950 * 1024; // keep each save under Upstash's 1 MB request limit

// Save only if nobody else saved in between (optimistic locking with a revision counter).
const CAS = `local cur = tonumber(redis.call('GET', KEYS[2]) or '0')
if cur ~= tonumber(ARGV[1]) then return {0, cur} end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], cur + 1)
return {1, cur + 1}`;

async function redis(cmd) {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
}
function send(res, code, obj) {
  res.status(code).setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { error: 'Use POST' });
  if (!URL_ || !TOKEN) {
    return send(res, 503, { error: 'Sync storage is not connected to this site yet. In Vercel: Storage → Upstash for Redis → connect it to this project, then redeploy.' });
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const id = String(body.id || '');
  if (!/^[a-f0-9]{64}$/.test(id)) return send(res, 400, { error: 'Bad account id' });
  const key = `p365:${id}`, revKey = `p365:${id}:rev`;
  try {
    if (body.op === 'get') {
      const [val, rev] = await Promise.all([redis(['GET', key]), redis(['GET', revKey])]);
      if (!val) return send(res, 404, { notFound: true });
      const v = JSON.parse(val);
      return send(res, 200, { rev: +rev || 0, payload: v.payload, updatedAt: v.updatedAt });
    }
    if (body.op === 'put') {
      const payload = String(body.payload || '');
      if (!payload) return send(res, 400, { error: 'Nothing to save' });
      if (payload.length > MAX_PAYLOAD) return send(res, 413, { error: 'Your planner is too large to sync on the free storage plan.' });
      const value = JSON.stringify({ payload, updatedAt: Date.now() });
      const r = await redis(['EVAL', CAS, '2', key, revKey, String(+body.rev || 0), value]);
      return r[0] === 1 ? send(res, 200, { rev: r[1] }) : send(res, 409, { rev: r[1] });
    }
    return send(res, 400, { error: 'Unknown operation' });
  } catch (e) {
    return send(res, 502, { error: `Sync storage error: ${e.message || e}` });
  }
};
