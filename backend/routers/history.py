"""
History endpoints — serve recorded position data for replay.

GET /api/history/range
    Returns {min_ts, max_ts} — the full time span of recorded data.
    Frontend polls this every few seconds to keep the slider range current.

GET /api/history/planes?ts=&lamin=&lomin=&lamax=&lomax=
    Returns the most-recent position for each aircraft in the bbox as of ts.
    Looks back up to 5 minutes from ts (matches db.query_planes window).

GET /api/history/ships?ts=&lamin=&lomin=&lamax=&lomax=
    Same for vessels.
"""

import time
import db
from fastapi import APIRouter, Query, HTTPException

router = APIRouter()


@router.get("/history/track")
async def get_track(
    type:     str   = Query(..., description="'plane' or 'ship'"),
    id:       str   = Query(..., description="icao24 for planes, mmsi for ships"),
    hours:    float = Query(12.0, description="How many hours of history to return"),
    end_ts:   float | None = Query(None, description="End of window (Unix ts). Defaults to now."),
):
    """
    Return the recorded position track for a single aircraft or vessel.
    Points are sorted oldest-first so the frontend can draw a polyline.

    For satellites, track computation is done client-side via satellite.js
    (TLE propagation) — no DB endpoint needed.
    """
    until = end_ts if end_ts is not None else time.time()
    since = until - hours * 3600

    if type == "plane":
        points = await db.get_plane_track(id, since, until)
    elif type == "ship":
        points = await db.get_ship_track(id, since, until)
    else:
        raise HTTPException(status_code=400, detail="type must be 'plane' or 'ship'")

    return {"points": points, "count": len(points)}


@router.get("/history/range")
async def get_history_range():
    return await db.get_time_range()


@router.get("/history/planes")
async def get_history_planes(
    ts:    float = Query(..., description="Unix timestamp to replay"),
    lamin: float = Query(...),
    lomin: float = Query(...),
    lamax: float = Query(...),
    lomax: float = Query(...),
):
    planes = await db.query_planes(ts, lamin, lomin, lamax, lomax)
    return {"planes": planes, "count": len(planes)}


@router.get("/history/ships")
async def get_history_ships(
    ts:    float = Query(..., description="Unix timestamp to replay"),
    lamin: float = Query(...),
    lomin: float = Query(...),
    lamax: float = Query(...),
    lomax: float = Query(...),
):
    ships = await db.query_ships(ts, lamin, lomin, lamax, lomax)
    return {"ships": ships, "count": len(ships)}
