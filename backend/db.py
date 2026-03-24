"""
SQLite history store.

Planes are recorded every time a live OpenSky fetch returns results.
Ships are snapshotted from the in-memory vessel store every 60 seconds.

Schema:
    planes(ts, icao24, callsign, lat, lon, altitude, velocity, heading)
    ships (ts, mmsi,   name,     lat, lon, course,   speed,   type)

Both tables are indexed on ts for fast time-range queries.

NOTE: Because planes are only fetched for the bbox the user is currently
viewing, the historical plane data only covers areas that were viewed while
the server was running. Ship coverage is global (aisstream world subscription).
"""

import asyncio
import time
import os
import aiosqlite

DB_PATH = os.path.join(os.path.dirname(__file__), "history.db")

_db: aiosqlite.Connection | None = None
_write_lock = asyncio.Lock()   # serialise concurrent writes


async def init() -> None:
    global _db
    _db = await aiosqlite.connect(DB_PATH)
    _db.row_factory = aiosqlite.Row
    await _db.execute("PRAGMA journal_mode=WAL")
    await _db.execute("PRAGMA synchronous=NORMAL")
    await _db.execute("""
        CREATE TABLE IF NOT EXISTS planes (
            ts       REAL NOT NULL,
            icao24   TEXT NOT NULL,
            callsign TEXT,
            lat      REAL NOT NULL,
            lon      REAL NOT NULL,
            altitude REAL,
            velocity REAL,
            heading  REAL,
            PRIMARY KEY (ts, icao24)
        )
    """)
    await _db.execute("CREATE INDEX IF NOT EXISTS idx_planes_ts ON planes(ts)")
    await _db.execute("""
        CREATE TABLE IF NOT EXISTS ships (
            ts     REAL NOT NULL,
            mmsi   TEXT NOT NULL,
            name   TEXT,
            lat    REAL NOT NULL,
            lon    REAL NOT NULL,
            course REAL,
            speed  REAL,
            type   INTEGER,
            PRIMARY KEY (ts, mmsi)
        )
    """)
    await _db.execute("CREATE INDEX IF NOT EXISTS idx_ships_ts ON ships(ts)")
    await _db.commit()
    print(f"[db] history store ready: {DB_PATH}")


async def insert_planes(ts: float, planes: list[dict]) -> None:
    if not planes or _db is None:
        return
    rows = [
        (ts, p["id"], p.get("callsign"), p["lat"], p["lon"],
         p.get("altitude"), p.get("velocity"), p.get("heading"))
        for p in planes
    ]
    async with _write_lock:
        await _db.executemany(
            "INSERT OR IGNORE INTO planes"
            "(ts,icao24,callsign,lat,lon,altitude,velocity,heading)"
            " VALUES(?,?,?,?,?,?,?,?)",
            rows,
        )
        await _db.commit()


async def insert_ships(ts: float, ships: list[dict]) -> None:
    if not ships or _db is None:
        return
    rows = [
        (ts, s["mmsi"], s.get("name"), s["lat"], s["lon"],
         s.get("course"), s.get("speed"), s.get("type"))
        for s in ships
    ]
    async with _write_lock:
        await _db.executemany(
            "INSERT OR IGNORE INTO ships"
            "(ts,mmsi,name,lat,lon,course,speed,type)"
            " VALUES(?,?,?,?,?,?,?,?)",
            rows,
        )
        await _db.commit()


async def query_planes(
    ts: float, lamin: float, lomin: float, lamax: float, lomax: float
) -> list[dict]:
    if _db is None:
        return []
    # Look back up to 5 minutes to handle sparse polling coverage.
    async with _db.execute(
        """
        SELECT ts, icao24, callsign, lat, lon, altitude, velocity, heading
        FROM planes
        WHERE ts BETWEEN ? AND ?
          AND lat BETWEEN ? AND ?
          AND lon BETWEEN ? AND ?
        ORDER BY ts DESC
        """,
        (ts - 300, ts, lamin, lamax, lomin, lomax),
    ) as cur:
        rows = await cur.fetchall()

    # Keep the most-recent record per aircraft.
    seen: dict[str, dict] = {}
    for r in rows:
        if r["icao24"] not in seen:
            seen[r["icao24"]] = {
                "id":        r["icao24"],
                "callsign":  r["callsign"] or "",
                "lat":       r["lat"],
                "lon":       r["lon"],
                "altitude":  r["altitude"],
                "velocity":  r["velocity"],
                "heading":   r["heading"],
                "timestamp": r["ts"],
            }
    return list(seen.values())


async def query_ships(
    ts: float, lamin: float, lomin: float, lamax: float, lomax: float
) -> list[dict]:
    if _db is None:
        return []
    async with _db.execute(
        """
        SELECT ts, mmsi, name, lat, lon, course, speed, type
        FROM ships
        WHERE ts BETWEEN ? AND ?
          AND lat BETWEEN ? AND ?
          AND lon BETWEEN ? AND ?
        ORDER BY ts DESC
        """,
        (ts - 300, ts, lamin, lamax, lomin, lomax),
    ) as cur:
        rows = await cur.fetchall()

    seen: dict[str, dict] = {}
    for r in rows:
        if r["mmsi"] not in seen:
            seen[r["mmsi"]] = {
                "mmsi":      r["mmsi"],
                "name":      r["name"] or "",
                "lat":       r["lat"],
                "lon":       r["lon"],
                "course":    r["course"],
                "speed":     r["speed"],
                "type":      r["type"],
                "timestamp": r["ts"],
            }
    return list(seen.values())


async def get_plane_track(icao24: str, since_ts: float, until_ts: float) -> list[dict]:
    """All recorded positions for an aircraft between two timestamps, oldest first."""
    if _db is None:
        return []
    async with _db.execute(
        """
        SELECT ts, lat, lon, altitude FROM planes
        WHERE icao24 = ? AND ts BETWEEN ? AND ?
        ORDER BY ts ASC
        """,
        (icao24, since_ts, until_ts),
    ) as cur:
        rows = await cur.fetchall()
    return [{"ts": r["ts"], "lat": r["lat"], "lon": r["lon"], "altitude": r["altitude"]} for r in rows]


async def get_ship_track(mmsi: str, since_ts: float, until_ts: float) -> list[dict]:
    """All recorded positions for a vessel between two timestamps, oldest first."""
    if _db is None:
        return []
    async with _db.execute(
        """
        SELECT ts, lat, lon FROM ships
        WHERE mmsi = ? AND ts BETWEEN ? AND ?
        ORDER BY ts ASC
        """,
        (mmsi, since_ts, until_ts),
    ) as cur:
        rows = await cur.fetchall()
    return [{"ts": r["ts"], "lat": r["lat"], "lon": r["lon"], "altitude": 0} for r in rows]


HISTORY_TTL_SECONDS = 24 * 60 * 60  # keep only the last 24 hours


def _vacuum_sync() -> None:
    """Run VACUUM in a plain sqlite3 connection (called via run_in_executor)."""
    import sqlite3 as _sqlite3
    conn = _sqlite3.connect(DB_PATH)
    try:
        conn.execute("VACUUM")
        conn.execute("PRAGMA journal_mode=WAL")
    finally:
        conn.close()


async def clear_all() -> dict:
    """Delete every row from planes and ships tables and VACUUM to reclaim disk space."""
    if _db is None:
        return {"planes": 0, "ships": 0}
    async with _write_lock:
        cur = await _db.execute("DELETE FROM planes")
        planes_deleted = cur.rowcount
        cur = await _db.execute("DELETE FROM ships")
        ships_deleted = cur.rowcount
        await _db.commit()
        # Checkpoint + truncate the WAL on the main connection — only the
        # connection that owns the WAL can shrink the -wal file.
        await _db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        await _db.commit()

    # VACUUM compacts the main DB file.  Run it in a thread executor with a
    # plain sqlite3 connection so aiosqlite's state cannot interfere.
    # Non-fatal — the DELETE + checkpoint already freed the space.
    try:
        loop = asyncio.get_event_loop()
        await loop.run_in_executor(None, _vacuum_sync)
    except Exception as exc:
        print(f"[db] VACUUM warning (data was cleared): {exc}")

    print(f"[db] cleared {planes_deleted} plane rows, {ships_deleted} ship rows (vacuumed)")
    return {"planes": planes_deleted, "ships": ships_deleted}


async def purge_old_records() -> dict:
    """Delete rows older than HISTORY_TTL_SECONDS. Returns counts of deleted rows."""
    if _db is None:
        return {"planes": 0, "ships": 0}
    cutoff = time.time() - HISTORY_TTL_SECONDS
    async with _write_lock:
        cur = await _db.execute("DELETE FROM planes WHERE ts < ?", (cutoff,))
        planes_deleted = cur.rowcount
        cur = await _db.execute("DELETE FROM ships WHERE ts < ?", (cutoff,))
        ships_deleted = cur.rowcount
        await _db.commit()
    print(f"[db] purged {planes_deleted} plane rows, {ships_deleted} ship rows older than 24 h")
    return {"planes": planes_deleted, "ships": ships_deleted}


async def get_time_range() -> dict:
    """Return the oldest and newest timestamps across both tables."""
    if _db is None:
        return {"min_ts": None, "max_ts": None}
    async with _db.execute("SELECT MIN(ts), MAX(ts) FROM planes") as cur:
        p = await cur.fetchone()
    async with _db.execute("SELECT MIN(ts), MAX(ts) FROM ships") as cur:
        s = await cur.fetchone()

    candidates_min = [v for v in (p[0], s[0]) if v is not None]
    candidates_max = [v for v in (p[1], s[1]) if v is not None]
    return {
        "min_ts": min(candidates_min) if candidates_min else None,
        "max_ts": max(candidates_max) if candidates_max else None,
    }
