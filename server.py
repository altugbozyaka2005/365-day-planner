#!/usr/bin/env python3
"""Local server for 365 Planner.

Serves the app files and relays your Outlook calendar (ICS) feed, which
browsers can't fetch directly because Outlook doesn't allow cross-site requests.

Usage:  python3 server.py            -> http://localhost:8365
        python3 server.py 9000       -> http://localhost:9000
"""
import http.server
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8365
# Only Microsoft calendar hosts may be fetched through the relay.
ALLOWED_HOSTS = ("office365.com", "outlook.com", "live.com", "office.com")
MAX_BYTES = 25 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the terminal quiet except for errors
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(fmt, *args)

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/api/ics":
            return self._json(404, {"error": "Not found"})
        if "application/json" not in (self.headers.get("Content-Type") or ""):
            return self._json(415, {"error": "Expected JSON"})
        try:
            length = min(int(self.headers.get("Content-Length") or 0), 10000)
            body = json.loads(self.rfile.read(length) or b"{}")
            url = str(body.get("url", "")).strip()
            if url.lower().startswith("webcal://"):
                url = "https://" + url[len("webcal://"):]
            parsed = urllib.parse.urlparse(url)
            host = (parsed.hostname or "").lower()
            if parsed.scheme != "https" or not any(host == d or host.endswith("." + d) for d in ALLOWED_HOSTS):
                return self._json(400, {"error": "Please paste the https ICS link from Outlook "
                                                 "(it starts with https://outlook.office365.com/ or https://outlook.live.com/)."})
            req = urllib.request.Request(url, headers={"User-Agent": "365-planner/1.0", "Accept": "text/calendar, */*"})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = resp.read(MAX_BYTES)
            text = data.decode("utf-8", "replace")
            if "BEGIN:VCALENDAR" not in text:
                return self._json(502, {"error": "That link didn't return a calendar. Check you copied the ICS link, not the HTML one."})
            out = text.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/calendar; charset=utf-8")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)
        except urllib.error.HTTPError as e:
            final_url = (e.geturl() or "").lower()
            if "error" in final_url or e.code in (404, 410, 417):
                # Outlook redirects unknown/unpublished links to an error page
                msg = "Outlook says this calendar link doesn't exist. It may have been unpublished or reset; publish it again and paste the new ICS link."
            else:
                msg = "Outlook returned HTTP %d. Try again in a minute." % e.code
            self._json(502, {"error": msg})
        except Exception as e:  # network errors, timeouts, bad JSON
            self._json(502, {"error": "Couldn't fetch the calendar: %s" % e})


if __name__ == "__main__":
    server = http.server.ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print("365 Planner running at http://localhost:%d  (Ctrl+C to stop)" % PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
