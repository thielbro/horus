"""
mt_api.py  —  Embeddable wrapper for MarineTraffic scraping.

Drop this into your app and call it when a user clicks a vessel:

    from mt_api import MarineTrafficAPI

    mt = MarineTrafficAPI()
    mt.start()   # one-time login

    # later, when a vessel is clicked:
    data = mt.get_vessel(shipid=12345)
    # or
    data = mt.get_vessel(mmsi=248663000)
    # or
    data = mt.get_vessel(imo=1011094)

    # data is a plain dict:
    # {
    #   "name": "ZEFIRA",
    #   "ship_type": "Sailing Vessel",
    #   "imo": "1011094",
    #   "mmsi": "248663000",
    #   "flag": "MALTA",
    #   "course": "117°",
    #   "speed": "10.3 knots",
    #   "destination": "ZAKINTHOS",
    #   "departure_port": "Genova",
    #   "image_url": "https://...",
    #   "image_local_path": "C:\\...\\ZEFIRA_12345.jpg",
    #   ...
    # }

    mt.stop()  # when your app shuts down
"""

from __future__ import annotations

import asyncio
import atexit
import json
from pathlib import Path
from typing import Any, Dict, Optional

# mt_scraper.py must be in the same directory
from mt_scraper import MTScraper


DEFAULT_EMAIL = "sebpoljanich@gmail.com"
DEFAULT_PASSWORD = "Y91rMwPXj!KnKhExEq3&"
DEFAULT_COOKIE_PATH = "./marinetraffic_cookies.json"
DEFAULT_IMAGE_DIR = "./vessel_images"


class MarineTrafficAPI:
    """
    High-level embeddable API for MarineTraffic vessel lookups.
    Keeps a persistent browser session so repeated queries are fast.
    """

    def __init__(
        self,
        email: str = DEFAULT_EMAIL,
        password: str = DEFAULT_PASSWORD,
        cookie_path: str = DEFAULT_COOKIE_PATH,
        image_dir: str = DEFAULT_IMAGE_DIR,
        headless: bool = True,
    ):
        self._email = email
        self._password = password
        self._cookie_path = cookie_path
        self._image_dir = image_dir
        self._headless = headless

        self._scraper: Optional[MTScraper] = None
        self._started = False

    # ── lifecycle ───────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Launch the scraper, login, and persist cookies. Call once on app startup."""
        if self._started:
            return
        self._scraper = MTScraper(
            email=self._email,
            password=self._password,
            cookie_path=self._cookie_path,
            image_dir=self._image_dir,
            headless=self._headless,
        )
        asyncio.get_event_loop().run_until_complete(self._scraper.start())
        self._started = True
        atexit.register(self.stop)
        print("[MT_API] Ready")

    def stop(self) -> None:
        """Close the browser and save cookies. Call on app shutdown."""
        if not self._started or not self._scraper:
            return
        try:
            asyncio.get_event_loop().run_until_complete(self._scraper.stop())
        except Exception as e:
            print(f"[MT_API] shutdown warning: {e}")
        self._started = False
        print("[MT_API] Stopped")

    # ── queries ─────────────────────────────────────────────────────────────────

    def get_vessel(
        self,
        shipid: Optional[int] = None,
        mmsi: Optional[int] = None,
        imo: Optional[int] = None,
        download_image: bool = True,
        fetch_all_photos: bool = False,
    ) -> Dict[str, Any]:
        """
        Scrape a vessel by shipid, mmsi, or imo.
        Returns a plain dict ready for JSON / frontend use.
        """
        if not self._started:
            raise RuntimeError("Call start() before get_vessel()")
        if not self._scraper:
            raise RuntimeError("Scraper not initialized")

        vessel = asyncio.get_event_loop().run_until_complete(
            self._scraper.query(
                shipid=shipid,
                mmsi=mmsi,
                imo=imo,
                download_image=download_image,
                fetch_all_photos=fetch_all_photos,
            )
        )
        return vessel.to_dict()

    # ── convenience ─────────────────────────────────────────────────────────────

    def get_vessel_json(
        self,
        shipid: Optional[int] = None,
        mmsi: Optional[int] = None,
        imo: Optional[int] = None,
        download_image: bool = True,
        indent: int = 2,
    ) -> str:
        """Same as get_vessel but returns a JSON string."""
        return json.dumps(
            self.get_vessel(shipid, mmsi, imo, download_image),
            indent=indent,
            ensure_ascii=False,
            default=str,
        )


# ── one-shot helper (no persistent session) ───────────────────────────────────

def fetch_vessel(
    shipid: Optional[int] = None,
    mmsi: Optional[int] = None,
    imo: Optional[int] = None,
    *,
    email: str = DEFAULT_EMAIL,
    password: str = DEFAULT_PASSWORD,
    cookie_path: str = DEFAULT_COOKIE_PATH,
    image_dir: str = DEFAULT_IMAGE_DIR,
    headless: bool = True,
) -> Dict[str, Any]:
    """
    One-shot fetch: launches browser, logs in, scrapes, closes.
    Good for cron jobs or one-off scripts.
    """
    from mt_scraper import scrape_vessel as _scrape
    return _scrape(
        shipid=shipid,
        mmsi=mmsi,
        imo=imo,
        email=email,
        password=password,
        cookie_path=cookie_path,
        image_dir=image_dir,
        headless=headless,
    )


# ── minimal self-test ─────────────────────────────────────────────────────────
if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser()
    parser.add_argument("--shipid", type=int)
    parser.add_argument("--mmsi", type=int)
    parser.add_argument("--imo", type=int)
    parser.add_argument("--no-image", action="store_true")
    args = parser.parse_args()

    if not any([args.shipid, args.mmsi, args.imo]):
        print("Usage: python mt_api.py --shipid 12345")
        print("       python mt_api.py --mmsi 248663000")
        exit(1)

    api = MarineTrafficAPI()
    api.start()
    try:
        data = api.get_vessel(
            shipid=args.shipid,
            mmsi=args.mmsi,
            imo=args.imo,
            download_image=not args.no_image,
        )
        print(json.dumps(data, indent=2, ensure_ascii=False, default=str))
    finally:
        api.stop()
