"""
aisstream.io WebSocket client.

Architecture:
    Unlike a REST API, aisstream.io is a streaming WebSocket feed. Rather than
    fetching on every /api/ships request, this module maintains ONE persistent
    WebSocket connection that continuously receives AIS position reports and
    writes them into an in-memory vessel store (_vessels dict).

    The /api/ships endpoint then simply filters that dict by the requested bbox —
    it never makes a network call itself.

WebSocket endpoint:  wss://stream.aisstream.io/v0/stream
Subscription message:
    {
        "APIKey": "<key>",
        "BoundingBoxes": [[[-90, -180], [90, 180]]],   ← world coverage
        "FilterMessageTypes": ["PositionReport"]
    }

PositionReport message shape (relevant fields):
    {
        "MessageType": "PositionReport",
        "MetaData": {
            "MMSI": 123456789,
            "MMSI_String": "123456789",
            "ShipName": "VESSEL NAME",
            "latitude": 51.5074,
            "longitude": -0.1278,
            "time_utc": "2023-01-01 12:00:00.000000 +0000 UTC"
        },
        "Message": {
            "PositionReport": {
                "Cog": 270.0,    ← course over ground, degrees
                "Sog": 5.2,      ← speed over ground, knots
                "TrueHeading": 270
            }
        }
    }

Note: The subscription uses world coverage [[-90,-180],[90,180]] so all vessels
are captured globally. The bbox filter happens at read time in ships.py.
For very high traffic deployments you could narrow the subscription box and
update it dynamically, but for a local scaffold world coverage is fine.
"""

import asyncio
import json
import os
import time
import websockets

AISSTREAM_URL = "wss://stream.aisstream.io/v0/stream"

# Vessel store: { mmsi_string: normalised_vessel_dict }
# Updated continuously by the background WebSocket task.
_vessels: dict[str, dict] = {}

# Monotonic timestamp of the last position update per MMSI.
# Used to evict vessels that have gone silent.
_updated_at: dict[str, float] = {}

# Vessels not updated within this window are considered stale and removed.
VESSEL_TTL_SECONDS = 300  # 5 minutes


def get_vessels_in_bbox(lamin: float, lomin: float, lamax: float, lomax: float) -> list[dict]:
    """
    Return all vessels currently in the in-memory store that fall within
    the given bounding box. Called by the /api/ships endpoint.
    """
    _evict_stale()
    return [
        v for v in _vessels.values()
        if lamin <= v["lat"] <= lamax and lomin <= v["lon"] <= lomax
    ]


def _evict_stale() -> None:
    """Remove vessels whose last update is older than VESSEL_TTL_SECONDS."""
    cutoff = time.monotonic() - VESSEL_TTL_SECONDS
    stale = [mmsi for mmsi, ts in _updated_at.items() if ts < cutoff]
    for mmsi in stale:
        _vessels.pop(mmsi, None)
        _updated_at.pop(mmsi, None)


def _process_message(raw: str) -> None:
    """Parse one WebSocket message and upsert the vessel store."""
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return

    if msg.get("MessageType") != "PositionReport":
        return

    meta = msg.get("MetaData", {})
    report = msg.get("Message", {}).get("PositionReport", {})

    mmsi = str(meta.get("MMSI_String") or meta.get("MMSI", ""))
    if not mmsi:
        return

    lat = meta.get("latitude")
    lon = meta.get("longitude")
    if lat is None or lon is None:
        return

    _vessels[mmsi] = {
        "mmsi":      mmsi,
        "name":      meta.get("ShipName", "").strip(),
        "lat":       lat,
        "lon":       lon,
        "course":    report.get("Cog"),        # degrees; may be None
        "speed":     report.get("Sog"),        # knots; may be None
        "type":      None,                     # requires ShipStaticData message
        "timestamp": _parse_timestamp(meta.get("time_utc")),
    }
    _updated_at[mmsi] = time.monotonic()


def _parse_timestamp(time_utc: str | None) -> float | None:
    """Convert aisstream's 'time_utc' string to a Unix epoch float."""
    if not time_utc:
        return None
    try:
        # Format: "2023-01-01 12:00:00.000000 +0000 UTC"
        from datetime import datetime, timezone
        # Strip trailing " UTC" if present then parse.
        clean = time_utc.replace(" UTC", "").strip()
        dt = datetime.strptime(clean, "%Y-%m-%d %H:%M:%S.%f %z")
        return dt.timestamp()
    except Exception:
        return None


async def snapshot_loop() -> None:
    """
    Every 60 seconds, write the current vessel store to SQLite.
    Runs as a separate background task alongside run().
    """
    import db
    while True:
        await asyncio.sleep(60)
        if _vessels:
            ts = time.time()
            await db.insert_ships(ts, list(_vessels.values()))
            print(f"[db] snapshotted {len(_vessels)} ships at ts={ts:.0f}")


async def run(api_key: str) -> None:
    """
    Background coroutine — maintains a persistent WebSocket connection to
    aisstream.io and continuously populates _vessels. Reconnects automatically
    on any error.

    Start this from FastAPI's lifespan startup hook (see main.py).
    """
    subscribe_msg = json.dumps({
        "APIKey": api_key,
        "BoundingBoxes": [[[-90, -180], [90, 180]]],
        "FilterMessageTypes": ["PositionReport"],
    })

    while True:
        try:
            print("[aisstream] connecting…")
            async with websockets.connect(AISSTREAM_URL, ping_interval=30) as ws:
                await ws.send(subscribe_msg)
                print("[aisstream] subscribed — receiving position reports")
                async for raw in ws:
                    _process_message(raw)
        except Exception as exc:
            print(f"[aisstream] connection lost: {exc} — reconnecting in 10s")
            await asyncio.sleep(10)
