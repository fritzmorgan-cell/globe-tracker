# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the project

**Backend** (from `backend/`):
```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env   # fill in API keys
python main.py         # runs on :8000 with --reload
```

**Frontend** (from `frontend/`):
```bash
python3 -m http.server 3000   # open http://localhost:3000
```

**Verify backend is up:**
```bash
curl http://localhost:8000/health
curl "http://localhost:8000/api/planes?lamin=40&lomin=-80&lamax=50&lomax=-70"
```

Interactive API docs: `http://localhost:8000/docs`

## Git workflow

Every meaningful change must be committed and pushed to GitHub (`origin/main`). Use clean, imperative commit messages. Stage specific files rather than `git add -A`.

```bash
git add backend/routers/foo.py frontend/js/app.js
git commit -m "Add X so that Y"
git push
```

## Architecture

### Backend data flow

There are two fundamentally different data patterns:

1. **Request-scoped (planes):** Each `GET /api/planes` request fetches fresh data from OpenSky, normalises it, writes it to SQLite via fire-and-forget `asyncio.create_task`, and returns. Results are cached by bbox key for 10 s (`cache.py`).

2. **Streaming (ships):** A single persistent WebSocket (`services/aisstream_client.py`) runs for the lifetime of the server, continuously populating an in-memory `_vessels` dict with global AIS coverage. `GET /api/ships` does no network I/O — it just filters that dict by bbox. `snapshot_loop()` writes the vessel store to SQLite every 60 s.

3. **Batch/cached (satellites):** `GET /api/satellites/tle` fetches all ~1 500 TLEs from SatNOGS once, caches for 1 hour, and filters by group name on every request.

Both background tasks (WebSocket + snapshot loop) are started in `main.py`'s `lifespan` hook and cancelled on shutdown.

### History / replay

`db.py` holds a single persistent `aiosqlite` connection (WAL mode). Two tables: `planes` and `ships`, both indexed on `ts`. Plane records are sparse (only areas the user viewed); ship records are global.

`GET /api/history/planes?ts=&lamin=&lomin=&lamax=&lomax=` looks back 5 minutes from `ts` and returns the most-recent row per entity — this compensates for the polling gap.

### Frontend architecture

All globe rendering uses **CesiumJS 1.124**. Three layers are managed by `EntityLayer` (`js/entityLayer.js`), a generic diff-update class keyed by an id field. It updates positions in-place (no flicker), adds new entities, and removes disappeared ones. The same class works identically for live and replayed data.

**`js/app.js`** is the orchestrator:
- `pollAll()` fetches planes + ships in parallel via `Promise.allSettled`, updates layers, writes to SQLite side-effect-free
- `updateSatellitePositions()` propagates satellite positions from TLE satrecs via **satellite.js** (SGP4) — in live mode uses `new Date()`, in replay mode uses `replayTs`
- `fetchReplay(ts)` queries the history endpoints and calls `updateSatellitePositions()` so all three layers stay in sync during scrubbing
- The timeline slider updates satellite positions immediately on every `input` event (pure math), then debounces the DB fetch 150 ms

### Click → info panel flow

1. Cesium `LEFT_CLICK` handler picks the entity and reads `properties` (the original data record stored on the entity)
2. Dispatches to `openPlaneModal()`, `openShipModal()`, or inline satellite handler
3. `_selectEntity(id)` moves a `CallbackProperty`-based selection ring to follow the entity continuously
4. For planes: `fetchFlightInfo(callsign, icao24)` runs two parallel requests — `adsbdb.com/v0/callsign/{cs}` (route) and `adsbdb.com/v0/aircraft/{icao24}` (make/model/reg) — then updates the modal and swaps the globe icon to a type-specific SVG from `AIRCRAFT_TYPE_ICONS` using `_ICAO_CAT` lookup
5. For satellites: the orbital track is computed entirely client-side with a 3-hour lookback at 2-minute steps, split at the antimeridian to avoid lines through the Earth

### Key constants / configuration points

| Location | Constant | Purpose |
|---|---|---|
| `app.js` | `POLL_INTERVAL_MS = 8000` | Live polling cadence |
| `app.js` | `MAX_FETCH_ALTITUDE_M = 4_000_000` | Skip fetch when too high |
| `app.js` | `_ICAO_CAT` | ICAO type code → icon category map |
| `cache.py` | `CACHE_TTL_SECONDS = 10` | Plane/ship response cache |
| `satellites.py` | `CACHE_TTL = 3600` | TLE cache duration |
| `aisstream_client.py` | `VESSEL_TTL_SECONDS = 300` | Stale vessel eviction |
| `db.py` | `DB_PATH` | SQLite file location (relative to `backend/`) |

### External services

| Service | Used for | Auth |
|---|---|---|
| OpenSky Network | Live aircraft positions | OAuth2 client credentials (`OPENSKY_CLIENT_ID` / `SECRET`) |
| aisstream.io | Live AIS ship positions (WebSocket) | `AISSTREAM_API_KEY` |
| SatNOGS DB | TLE orbital data for satellites | None |
| adsbdb.com | Flight route + aircraft type/registration | None |
| Planespotters.net | Aircraft photos | None |
| MarineTraffic | Ship photo URLs (constructed, not API) | None |
| CesiumJS Ion | Globe terrain + imagery | Token in `index.html` |

### Adding a new data layer

1. Add a `GET /api/<layer>` router in `backend/routers/` and register it in `main.py`
2. Add a `fetch<Layer>(bbox)` function in `frontend/js/api.js`
3. Instantiate a new `EntityLayer` in `app.js` with appropriate `idField`, `labelField`, icon, and colour
4. Call `fetch<Layer>` inside `pollAll()` via `Promise.allSettled`
