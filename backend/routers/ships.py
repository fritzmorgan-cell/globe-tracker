"""
GET /api/ships router

Returns live vessel positions from the in-memory store maintained by
services/aisstream_client.py. This endpoint makes no network calls —
it simply filters the store by the requested bounding box.

The aisstream.io WebSocket connection is started at server startup in main.py.
Set AISSTREAM_API_KEY in your .env file.

AIS fields returned:
    mmsi      — Maritime Mobile Service Identity (unique vessel key)
    name      — vessel name (from AIS ShipName field; may be blank)
    lat/lon   — WGS-84 position
    course    — course over ground in degrees (Cog)
    speed     — speed over ground in knots (Sog)
    type      — AIS vessel type integer (None — requires ShipStaticData messages)
    timestamp — Unix epoch seconds of last AIS message
"""

from fastapi import APIRouter, Query
from services.aisstream_client import get_vessels_in_bbox

router = APIRouter()


@router.get("/ships")
async def get_ships(
    lamin: float = Query(..., description="South latitude of bounding box"),
    lomin: float = Query(..., description="West longitude of bounding box"),
    lamax: float = Query(..., description="North latitude of bounding box"),
    lomax: float = Query(..., description="East longitude of bounding box"),
):
    """
    Return live vessel positions within the given bounding box.

    Data comes from the in-memory vessel store populated by the aisstream.io
    WebSocket background task. No upstream HTTP call is made per request.

    The store is evicted of vessels older than 5 minutes on each read.
    """
    vessels = get_vessels_in_bbox(lamin, lomin, lamax, lomax)
    return {"ships": vessels, "count": len(vessels)}
