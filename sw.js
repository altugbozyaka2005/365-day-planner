// Service worker for 365 Planner: handles the buttons on "time's up" notifications,
// so a task, event or slot can be rated without opening the app.
//
// Chrome shows at most two buttons per notification, so rating is a quick two-step:
//   1st notification:  ✅ Completed   |  Not completed…
//   follow-up:         🔴 Distracted  |  🟡 Not efficient
// Events you attend (lectures, meetings…) just ask ✓ Attended | ✗ Missed.
// Where the browser allows 3+ buttons, all three ratings are offered at once.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

async function sendToApp(msg) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  // one tab applies the change; other tabs pick it up through storage events
  const target = all.find((c) => c.visibilityState === 'visible') || all[0];
  if (target) {
    target.postMessage(msg);
    return target;
  }
  const { type, ...rest } = msg;
  return self.clients.openWindow(`./?${type}=${encodeURIComponent(JSON.stringify(rest))}`);
}

self.addEventListener('notificationclick', (event) => {
  const n = event.notification;
  const d = n.data || {};
  n.close();
  event.waitUntil((async () => {
    if (event.action === 'no') {
      // second step: why wasn't it completed?
      await self.registration.showNotification(`What happened at ${d.range}?`, {
        body: d.label,
        tag: d.tag,
        data: d,
        requireInteraction: true,
        actions: [
          { action: 'r', title: '🔴 Distracted / not attempted' },
          { action: 'y', title: '🟡 Not efficient' },
        ],
      });
      return;
    }
    if (event.action === 'g' || event.action === 'y' || event.action === 'r') {
      await sendToApp({ type: 'rate', date: d.date, kind: d.kind, id: d.id, ek: d.ek, m: d.m, L: d.L, s: event.action });
      return;
    }
    // clicked the notification itself: bring the app forward on that slot
    const c = await sendToApp({ type: 'open', date: d.date, m: d.m });
    if (c && c.focus) { try { await c.focus(); } catch (e) { /* not allowed */ } }
  })());
});
