---
name: hermes-surveillance-feed-import
description: Use when Hermes needs to prepare, validate, or submit static surveillance-feed records for HORUS layers: surveillance cameras, Flock/ALPR cameras, police stations, or mass-surveillance technology.
---

# Hermes Surveillance Feed Import Skill

## Purpose

Use this skill to add static, source-backed records to the HORUS `surveillance-feed` sidecar.

This skill is only for the four fixed counter-surveillance layers:

- `surveillance`
- `flock`
- `police`
- `mass_surveil`

Do not use this skill for Waze alerts, live police movement, route intelligence, address dossiers, CCTV streams, news, or general OSINT panels.

## Operating Rules

1. Never invent a location.
2. Never import a record without latitude and longitude.
3. Never import live officer, patrol, checkpoint, or tactical movement observations.
4. Never import private personal information.
5. Prefer public/static infrastructure records: cameras, ALPR sites, police stations, public-area surveillance systems.
6. Preserve provenance in `source`, `external_url`, `osm_url`, `tags`, or `properties`.
7. Use stable `source_id` values so repeat imports update records instead of duplicating them.
8. If confidence is not high, put the confidence and reason in `properties`.
9. Prepare JSON first. Only submit the POST when the operator explicitly asks to import or confirms the prepared batch.

## Configuration

Hermes needs:

```text
SURVEILLANCE_FEED_URL=http://127.0.0.1:7800
SURVEILLANCE_FEED_ADMIN_TOKEN=<admin bearer token>
```

Public reads do not need a token. Imports and admin jobs require:

```text
Authorization: Bearer <admin bearer token>
```

## API Endpoints

Health check:

```http
GET /health
```

Read map records:

```http
GET /v1/layers?bbox=south,west,north,east&layers=surveillance,flock,police,mass_surveil
```

Import records:

```http
POST /v1/admin/import
Authorization: Bearer <token>
Content-Type: application/json
```

Queue a refresh:

```http
POST /v1/admin/refresh
Authorization: Bearer <token>
Content-Type: application/json
```

Read jobs:

```http
GET /v1/admin/jobs
Authorization: Bearer <token>
```

## Layer Selection

Choose exactly one `layer` per record.

| Layer | Use For | Do Not Use For |
|---|---|---|
| `surveillance` | Fixed surveillance cameras, speed cameras, CCTV-like public cameras, OSM `man_made=surveillance`, OSM `highway=speed_camera` | Live video streams, camera guesses, private doorbell cameras |
| `flock` | ALPR/LPR/ANPR cameras, Flock-style license plate readers, camera records with clear ALPR evidence | Generic cameras with no ALPR evidence |
| `police` | Police stations, police posts, official station buildings, curated public station data | Patrol cars, officer sightings, checkpoints, live movements |
| `mass_surveil` | Public-area/town/area surveillance systems, broad fixed surveillance infrastructure, area-monitoring technology | Single generic camera unless source describes broad public-area surveillance |

## Required Import Body

Every import request must be a JSON object:

```json
{
  "source": {
    "id": "hermes-agent",
    "label": "Hermes Agent Import",
    "kind": "agent",
    "attribution": "operator supplied",
    "metadata": {
      "importer": "hermes"
    }
  },
  "records": []
}
```

`records` must be a non-empty array before submitting.

## Record Schema

Minimum valid record:

```json
{
  "layer": "surveillance",
  "source_id": "stable-record-id",
  "name": "Camera or site name",
  "lat": 0,
  "lng": 0
}
```

Recommended full record:

```json
{
  "layer": "flock",
  "source_id": "source-domain:country:city:camera-slug",
  "name": "Reported ALPR Camera",
  "lat": -36.8485,
  "lng": 174.7633,
  "country": "New Zealand",
  "operator": "Flock Safety",
  "external_url": "https://example.org/source-page",
  "tags": {
    "surveillance:type": "ALPR",
    "operator": "Flock Safety"
  },
  "properties": {
    "confidence": "high",
    "evidence": "source explicitly identifies ALPR camera",
    "imported_by": "hermes"
  }
}
```

Accepted record fields:

| Field | Required | Notes |
|---|---:|---|
| `layer` | yes | Must be one of `surveillance`, `flock`, `police`, `mass_surveil` |
| `source_id` | strongly recommended | Stable ID from source. Same `source_id` updates existing record |
| `name` | recommended | Human readable marker label |
| `lat` | yes | Number from `-90` to `90` |
| `lng` | yes | Number from `-180` to `180` |
| `country` | no | Use country name when known |
| `operator` | no | Organization operating the device/site, if known |
| `external_url` | no | Public source URL |
| `osm_url` | no | OpenStreetMap element URL |
| `tags` | no | OSM-style or source-style tags |
| `properties` | no | Confidence, evidence notes, import metadata |

## Stable ID Rules

Stable IDs prevent duplicates.

Use the most stable available source identifier:

1. OSM element: `osm:node/123456`
2. Official database ID: `nz-police:station-name-or-code`
3. Public source URL slug: `deflock:us:city:camera-id`
4. Manual deterministic ID: `hermes:<country>:<city>:<layer>:<short-slug>`

Do not use random UUIDs unless the operator explicitly asks for a one-off record.

If no official ID exists, create a deterministic slug from:

```text
source host + layer + rounded lat/lng + normalized name
```

Example:

```text
hermes:nz:auckland:flock:queen-st-alpr-1747633--368485
```

## Validation Checklist Before Import

Before POSTing, verify every record:

- `layer` is exactly one allowed value.
- `lat` and `lng` are numeric, not strings.
- Coordinates are within valid ranges.
- `source_id` is stable and not random.
- `name` is clear enough for a map marker.
- `external_url`, `osm_url`, `tags`, or `properties.evidence` explains where the claim came from.
- `flock` records have explicit ALPR/LPR/ANPR/Flock evidence.
- `police` records describe static police facilities, not vehicles or people.
- `mass_surveil` records describe public-area or broad surveillance technology.
- Ambiguous records use `properties.confidence = "low"` or are held for operator review.

If any record fails validation, do not import it. Return a clear rejection reason.

## Import Procedure

1. Build the JSON import body.
2. Validate every record against the checklist.
3. Show the operator a short summary:
   - number of records
   - layers affected
   - source id and label
   - any low-confidence records
4. If the operator has not explicitly approved import, stop and output the prepared JSON.
5. If approved, send `POST /v1/admin/import`.
6. Check the response:
   - `imported` should equal number of submitted records.
   - `upserted` may be lower if duplicate `source_id` values updated the same record.
7. Run a public read for the relevant bbox to confirm markers are visible.

## Curl Import Example

```bash
curl -sS -X POST "$SURVEILLANCE_FEED_URL/v1/admin/import" \
  -H "Authorization: Bearer $SURVEILLANCE_FEED_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "source": {
      "id": "hermes-agent",
      "label": "Hermes Agent Import",
      "kind": "agent",
      "attribution": "operator supplied",
      "metadata": {
        "importer": "hermes"
      }
    },
    "records": [
      {
        "layer": "flock",
        "source_id": "hermes:nz:auckland:flock:queen-st-alpr",
        "name": "Queen Street ALPR Camera",
        "lat": -36.8485,
        "lng": 174.7633,
        "country": "New Zealand",
        "operator": "Unknown",
        "external_url": "https://example.org/source",
        "tags": {
          "surveillance:type": "ALPR"
        },
        "properties": {
          "confidence": "medium",
          "evidence": "source describes license plate recognition camera",
          "imported_by": "hermes"
        }
      }
    ]
  }'
```

## Public Read Confirmation Example

After import, query a bbox around the record:

```bash
curl -sS "$SURVEILLANCE_FEED_URL/v1/layers?bbox=-36.95,174.65,-36.75,174.95&layers=flock"
```

The response should include the imported record in the matching layer array.

## Refresh Job Example

Only queue refreshes for fixed OSM-derived data when the operator asks.

```bash
curl -sS -X POST "$SURVEILLANCE_FEED_URL/v1/admin/refresh" \
  -H "Authorization: Bearer $SURVEILLANCE_FEED_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "bbox": "-36.95,174.65,-36.75,174.95",
    "layers": ["surveillance", "flock", "police", "mass_surveil"]
  }'
```

## Hermes Response Format

When preparing an import but not yet approved:

```text
Prepared surveillance-feed import:
- Source: <source id> / <source label>
- Records: <count>
- Layers: <layer counts>
- Low confidence: <count or none>

Awaiting operator approval before POST /v1/admin/import.
```

Then output the JSON body.

When import succeeds:

```text
Import complete:
- Imported: <imported>
- Upserted: <upserted>
- Source: <source id>
- Confirmation bbox checked: <yes/no>
```

When import fails:

```text
Import failed:
- HTTP status: <status>
- Error: <server error>
- Action needed: <specific fix>
```

## Common Mistakes

Do not send this:

```json
{
  "records": [
    {
      "layer": "flock",
      "name": "Possible camera",
      "lat": "-36.8",
      "lng": "174.7"
    }
  ]
}
```

Problems:

- Missing `source`.
- Missing stable `source_id`.
- Coordinates are strings.
- No ALPR evidence for `flock`.
- No provenance.

Send this instead:

```json
{
  "source": {
    "id": "hermes-agent",
    "label": "Hermes Agent Import",
    "kind": "agent",
    "attribution": "operator supplied",
    "metadata": {
      "importer": "hermes"
    }
  },
  "records": [
    {
      "layer": "surveillance",
      "source_id": "hermes:nz:auckland:surveillance:camera-1747--368",
      "name": "Possible Public Surveillance Camera",
      "lat": -36.8,
      "lng": 174.7,
      "country": "New Zealand",
      "properties": {
        "confidence": "low",
        "evidence": "operator supplied; ALPR not confirmed",
        "imported_by": "hermes"
      }
    }
  ]
}
```

