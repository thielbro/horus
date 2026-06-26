<div align="center">

# 𓂀 HORUS

### Counter-Surveillance & On-the-Go OSINT Intelligence Map

[![Next.js](https://img.shields.io/badge/Next.js-16-black?style=for-the-badge&logo=next.js)](https://nextjs.org)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?style=for-the-badge&logo=electron&logoColor=white)](https://www.electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=for-the-badge&logo=typescript&logoColor=white)](https://typescriptlang.org)
[![MapLibre](https://img.shields.io/badge/MapLibre_GL-GPU_Rendered-396CB2?style=for-the-badge)](https://maplibre.org)
[![License](https://img.shields.io/badge/License-MIT-D4AF37?style=for-the-badge)](LICENSE)

**A native-desktop intelligence map focused on counter-surveillance and situational awareness — it maps what can watch *you* (CCTV, ALPR/Flock readers, mass-surveillance tech, police), compiles on-demand intel dossiers for an address or a driving route, and tracks your live exposure as you move.**

[Report an issue](https://github.com/rocco-crypto/horus/issues)

</div>

> **Lineage:** HORUS began as a fork of [**OSIRIS**](https://github.com/simplifaisoul/osiris) (a global OSINT dashboard) and grew its own identity. The Eye of Horus motif fits the shift: where OSIRIS watches the world, HORUS watches *the watchers*. The broad OSINT layers are inherited; the counter-surveillance + on-the-go intel framework is the new core.

---

## What makes HORUS different

Three things set HORUS apart from its upstream:

1. **Counter-surveillance layers** — a dedicated `SURVEIL` group that maps the observation infrastructure around a location: CCTV networks, ALPR/Flock readers, mass-surveillance hardware, and police stations.
2. **On-the-go intel framework** — at request time, a configurable **local LLM + web search** *compile* a dossier for an entity. **No static intel database** — everything is gathered and synthesised on demand, then cached with a TTL.
   - **Address intel** — geocode → nearby surveillance/ALPR/police within a radius → occupant/business lookup → street-level photos → an LLM exposure briefing.
   - **Route exposure** — start/end → driving polyline → a 150 m corridor → every camera, ALPR reader and police station that can observe the drive, ordered start→end.
   - **Live location tracking** — opt-in GPS with "intel on my location" and follow-me.
3. **Curated location databases** — owned, authoritative datasets that override community OSM where we have them. First up: **New Zealand police stations** (306 stations), with live OpenStreetMap filling the gaps everywhere else.

---

## Intelligence layers

Layers load on demand (only when toggled) and render via WebGL.

| Group | Layers |
|-------|--------|
| **Counter-surveillance** | CCTV Cameras · Police Stations · Flock / ALPR · Mass Surveillance · Surveillance (OSM) · Dossier Overlay · Route Exposure · My Location · Live News · SIGINT News |
| **Aviation** | Commercial · Private · Private Jets · Military *(OpenSky)* |
| **Maritime** | Maritime / Naval · Satellites |
| **Hazard** | Earthquakes (24h) · Active Fires · Severe Weather *(USGS · NASA FIRMS · NASA EONET)* |
| **Threat** | Nuclear Facilities · Conflict Zones · Global Incidents · GPS Jamming |
| **Network** | Live Malware · IP Sweep · Scan Targets |

### RECON toolkit
Port scanner · DNS lookup · WHOIS · SSL/TLS inspector · IP intelligence · CVE/vulnerability lookup · BTC + ETH wallet tracing · OFAC SDN sanctions search. WHOIS/IP results are auto-cross-checked against the OFAC SDN list.

---

## On-the-go intel framework

The intel side is a reusable provider pipeline (`src/lib/intel`). Each provider splits **`gather`** (deterministic, parallel, cited — no LLM) from **`synthesize`** (one LLM call), and streams its dossier over SSE.

```
ref (address | route | …)
  → gather:   geocode / route → Overpass surveillance → web search → photos   (cited, parallel)
  → synthesize: one LLM call frames the exposure
  → Dossier:  signals · entity graph · facts · geometry · privacy notice      (streamed, cached)
```

These three external services are **user-run and URL-configured — never bundled**, and HORUS degrades gracefully when any is absent:

| Service | Purpose | Default |
|---------|---------|---------|
| **LLM** (OpenAI-compatible, e.g. Ollama) | dossier synthesis | `http://127.0.0.1:11434/v1` |
| **Firecrawl** | web search / scrape | `http://127.0.0.1:3002` |
| **OSRM** | route geometry | public OSRM demo (self-host for prod) |
| **Mapillary** (token) | street-level photos | _optional_ |

Without an LLM the dossier still renders a deterministic exposure summary; without Firecrawl/Mapillary it simply omits web results / photos.

---

## Quick start

> ⚠️ This repo runs **Next.js 16** (breaking changes vs. earlier majors). Read [`AGENTS.md`](AGENTS.md) before touching Next config or conventions.

```bash
git clone https://github.com/rocco-crypto/horus.git
cd horus
npm install

npm run dev        # guarded dev server (watchdog) → http://localhost:3000
npm run desktop:dev   # Electron shell against the dev server
```

`npm run dev` runs a **watchdog** wrapper (`scripts/dev-watchdog.ps1`) — prefer it over raw `next dev`. Build the desktop app with `npm run desktop:build:win` (or `:linux`).

### Docker / self-hosting
See **[DOCKER.md](DOCKER.md)** for the Compose, CasaOS and API-key guide.

### Configuration
HORUS works **without any API keys** — core feeds use public, keyless sources. Copy [`.env.template`](.env.template) to `.env` and set only what you need:

```env
HORUS_PORT=3000               # published host port (container always listens on 3000)

# Intel framework (all optional; user-run services)
LLM_URL=http://127.0.0.1:11434/v1
LLM_MODEL=llama3.1
FIRECRAWL_URL=http://127.0.0.1:3002
ROUTING_URL=https://router.project-osrm.org
MAPILLARY_TOKEN=

# RECON scanner backend (SCANNER_KEY must match the backend's HORUS_KEY)
SCANNER_URL=
SCANNER_KEY=

# Optional, for higher rate limits / extra sources
FIRMS_API_KEY=                # NASA FIRMS
OPENSKY_CLIENT_ID=            # OpenSky OAuth2
OPENSKY_CLIENT_SECRET=
N2YO_API_KEY=                 # N2YO satellites
```

`.env` is gitignored — only the template is committed.

---

## Curated databases

Curated, owned location datasets live in `src/lib/police/` and override live OpenStreetMap inside their coverage (OSM fills the gaps elsewhere). They power the `Police Stations` map layer **and** the address/route intel providers, so counts stay consistent everywhere.

**Adding a country:** drop a CSV in `src/lib/police/data/`, run a generator (see `scripts/generate_nz_police.js`), and register the dataset in `src/lib/police/curated.ts`. Currently populated: **New Zealand** (306 stations).

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack) |
| Desktop shell | Electron (Windows-first; one codebase with the web app) |
| Language | TypeScript 5 |
| Map engine | MapLibre GL JS (WebGL) |
| Animations | Framer Motion |
| Icons | Lucide React |
| Intel | OpenAI-compatible LLM (Ollama default) · Firecrawl · OSRM · Mapillary · Overpass / Nominatim |

The codebase is **declaratively driven** by a source/layer registry (`src/lib/registry/`) with no-code custom sources, trusted in-process JS plugins (`@horus/plugin-sdk`), custom themes, and saveable workspaces.

---

## Keyboard shortcuts

| Key | Action |
|-----|--------|
| `F` | Toggle flight layers |
| `E` | Toggle earthquakes |
| `S` | Toggle satellites |
| `D` | Toggle day/night cycle |
| `Escape` | Close panels |

---

## Credits & license

HORUS is built on **[OSIRIS](https://github.com/simplifaisoul/osiris)** by [simplifaisoul](https://github.com/simplifaisoul) — much of the global-OSINT layer set and the map foundation originate there. The counter-surveillance layers, the on-the-go intel framework, the desktop shell, and the curated databases are HORUS's own direction.

Licensed under **MIT** — see [LICENSE](LICENSE).
