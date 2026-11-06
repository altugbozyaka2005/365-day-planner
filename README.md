# 365 Planner

A day planner that splits your day into time slots (15 minutes by default) and lets you rate each one when it's done.

- **Adjustable slot length per hour.** Use − / + to switch between 60, 30, 20, 15, 12, 10, 6 and 5 minutes. Select a range of slots to resize, label, rate or merge them all at once.
- **Tasks with their own time window.** Several tasks (and Outlook events) can share a slot and are shown side by side, like a calendar. Drag the two-handle time slider to stretch a task over more slots; a task covering several slots merges them into one.
- **Ratings:** 🟢 completed · 🟡 wasn't efficient enough · 🔴 not attempted / distracted. The day summary turns these into a focus score.
- **Day, week and year views.** Each day has its own goals list. The week view lets you edit slots in place. The year view colours every day by focus score.
- **Live "now" slot** in London time.
- **Outlook calendar (read-only).** Events from a published ICS link appear as one merged slot each, colour-coded by keyword categories you can edit.
- **Stored in your browser** (localStorage), with JSON export/import for backups.

## Run it

```bash
python3 server.py        # then open http://localhost:8365
```

No dependencies: plain HTML/CSS/JS plus the Python standard library. `server.py` serves the app and relays your Outlook ICS feed, because browsers can't fetch it directly. Without the server you can still open `index.html` directly, but calendar sync and notifications won't work.

## Deploy on Vercel

Import the repo into Vercel with no build command and no framework preset. The static files are served as they are, and `api/ics.js` becomes the serverless function at `/api/ics` that relays the calendar, doing the same job as `server.py`.

## Sync across devices (one-time setup on Vercel)

The planner can keep one copy of your data on every device. Data is encrypted in the browser, using a key derived from your username and password (PBKDF2 + AES-GCM), before it's uploaded. The server only ever stores an account ID and unreadable ciphertext.

1. In the Vercel dashboard, open the project and go to **Storage → Create Database → Upstash for Redis** (the free plan is enough). Connect it to this project. Vercel adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically.
2. Redeploy, so `api/sync.js` picks up those settings.
3. In the planner, open **⚙ Settings → Sync across devices**. Choose **Create account** on the first device, then **Sign in** with the same username and password on your other devices.

Locally, `python3 server.py` provides the same sync API and stores the encrypted data in `./.sync-data/`, which is git-ignored.

There's no password reset. If you forget the password, the synced copy can't be decrypted, but each device keeps its own local copy.

## Slot-end notifications

In **⚙ Settings → Slot-end notifications**, click **Turn on notifications**. When each slot ends you get a notification with a chime. Click **✅ Completed** or **Not completed…**, which then asks **🔴 Distracted** or **🟡 Not efficient**. Chrome allows only two buttons per notification, hence the two steps. A bell also rings when a slot ends, even with notifications off; click anywhere in the planner once after opening it so the browser allows sound. These settings apply to each device separately and aren't synced. Keep the planner open in a tab; it can be in the background. On macOS, set Chrome's notifications to **Alerts** in System Settings → Notifications so the buttons stay on screen.

## Connect Outlook

1. In Outlook on the web, go to **Settings → Calendar → Shared calendars → Publish a calendar**.
2. Choose "Can view all details", then copy the **ICS** link.
3. In the planner, open **⚙ Settings → Outlook calendar**, paste the link and click **Connect & sync**.

The link is stored only in your browser and is left out of backup exports. Anyone who has it can read your calendar, so keep it private.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page shell and settings dialog |
| `styles.css` | Styles (light and dark mode) |
| `app.js` | Planner logic: slots, merging, views, goals, storage |
| `calendar.js` | ICS parser: recurring events, exceptions, time zones → London time |
| `server.py` | Local static server + Outlook ICS relay |
| `api/ics.js` | The same ICS relay as a Vercel serverless function |
| `api/sync.js` | Encrypted sync storage (Upstash Redis) as a Vercel serverless function |
| `sw.js` | Service worker that handles the rating buttons on notifications |
