# MarineTraffic Vessel Scraper

A standalone, embeddable scraper for **MarineTraffic Pro** accounts. Click a vessel in your app and instantly get structured data: speed, course, destination, origin, vessel type, image, and more.

## Files

| File | Purpose |
|------|---------|
| `mt_scraper.py` | Core scraper (Playwright, login, cookie persistence, extraction) |
| `mt_api.py` | **Embeddable API** — drop this into your app |
| `mt_server.py` | **Localhost HTTP sidecar** — what HORUS spawns and proxies to |
| `requirements_scraper.txt` | `playwright>=1.40.0` |

## HORUS integration (how it's wired in)

Clicking a vessel on the HORUS map now enriches the Entity Intel panel with
MarineTraffic Pro data and the full photo gallery. The flow:

```
VesselIntelCard  ──▶  /api/marinetraffic       ──▶  mt_server.py (sidecar)  ──▶  MarineTraffic
  (React)              /api/marinetraffic/photo       persistent Chrome + login
```

- `src/lib/mt-sidecar.ts` lazily spawns `mt_server.py` on first vessel click and
  keeps a logged-in Playwright session alive so repeat clicks are fast.
- `src/app/api/marinetraffic/route.ts` returns the Pro dossier (particulars,
  voyage, weather-at-position, and every gallery photo), cached 10 min.
- `src/app/api/marinetraffic/photo/route.ts` relays hotlink-protected MT photos
  through the authenticated session.
- The card shows a MarineTraffic photo carousel + a "MARINETRAFFIC PRO" grid
  when available, and silently falls back to the AIS fields + a Wikimedia photo
  when the sidecar is unavailable.

### Prerequisites

MarineTraffic is behind **Cloudflare** and delegates login to **Kpler
(Auth0)**. Two consequences drove the implementation:

1. **Real Chrome required.** Bundled Chromium is Cloudflare-blocked in headless
   mode; the scraper launches your installed Chrome (`channel="chrome"`) with a
   persistent profile (`.mt_profile/`), which passes the bot check.
2. **One-time interactive login (MFA).** Kpler's identifier-first flow can
   require multi-factor auth. The scraper fills email + password automatically,
   but if MFA is demanded you must complete it **once** in a visible browser:

   ```bash
   python mt_scraper.py --login    # opens a window; sign in + complete MFA
   ```

   The persistent Chrome profile keeps the session afterwards, so all later
   headless sidecar runs reuse it. Re-run `--login` only if the session expires.

### Environment (all optional — see `.env.template`)

```
MT_SCRAPER_URL=        # use an externally managed sidecar instead of auto-spawn
MT_SCRAPER_PORT=8477   # port for the auto-spawned sidecar
MT_PYTHON=python       # python executable used to spawn it
MT_SCRAPER_DISABLED=1  # turn the feature off entirely
MT_EMAIL= / MT_PASSWORD=   # override MarineTraffic credentials
```

## Quick Start

### 1. Install Playwright

```bash
pip install playwright>=1.40.0
python -m playwright install chromium
```

### 2. Use the embeddable API in your app

```python
from mt_api import MarineTrafficAPI

# Initialize once (e.g., on app startup)
mt = MarineTrafficAPI()
mt.start()   # logs in, persists cookies

# When a user clicks a vessel:
data = mt.get_vessel(shipid=12345)      # by MarineTraffic ship ID
data = mt.get_vessel(mmsi=248663000)    # by MMSI (auto-resolved)
data = mt.get_vessel(imo=1011094)       # by IMO (auto-resolved)

print(data["name"])          # "ZEFIRA"
print(data["speed"])         # "10.3 knots"
print(data["course"])        # "117°"
print(data["destination"])   # "ZAKINTHOS"
print(data["image_url"])     # "https://..."
print(data["image_local_path"])  # "C:\...\vessel_images\ZEFIRA_12345.jpg"

# On app shutdown:
mt.stop()
```

### 3. One-shot CLI usage

```bash
# by shipid
python mt_api.py --shipid 12345

# by MMSI
python mt_api.py --mmsi 248663000

# by IMO
python mt_api.py --imo 1011094

# skip image download
python mt_api.py --shipid 12345 --no-image
```

## Data Fields Returned

The scraper returns a plain `dict` with these fields:

| Field | Example |
|-------|---------|
| `name` | `"ZEFIRA"` |
| `ship_type` | `"Sailing Vessel"` |
| `imo` | `"1011094"` |
| `mmsi` | `"248663000"` |
| `callsign` | `"9HA4359"` |
| `flag` | `"MALTA"` |
| `length_overall` | `"49.69 m"` |
| `width` | `"10 m"` |
| `draught` | `"4.9 m"` |
| `current_position` | `"Tyrrhenian Sea"` |
| `latitude` / `longitude` | `40.815094`, `10.43873` |
| `navigational_status` | `"Underway"` |
| `ais_class` | `"Class B"` |
| `speed` | `"10.3 knots"` |
| `course` | `"117°"` |
| `true_heading` | `"123°"` |
| `rate_of_turn` | `"24°/min"` |
| `destination` | `"ZAKINTHOS"` |
| `reported_destination` | `"ZAKINTHOS"` |
| `matched_destination` | `"Zakynthos, GREECE"` |
| `departure_port` | `"Genova"` |
| `arrival_port` | `"Zakynthos, GREECE"` |
| `eta` | `"2026-09-19 17:00 (UTC+3)"` |
| `reported_eta` | `"2026-09-19 17:00 (UTC+3)"` |
| `calculated_eta` | — |
| `distance_travelled` | `"413 NM"` |
| `distance_to_go` | — |
| `actual_departure_time` | `"2026-06-21 16:27 (UTC+2)"` |
| `current_wind_speed` | `"9 kn"` |
| `current_wind_direction` | `"E (88°)"` |
| `current_air_temperature` | `"24°C"` |
| `image_url` | `"https://photos.marinetraffic.com/..."` |
| `image_local_path` | `"C:\...\vessel_images\ZEFIRA_12345.jpg"` |
| `all_images_count` | `21` |
| `extra` | `{...}` — any additional fields found on the page |

## How It Works

1. **Login** — Playwright navigates to MarineTraffic, fills in your Pro credentials, and logs in.
2. **Cookie persistence** — Session cookies are saved to `mt_cookies.json` so subsequent runs skip login.
3. **Resolution** — If you pass an MMSI or IMO, the scraper searches MarineTraffic and resolves it to the internal `shipid`.
4. **Extraction** — The scraper loads the vessel detail page (`/en/ais/details/ships/shipid:{id}`) and runs a comprehensive JavaScript extraction to pull every label-value pair from tables, definition lists, and grid layouts.
5. **Image download** — The main vessel photo is downloaded to `./vessel_images/` and its local path is returned.

## Pro Account Benefits

Because the scraper logs in with your Pro account, you get:
- Full vessel characteristics (dimensions, build year, tonnage)
- Route forecast and arrival details
- Historical track data references
- All photos (not just the thumbnail)
- Higher rate limits

## Notes

- **Headless mode** runs without a visible browser window. Use `headless=False` if you want to watch it work.
- **Cookie file** is plain JSON. Keep it secure — it contains your session tokens.
- **Rate limits** — MarineTraffic may throttle heavy scrapers. The scraper adds small delays between actions. If you need to query many vessels rapidly, consider adding longer delays or caching.
- **DOM changes** — If MarineTraffic changes their page layout, the scraper may need updates. The JS extraction is designed to be resilient, but major redesigns could require tweaks.
