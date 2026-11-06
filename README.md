# 365 Planner

A day planner that splits your day into time slots (15 minutes by default) and lets you rate each one when it's done.

- **Adjustable slot length per hour.** Use − / + to switch between 60, 30, 20, 15, 12, 10, 6 and 5 minutes. Select a range of slots to resize, label, rate or merge them all at once.
- **Ratings:** 🟢 completed · 🟡 wasn't efficient enough · 🔴 not attempted / distracted. The day summary turns these into a focus score.
- **Day, week and year views.** Each day has its own goals list. The week view lets you edit slots in place. The year view colours every day by focus score.
- **Live "now" slot** in London time.
- **Outlook calendar (read-only).** Events from a published ICS link appear as one merged slot each, colour-coded by keyword categories you can edit.
- **Stored in your browser** (localStorage), with JSON export/import for backups.

## Run it

```bash
python3 server.py        # then open http://localhost:8365
```

No dependencies: plain HTML/CSS/JS plus the Python standard library. `server.py` serves the app and relays your Outlook ICS feed, because browsers can't fetch it directly. Without the server you can still open `index.html` directly, but calendar sync won't work.

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
