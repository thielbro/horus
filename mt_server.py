"""
mt_server.py  —  Localhost HTTP sidecar wrapping the MarineTraffic scraper.

The HORUS Next.js API route (/api/marinetraffic) spawns this automatically and
proxies to it. A persistent Playwright session is kept alive so repeat vessel
clicks are fast (login happens once, cookies persist to disk).

Endpoints (127.0.0.1 only):
    GET /health                                  → {"ok": true, "started": bool}
    GET /vessel?mmsi=...|imo=...|shipid=...&photos=1
                                                 → full vessel dict (see mt_scraper.VesselInfo)
    GET /photo?url=https://photos.marinetraffic.com/...
                                                 → raw image bytes via the authed session

Run manually:  python mt_server.py --port 8477
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

from mt_scraper import MTScraper
from mt_api import DEFAULT_EMAIL, DEFAULT_PASSWORD, DEFAULT_COOKIE_PATH, DEFAULT_IMAGE_DIR

EMAIL = os.environ.get("MT_EMAIL", DEFAULT_EMAIL)
PASSWORD = os.environ.get("MT_PASSWORD", DEFAULT_PASSWORD)
COOKIE_PATH = os.environ.get("MT_COOKIE_PATH", DEFAULT_COOKIE_PATH)
IMAGE_DIR = os.environ.get("MT_IMAGE_DIR", DEFAULT_IMAGE_DIR)

ALLOWED_IMAGE_HOSTS = ("photos.marinetraffic.com", "www.marinetraffic.com", "marinetraffic.com")

# Background asyncio loop — the scraper lives here; HTTP threads submit coroutines.
_loop = asyncio.new_event_loop()
threading.Thread(target=_loop.run_forever, daemon=True, name="mt-loop").start()

_scraper: MTScraper | None = None
_lock = asyncio.Lock()  # single page → serialize all scraper work


async def _ensure_scraper() -> MTScraper:
    global _scraper
    if _scraper is None:
        s = MTScraper(
            email=EMAIL,
            password=PASSWORD,
            cookie_path=COOKIE_PATH,
            image_dir=IMAGE_DIR,
            headless=True,
        )
        await s.start()
        _scraper = s
    return _scraper


async def _get_vessel(shipid, mmsi, imo, photos: bool):
    async with _lock:
        scraper = await _ensure_scraper()
        vessel = await scraper.query(
            shipid=shipid,
            mmsi=mmsi,
            imo=imo,
            download_image=False,
            fetch_all_photos=photos,
        )
        return vessel.to_dict()


async def _get_photo(url: str):
    async with _lock:
        scraper = await _ensure_scraper()
        return await scraper.fetch_image_bytes(url)


def _int_or_none(qs, key):
    v = qs.get(key, [None])[0]
    if v is None:
        return None
    v = "".join(ch for ch in v if ch.isdigit())
    return int(v) if v else None


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # quieter default logging
        print(f"[mt_server] {self.address_string()} {fmt % args}")

    def _json(self, status: int, obj) -> None:
        body = json.dumps(obj, ensure_ascii=False, default=str).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # noqa: N802
        parsed = urlparse(self.path)
        qs = parse_qs(parsed.query)

        if parsed.path == "/health":
            self._json(200, {"ok": True, "started": _scraper is not None})
            return

        if parsed.path == "/vessel":
            shipid = _int_or_none(qs, "shipid")
            mmsi = _int_or_none(qs, "mmsi")
            imo = _int_or_none(qs, "imo")
            photos = qs.get("photos", ["1"])[0] not in ("0", "false")
            if not any([shipid, mmsi, imo]):
                self._json(400, {"error": "provide shipid, mmsi, or imo"})
                return
            try:
                fut = asyncio.run_coroutine_threadsafe(
                    _get_vessel(shipid, mmsi, imo, photos), _loop
                )
                data = fut.result(timeout=240)
                self._json(200, {"vessel": data})
            except Exception as e:
                traceback.print_exc()
                self._json(502, {"error": str(e)})
            return

        if parsed.path == "/photo":
            url = qs.get("url", [None])[0]
            host = urlparse(url or "").hostname or ""
            if not url or host not in ALLOWED_IMAGE_HOSTS:
                self._json(400, {"error": "url must be a marinetraffic.com photo"})
                return
            try:
                fut = asyncio.run_coroutine_threadsafe(_get_photo(url), _loop)
                status, ct, body = fut.result(timeout=60)
                self.send_response(status if status == 200 else 502)
                self.send_header("Content-Type", ct)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "public, max-age=86400")
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                traceback.print_exc()
                self._json(502, {"error": str(e)})
            return

        self._json(404, {"error": "unknown endpoint"})


def main() -> None:
    parser = argparse.ArgumentParser(description="MarineTraffic scraper sidecar")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MT_SCRAPER_PORT", 8477)))
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[mt_server] listening on http://127.0.0.1:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
