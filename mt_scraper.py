"""
mt_scraper.py  —  Robust MarineTraffic vessel scraper for Pro accounts.

Embed in your app like this:

    from mt_scraper import MTScraper

    mt = MTScraper(email="...", password="...")
    mt.start()                       # one-time login + cookie persist
    data = mt.query(shipid=12345)    # returns dict
    data = mt.query(mmsi=248663000)  # resolve MMSI → shipid automatically
    mt.stop()                        # closes browser, saves cookies

Or use the one-shot helper:

    from mt_scraper import scrape_vessel
    data = scrape_vessel(shipid=12345, email="...", password="...")
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from playwright.async_api import async_playwright, Browser, BrowserContext, Page, APIRequestContext


# ── constants ─────────────────────────────────────────────────────────────────
MT_BASE = "https://www.marinetraffic.com"
LOGIN_URL = f"{MT_BASE}/en/users/login"
SHIP_URL = f"{MT_BASE}/en/ais/details/ships/shipid:{{shipid}}"
SHIP_URL_MMSI = f"{MT_BASE}/en/ais/details/ships/mmsi:{{mmsi}}"
SHIP_URL_IMO = f"{MT_BASE}/en/ais/details/ships/imo:{{imo}}"
SEARCH_URL = f"{MT_BASE}/en/ais/index/search/all"
PHOTOS_URL = f"{MT_BASE}/en/photos/of/ships/shipid:{{shipid}}"


# ── data model ────────────────────────────────────────────────────────────────

@dataclass
class VesselInfo:
    """Structured vessel data scraped from MarineTraffic."""

    # identifiers
    name: Optional[str] = None
    ship_type: Optional[str] = None
    imo: Optional[str] = None
    mmsi: Optional[str] = None
    callsign: Optional[str] = None
    flag: Optional[str] = None
    ship_id: Optional[str] = None

    # dimensions
    length_overall: Optional[str] = None
    width: Optional[str] = None
    draught: Optional[str] = None
    gross_tonnage: Optional[str] = None
    deadweight: Optional[str] = None
    year_built: Optional[str] = None

    # position / AIS
    current_position: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    navigational_status: Optional[str] = None
    ais_class: Optional[str] = None
    position_received: Optional[str] = None
    vessel_local_time: Optional[str] = None

    # movement
    speed: Optional[str] = None
    course: Optional[str] = None
    true_heading: Optional[str] = None
    rate_of_turn: Optional[str] = None

    # voyage
    departure_port: Optional[str] = None
    arrival_port: Optional[str] = None
    destination: Optional[str] = None
    reported_destination: Optional[str] = None
    matched_destination: Optional[str] = None
    eta: Optional[str] = None
    reported_eta: Optional[str] = None
    calculated_eta: Optional[str] = None
    distance_travelled: Optional[str] = None
    distance_to_go: Optional[str] = None
    time_to_destination: Optional[str] = None
    actual_departure_time: Optional[str] = None
    voyage_distance: Optional[str] = None

    # environment
    current_wind_speed: Optional[str] = None
    current_wind_direction: Optional[str] = None
    current_air_temperature: Optional[str] = None
    current_sea_state: Optional[str] = None

    # media
    image_url: Optional[str] = None
    image_local_path: Optional[str] = None
    all_images_count: Optional[int] = None
    photos: List[Dict[str, str]] = field(default_factory=list)

    # raw fall-through
    extra: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent, ensure_ascii=False, default=str)


# ── scraper core ──────────────────────────────────────────────────────────────

class MTScraper:
    """
    Persistent headless scraper for MarineTraffic.
    Keeps the browser open so multiple vessel queries are fast.
    """

    def __init__(
        self,
        email: str,
        password: str,
        *,
        cookie_path: str = "./mt_cookies.json",
        image_dir: str = "./mt_images",
        headless: bool = True,
        timeout: int = 30000,
        user_data_dir: Optional[str] = None,
        channel: Optional[str] = "chrome",
    ):
        self.email = email
        self.password = password
        self.cookie_path = Path(cookie_path)
        self.image_dir = Path(image_dir)
        self.headless = headless
        self.timeout = timeout
        # MarineTraffic sits behind Cloudflare, which blocks bundled Chromium in
        # headless mode. Real Chrome (channel="chrome") + a persistent profile
        # passes the bot check and keeps the Pro login across restarts.
        self.channel = channel
        self.user_data_dir = Path(
            user_data_dir or (self.cookie_path.parent / ".mt_profile")
        )
        self._user_agent = (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/131.0.0.0 Safari/537.36"
        )

        self._pw = None
        self._browser: Optional[Browser] = None
        self._context: Optional[BrowserContext] = None
        self._page: Optional[Page] = None
        self._api: Optional[APIRequestContext] = None
        self._started = False

    # ── lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> MTScraper:
        """Launch browser, load cookies, login. Safe to call multiple times."""
        if self._started:
            return self

        self._pw = await async_playwright().start()
        self.user_data_dir.mkdir(parents=True, exist_ok=True)
        args = [
            "--disable-blink-features=AutomationControlled",
            "--disable-dev-shm-usage",
            "--disable-extensions",
        ]
        # Optional window placement for the headed one-time login, e.g.
        #   MT_WINDOW_POSITION="1015,0" MT_WINDOW_SIZE="900,960"
        win_pos = os.environ.get("MT_WINDOW_POSITION")
        win_size = os.environ.get("MT_WINDOW_SIZE")
        if not self.headless and win_pos:
            args.append(f"--window-position={win_pos}")
        if not self.headless and win_size:
            args.append(f"--window-size={win_size}")
        launch_kwargs: Dict[str, Any] = dict(
            headless=self.headless,
            user_agent=self._user_agent,
            # Headed login: let the real OS window drive the size so --window-size
            # takes effect. Headless: pin a viewport for consistent extraction.
            no_viewport=not self.headless,
            viewport=None if not self.headless else {"width": 1440, "height": 900},
            locale="en-US",
            timezone_id="UTC",
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
            args=args,
        )
        # Persistent context = the browser IS the context (real Chrome profile).
        try:
            self._context = await self._pw.chromium.launch_persistent_context(
                str(self.user_data_dir), channel=self.channel, **launch_kwargs
            )
        except Exception as e:
            # Real Chrome not installed — fall back to bundled Chromium. It will
            # likely be Cloudflare-blocked, but at least it starts.
            print(f"[mt] chrome channel unavailable ({e}); falling back to chromium")
            self.channel = None
            self._context = await self._pw.chromium.launch_persistent_context(
                str(self.user_data_dir), channel=None, **launch_kwargs
            )

        self._page = self._context.pages[0] if self._context.pages else await self._context.new_page()
        self._api = self._context.request

        # Seed cookies from the legacy JSON file on first run (before the profile
        # has them); afterwards the persistent profile is the source of truth.
        if self.cookie_path.exists():
            try:
                cookies = json.loads(self.cookie_path.read_text(encoding="utf-8"))
                await self._context.add_cookies(cookies)
                print("[mt] cookies loaded")
            except Exception as e:
                print(f"[mt] cookie load warning: {e}")

        await self._ensure_login()
        await self._save_cookies()
        self._started = True
        return self

    async def stop(self) -> None:
        """Close browser and persist cookies."""
        if self._context:
            await self._save_cookies()
            await self._context.close()  # persistent context closes its browser
            self._context = None
        self._browser = None
        if self._pw:
            await self._pw.stop()
            self._pw = None
        self._started = False

    async def _accept_consent(self) -> None:
        """Dismiss the Cloudflare/Quantcast cookie-consent overlay if present.

        MarineTraffic uses a Quantcast CMP whose accept button lives inside the
        consent iframe/notice; leaving it up can intercept clicks and skew the
        'logged in?' check. Best-effort — silent if nothing matches."""
        labels = ("AGREE", "Agree", "I Accept", "Accept All", "Accept", "Allow all", "Consent", "OK")
        # Quantcast's button carries a stable mode attribute; try it first.
        selectors = [
            "button[mode='primary']",
            ".qc-cmp2-summary-buttons button",
            "button.css-47sehv",
        ] + [f"button:has-text('{l}')" for l in labels]
        for sel in selectors:
            try:
                btn = await self._page.query_selector(sel)
                if btn and await btn.is_visible():
                    await btn.click()
                    await asyncio.sleep(0.4)
                    return
            except Exception:
                pass

    async def _save_cookies(self) -> None:
        if self._context:
            cookies = await self._context.cookies()
            self.cookie_path.parent.mkdir(parents=True, exist_ok=True)
            self.cookie_path.write_text(json.dumps(cookies, indent=2), encoding="utf-8")

    # ── login ────────────────────────────────────────────────────────────────

    async def is_logged_in(self) -> bool:
        """Authoritative login check: hitting the login URL while authenticated
        bounces straight back to the app; otherwise it lands on Kpler auth."""
        await self._page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=self.timeout)
        await asyncio.sleep(3)
        await self._accept_consent()
        url = self._page.url
        return "auth.kpler.com" not in url and "/users/login" not in url

    async def _ensure_login(self) -> bool:
        print("[mt] checking login state...")
        if await self.is_logged_in():
            print("[mt] already logged in (persistent profile)")
            return True
        print("[mt] not logged in — performing login...")
        return await self._login()

    async def _login(self) -> bool:
        """
        MarineTraffic auth is delegated to Kpler (Auth0 universal login), an
        identifier-first flow: email → Continue → password → Continue, then the
        IdP may demand MFA. We fill what we can; if MFA is required the account
        must be authenticated once interactively (see login_interactive), after
        which the persistent Chrome profile keeps the session.
        """
        await self._page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=self.timeout)
        await asyncio.sleep(3)
        await self._accept_consent()

        # If we didn't get bounced to Kpler, we're already in.
        if "auth.kpler.com" not in self._page.url:
            return "auth.kpler.com" not in self._page.url and "/users/login" not in self._page.url

        # Step 1 — identifier (email)
        try:
            await self._page.fill("input#username, input[name='username'], input[type='email']", self.email, timeout=8000)
            await self._page.click("button[name='action'][value='default'], button[type='submit']")
            await self._page.wait_for_load_state("domcontentloaded", timeout=15000)
            await asyncio.sleep(2)
        except Exception as e:
            print(f"[mt] identifier step failed: {e}")
            return False

        # Step 2 — password (identifier-first shows it on the next screen)
        try:
            await self._page.fill("input#password, input[name='password'], input[type='password']", self.password, timeout=8000)
            await self._page.click("button[name='action'][value='default'], button[type='submit']")
            await self._page.wait_for_load_state("networkidle", timeout=20000)
            await asyncio.sleep(3)
        except Exception as e:
            print(f"[mt] password step failed: {e}")
            return False

        url = self._page.url
        if "auth.kpler.com" in url and ("mfa" in url or "enroll" in url):
            print(
                "[mt] LOGIN BLOCKED: the account requires multi-factor "
                "authentication. Run a one-time interactive login to satisfy MFA:\n"
                "      python mt_scraper.py --login   (opens a visible browser)\n"
                "    The persistent Chrome profile keeps the session afterwards."
            )
            return False
        if "auth.kpler.com" in url:
            print(f"[mt] login did not complete — still on auth flow: {url}")
            return False

        print(f"[mt] login OK → {url}")
        await self._save_cookies()
        return True

    async def login_interactive(self, wait_seconds: int = 300) -> bool:
        """One-time human-assisted login (handles MFA/captcha).

        Launch the scraper with headless=False, call this, complete the Kpler
        login + MFA in the visible window, and the persistent profile keeps the
        session for all later headless runs."""
        await self._page.goto(LOGIN_URL, wait_until="domcontentloaded", timeout=self.timeout)
        await self._accept_consent()
        print(f"[mt] complete the login in the browser window (waiting up to {wait_seconds}s)…")
        for _ in range(wait_seconds):
            await asyncio.sleep(1)
            if "auth.kpler.com" not in self._page.url and "marinetraffic.com" in self._page.url:
                # Give it a moment to settle, then confirm.
                await asyncio.sleep(2)
                if await self.is_logged_in():
                    print("[mt] interactive login succeeded — session persisted")
                    await self._save_cookies()
                    return True
        print("[mt] interactive login timed out")
        return False

    # ── query ────────────────────────────────────────────────────────────────

    async def query(
        self,
        shipid: Optional[int] = None,
        mmsi: Optional[int] = None,
        imo: Optional[int] = None,
        download_image: bool = True,
        fetch_all_photos: bool = False,
    ) -> VesselInfo:
        """Scrape a vessel. Resolves MMSI/IMO → shipid automatically."""
        if not self._started:
            raise RuntimeError("Call start() before query()")

        if not any([shipid, mmsi, imo]):
            raise ValueError("Provide shipid, mmsi, or imo")

        # Resolve to a shipid. Current MarineTraffic behaviour:
        #   • shipid: detail URL works directly
        #   • imo:    detail URL 302s to the canonical shipid: URL
        #   • mmsi:   detail URL is DEAD (redirects to the map) → use global search
        resolved = int(shipid) if shipid else None

        if not resolved and imo:
            await self._page.goto(SHIP_URL_IMO.format(imo=imo),
                                  wait_until="domcontentloaded", timeout=self.timeout)
            await asyncio.sleep(2)
            await self._accept_consent()
            resolved = await self._shipid_from_page()
            if resolved:
                print(f"[mt] resolved shipid={resolved} from imo: redirect")

        if not resolved:
            resolved = await self._resolve_shipid(mmsi=str(mmsi) if mmsi else None,
                                                  imo=str(imo) if imo else None)
        if not resolved:
            raise ValueError(f"Could not resolve shipid from mmsi={mmsi} imo={imo}")

        url = SHIP_URL.format(shipid=resolved)
        print(f"[mt] loading {url}")
        await self._page.goto(url, wait_until="domcontentloaded", timeout=self.timeout)
        await asyncio.sleep(3)  # allow Pro data to populate
        await self._accept_consent()

        vessel = await self._extract()
        vessel.ship_id = str(resolved)

        if fetch_all_photos:
            try:
                vessel.photos = await self.fetch_photos(resolved)
                if vessel.photos:
                    vessel.all_images_count = vessel.all_images_count or len(vessel.photos)
                    if not vessel.image_url:
                        vessel.image_url = vessel.photos[0].get("url")
            except Exception as e:
                print(f"[mt] photo gallery scrape failed: {e}")

        if download_image:
            vessel = await self._download_image(vessel)
        return vessel

    async def fetch_photos(self, shipid: int) -> List[Dict[str, str]]:
        """Scrape the vessel's photo gallery page and return all photo URLs."""
        url = PHOTOS_URL.format(shipid=shipid)
        print(f"[mt] loading photo gallery {url}")
        await self._page.goto(url, wait_until="domcontentloaded", timeout=self.timeout)
        await asyncio.sleep(2)

        # gallery lazy-loads on scroll — nudge it a few times
        for _ in range(6):
            await self._page.evaluate("window.scrollBy(0, window.innerHeight)")
            await asyncio.sleep(0.8)

        # Photos are served as /getPhoto/?photo_id=NNN&photo_size=SIZE (host
        # www.marinetraffic.com). Collect the distinct photo_ids in DOM order.
        ids: List[str] = await self._page.evaluate(
            """() => {
                const seen = [];
                const push = (src) => {
                    if (!src) return;
                    const m = src.match(/getPhoto\\/?\\?[^"']*photo_id=(\\d+)/i);
                    if (m && !seen.includes(m[1])) seen.push(m[1]);
                };
                document.querySelectorAll('img').forEach(i => push(i.currentSrc || i.src || ''));
                return seen;
            }"""
        )
        photos: List[Dict[str, str]] = []
        for pid in ids:
            photos.append({
                "thumb": f"{MT_BASE}/getPhoto/?photo_id={pid}&photo_size=200",
                "url": f"{MT_BASE}/getPhoto/?photo_id={pid}&photo_size=800",
            })
        print(f"[mt] gallery photos found: {len(photos)}")
        return photos

    async def fetch_image_bytes(self, url: str):
        """Fetch an image through the authenticated browser (hotlink + Cloudflare
        safe). Raw request-context GETs are Cloudflare-403'd, so navigate a real
        page to the image and read its response body.

        Returns (status, content_type, bytes)."""
        page = await self._context.new_page()
        try:
            resp = await page.goto(url, wait_until="commit", timeout=self.timeout)
            if not resp:
                return 502, "image/jpeg", b""
            body = await resp.body()
            ct = resp.headers.get("content-type", "image/jpeg")
            return resp.status, ct, body
        finally:
            await page.close()

    async def _shipid_from_page(self) -> Optional[int]:
        """Read the shipid from the current detail page — the URL after an imo:
        redirect, or the canonical link (`.../shipid:NNN/mmsi:.../vessel:...`)."""
        m = re.search(r"shipid:(\d+)", self._page.url or "")
        if m:
            return int(m.group(1))
        try:
            href = await self._page.evaluate(
                """() => {
                    const c = document.querySelector('link[rel=canonical]')
                          || document.querySelector('meta[property="og:url"]');
                    return c ? (c.href || c.content) : null;
                }"""
            )
        except Exception:
            href = None
        if href:
            m = re.search(r"shipid:(\d+)", href)
            if m:
                return int(m.group(1))
        return None

    async def _resolve_shipid(self, mmsi: Optional[str] = None, imo: Optional[str] = None) -> Optional[int]:
        """Resolve an MMSI or IMO to a MarineTraffic shipid.

        The site's global search only answers as an in-page XHR on the
        marinetraffic.com origin: navigating to the endpoint directly renders the
        SPA error shell, and the raw request context is Cloudflare-403'd. So we
        make sure a MT page is loaded, then fetch() from inside it."""
        term = str(mmsi or imo or "").strip()
        if not term:
            return None

        if "marinetraffic.com" not in (self._page.url or ""):
            await self._page.goto(f"{MT_BASE}/en/ais/home", wait_until="domcontentloaded", timeout=self.timeout)
            await asyncio.sleep(2)
            await self._accept_consent()

        print(f"[mt] resolving shipid via global search: {term}")
        try:
            data = await self._page.evaluate(
                """async (term) => {
                    const r = await fetch('/en/global_search/search?term=' + encodeURIComponent(term), {
                        headers: {'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json'}
                    });
                    if (!r.ok) return {error: r.status};
                    return await r.json();
                }""",
                term,
            )
        except Exception as e:
            print(f"[mt] search error: {e}")
            return None

        results = (data or {}).get("results") or []
        # Prefer an exact hit on the numeric value; fall back to the top result.
        pick = next((r for r in results if str(r.get("value")) == term and r.get("id")), None)
        if not pick:
            pick = next((r for r in results if r.get("id")), None)
        if pick:
            shipid = int(pick["id"])
            print(f"[mt] resolved shipid={shipid} ({pick.get('desc')})")
            return shipid
        print(f"[mt] resolution failed for {term} (no results)")
        return None

    # ── extraction ───────────────────────────────────────────────────────────

    async def _extract(self) -> VesselInfo:
        """Extract vessel data from the current (Kpler SPA) detail page.

        The page renders the whole dossier as visible text — tab-separated
        Label/Value rows in the General + Latest-AIS tables, voyage cards, and
        summary sentences — so we parse innerText rather than walk the volatile
        React DOM (which changes often and broke the old selector approach)."""
        vessel = VesselInfo()

        payload = await self._page.evaluate(
            """() => {
                const out = { text: document.body.innerText || '' };
                const m = out.text.match(/View all\\s*\\((\\d+)\\)/i);
                if (m) out.photoCount = parseInt(m[1]);
                const img = document.querySelector(
                    'img[src*="photos.marinetraffic.com"], [class*="gallery"] img, [class*="photo"] img');
                if (img && img.src) out.image = img.src;
                return out;
            }"""
        )
        text: str = payload.get("text", "") or ""
        vessel.all_images_count = payload.get("photoCount")
        vessel.image_url = payload.get("image")

        def norm(s: str) -> str:
            return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]", " ", s.lower())).strip()

        PLACEHOLDER = {"-", "—", "", "upgrade to unlock"}

        # 1) Tab-separated Label<TAB>Value rows (General + Latest AIS tables).
        kv: Dict[str, str] = {}
        for line in text.split("\n"):
            if "\t" in line:
                k, _, v = line.partition("\t")
                nk, v = norm(k), v.strip()
                if nk and v and v.lower() not in PLACEHOLDER:
                    kv.setdefault(nk, v)

        MAPPED: set = set()

        def get(*keys: str) -> Optional[str]:
            for k in keys:
                MAPPED.add(k)
                if k in kv:
                    return kv[k]
            return None

        vessel.name = get("name")
        vessel.flag = get("flag")
        vessel.imo = re.sub(r"\D", "", get("imo") or "") or None
        vessel.mmsi = re.sub(r"\D", "", get("mmsi") or "") or None
        vessel.callsign = get("call sign", "callsign")
        vessel.ais_class = get("ais transponder class", "ais class")
        vessel.ship_type = get("general vessel type", "detailed vessel type", "ais vessel type")
        vessel.navigational_status = get("navigational status")
        vessel.position_received = get("position received")
        vessel.vessel_local_time = get("vessel s local time")
        vessel.speed = get("speed")
        vessel.course = get("course")
        vessel.true_heading = get("true heading")
        vessel.rate_of_turn = get("rate of turn")
        vessel.draught = get("draught")
        vessel.year_built = get("year built")
        vessel.gross_tonnage = get("gross tonnage")
        vessel.deadweight = get("deadweight")
        vessel.reported_destination = get("reported destination")
        vessel.matched_destination = get("matched destination")
        vessel.destination = vessel.reported_destination or vessel.matched_destination
        vessel.reported_eta = get("reported eta")
        vessel.eta = vessel.reported_eta

        # lat/lng row: "37.719021 / 17.546038"
        ll = get("latitude longitude", "latitude", "position")
        if ll and "/" in ll:
            a, _, b = ll.partition("/")
            try:
                vessel.latitude = float(a.strip())
            except ValueError:
                pass
            try:
                vessel.longitude = float(b.strip())
            except ValueError:
                pass

        # 2) Regexes over the full text for summary + voyage cards (which render
        #    as "Label\n\nValue" rather than tab rows).
        def card(label: str) -> Optional[str]:
            m = re.search(re.escape(label) + r"\s*\n+\s*([^\n]+)", text, re.I)
            if not m:
                return None
            v = m.group(1).strip()
            return v if v.lower() not in PLACEHOLDER else None

        loa = re.search(r"length overall \(LOA\) is ([\d.]+)\s*met", text, re.I)
        if loa:
            vessel.length_overall = f"{loa.group(1)} m"
        wid = re.search(r"width is ([\d.]+)\s*met", text, re.I)
        if wid:
            vessel.width = f"{wid.group(1)} m"
        pos = re.search(r"currently located in (?:the )?([^(\n]+?)\s*\(reported", text, re.I)
        if pos:
            vessel.current_position = pos.group(1).strip()
        dep = re.search(r"Departure from ([^\n]+)", text, re.I)
        if dep:
            vessel.departure_port = dep.group(1).strip()
        arr = re.search(r"Arrival at ([^\n]+)", text, re.I)
        if arr:
            vessel.arrival_port = arr.group(1).strip()

        vessel.actual_departure_time = card("Actual time of departure:")
        vessel.distance_travelled = card("Distance travelled")
        vessel.voyage_distance = card("Total voyage distance")
        vessel.distance_to_go = card("Distance to go")
        vessel.time_to_destination = card("Time to destination")
        vessel.calculated_eta = card("Calculated ETA")
        vessel.current_wind_speed = card("Current wind speed / direction")
        vessel.current_air_temperature = card("Current air temperature")

        # Unmapped table rows kept for debugging / future fields.
        vessel.extra = {k: v for k, v in kv.items() if k not in MAPPED}
        return vessel

    # ── image download ───────────────────────────────────────────────────────

    async def _download_image(self, vessel: VesselInfo) -> VesselInfo:
        if not vessel.image_url:
            return vessel
        self.image_dir.mkdir(parents=True, exist_ok=True)
        ext = Path(vessel.image_url).suffix or ".jpg"
        if ext not in (".jpg", ".jpeg", ".png", ".webp", ".gif"):
            ext = ".jpg"
        safe = re.sub(r"[^\w\-]", "_", vessel.name or f"ship_{vessel.ship_id}")
        path = self.image_dir / f"{safe}_{vessel.ship_id}{ext}"
        try:
            resp = await self._api.get(vessel.image_url)
            if resp.status == 200:
                path.write_bytes(await resp.body())
                vessel.image_local_path = str(path.resolve())
                print(f"[mt] image saved → {path}")
            else:
                print(f"[mt] image download HTTP {resp.status}")
        except Exception as e:
            print(f"[mt] image download error: {e}")
        return vessel

    # ── sync helpers ───────────────────────────────────────────────────────────

    def query_sync(
        self,
        shipid: Optional[int] = None,
        mmsi: Optional[int] = None,
        imo: Optional[int] = None,
        download_image: bool = True,
    ) -> Dict[str, Any]:
        """Synchronous wrapper. Starts browser, queries, closes browser."""
        return asyncio.get_event_loop().run_until_complete(
            self._run_once(shipid, mmsi, imo, download_image)
        )

    async def _run_once(self, shipid, mmsi, imo, download_image):
        await self.start()
        try:
            vessel = await self.query(shipid, mmsi, imo, download_image)
            return vessel.to_dict()
        finally:
            await self.stop()


# ── one-shot helper ───────────────────────────────────────────────────────────

def scrape_vessel(
    shipid: Optional[int] = None,
    mmsi: Optional[int] = None,
    imo: Optional[int] = None,
    *,
    email: str = "",
    password: str = "",
    cookie_path: str = "./mt_cookies.json",
    image_dir: str = "./mt_images",
    headless: bool = True,
) -> Dict[str, Any]:
    """
    One-shot scrape: launches browser, logs in, scrapes vessel, closes browser.
    Returns a plain dict ready for JSON serialization.
    """
    scraper = MTScraper(
        email=email,
        password=password,
        cookie_path=cookie_path,
        image_dir=image_dir,
        headless=headless,
    )
    return scraper.query_sync(shipid=shipid, mmsi=mmsi, imo=imo, download_image=True)


# ── CLI ───────────────────────────────────────────────────────────────────────

def _cli() -> int:
    parser = argparse.ArgumentParser(description="MarineTraffic vessel scraper")
    parser.add_argument("--shipid", type=int, help="MarineTraffic ship ID")
    parser.add_argument("--mmsi", type=int, help="MMSI")
    parser.add_argument("--imo", type=int, help="IMO")
    parser.add_argument("--email", default="sebpoljanich@gmail.com")
    parser.add_argument("--password", default="Y91rMwPXj!KnKhExEq3&")
    parser.add_argument("--cookie-path", default="./mt_cookies.json")
    parser.add_argument("--image-dir", default="./mt_images")
    parser.add_argument("--no-image", action="store_true", help="Skip image download")
    parser.add_argument("--headless", action="store_true", default=True)
    parser.add_argument("--no-headless", dest="headless", action="store_false")
    parser.add_argument("--login", action="store_true",
                        help="One-time interactive login (opens a visible browser; use to satisfy MFA)")
    parser.add_argument("-o", "--output", help="Write JSON to file")
    args = parser.parse_args()

    # One-time interactive login to seed the persistent Chrome profile.
    if args.login:
        scraper = MTScraper(
            email=args.email,
            password=args.password,
            cookie_path=args.cookie_path,
            image_dir=args.image_dir,
            headless=False,  # must be visible so a human can complete MFA
        )

        async def _do_login():
            await scraper.start()
            try:
                return await scraper.login_interactive(wait_seconds=900)
            finally:
                await scraper.stop()

        ok = asyncio.run(_do_login())
        print("login:", "OK" if ok else "FAILED")
        return 0 if ok else 1

    if not any([args.shipid, args.mmsi, args.imo]):
        parser.print_help()
        print("\nError: provide --shipid, --mmsi, or --imo")
        return 1

    result = scrape_vessel(
        shipid=args.shipid,
        mmsi=args.mmsi,
        imo=args.imo,
        email=args.email,
        password=args.password,
        cookie_path=args.cookie_path,
        image_dir=args.image_dir,
        headless=args.headless,
    )

    out = json.dumps(result, indent=2, ensure_ascii=False, default=str)
    print(out)
    if args.output:
        Path(args.output).write_text(out, encoding="utf-8")
        print(f"\nWrote {args.output}")
    return 0


if __name__ == "__main__":
    sys.exit(_cli())
