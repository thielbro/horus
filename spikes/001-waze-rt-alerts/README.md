# Spike 001 — Waze mobile RT protocol for live POLICE alerts

**Question:** Can HORUS get real-time user reports (POLICE etc.) that the Waze web
GeoRSS feed no longer serves (`hideUserReportsAndWazers=true`), by speaking the
Waze *mobile* "RT" protocol directly — no browser, no reCAPTCHA?

**Verdict: YES — proven live on 2026-11-05.**

| Run | Region | Host | Time | Result |
|---|---|---|---|---|
| Auckland CBD 10 km | row | rt-xlb-row.waze.com | 15.7 s | 30 alerts: **4 POLICE**, 23 ROAD_CLOSED, 2 HAZARD, 1 JAM |
| Downtown LA 12 km | na | rt-xlb-am.waze.com | 15.5 s | 50 alerts: **2 POLICE** (incl. `POLICE_HIDING`, 3 min old), 27 HAZARD, 10 ROAD_CLOSED, 6 JAM, 5 ACCIDENT |
| Sydney CBD 12 km | row | rt-xlb-row.waze.com | 15.8 s | 45 alerts: **7 POLICE**, 20 JAM, 15 HAZARD |

Police reports carry uuid, street + city, age (report_time epoch-seconds ×1000),
thumbs-up count, bearing, exact micro-degree coords — richer than the web feed ever gave.
Plain Node 25 `fetch` + `protobufjs`, zero browser, zero reCAPTCHA — the RT hosts are
behind **no WAF** (unlike `/live-map/api/georss`).

## Protocol shape (reimplemented from `nicglazkov/highway-radar-sabre-plus`, MIT — `waze.proto` vendored)

- Hosts `rt-xlb-{am|il|row}.waze.com`, region-routed; POST `binary/octet-stream` bodies.
- Two body kinds: raw command lines (`SeeMe`, `SetMood`, `Location`, `MapDisplayed,...`)
  and `"ProtoBase64," + b64(Batch{element[...]})` protobuf lines, newline-joined.
- Flow per session: `POST /rtserver/distrib/static` (ClientInfo + empty `Register` →
  anonymous username/password/token; ~10-creations/day cap) →
  `POST /rtserver/distrib/login` (LoginRequest + ReportAdsSettings; sets
  `Waze-Session-Affinity` cookie; `LoginSuccessful{server_session_id, secret_key}`) →
  `POST /rtserver/distrib/command` (handshake commands, then one `MapDisplayed` per box;
  `uid` header = b64(UID{server_session_id, secret_key}), `sequence-number`,
  `x-waze-wait-timeout: 8500/10500`).
- Alerts arrive in-band as `Element.AddAlertAction.RealtimeAlert`; removals as
  `old_command "RmAlert,<uuid>"`. Big viewports get thinned — the shrinking-box series
  (×0.5 per step) recovers near-driver detail; server never re-sends alerts this session.
- A fresh account's first `/command` draws an in-band `ServerError{504, Retry}` — absorb
  with one retry (confirmed in all 3 runs).

## Gotchas found while building

- **protobufjs silently drops snake_case keys** — `fromObject`/message properties are
  camelCase (`clientInfo`, `lonTimes1000000`). Sending snake keys produced empty
  messages and the server answered `500 Bad proto element`. Decode side is camel too.
- Longitude arrives as two's-complement unsigned micro-degrees; re-sign before /1e6
  (upstream fix, ported).
- Register/login/command headers differ slightly (UA `5.17.1.0` vs `waze/5.17.1.0`);
  sequence resets to 2 after login — replicated exactly.

## Integration path (next, not in spike)

Drop-in `RtTransport` beside the existing Playwright/Electron transports in
`src/lib/traffic-alerts/waze.ts`: Node-only (fits the Electron main process AND the
Next API route — no browser needed), ~15 s end-to-end per tile sweep, vendor
`waze.proto` + `protobufjs`, cache creds to survive restarts (register cap).
Keep GeoRSS transport as fallback for provider ROAD_CLOSED feeds (the RT feed carries
user reports, not the TMC/council closure providers).
