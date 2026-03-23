"""
GET /api/planes router

Fetches live aircraft state vectors from the OpenSky Network public REST API
and normalises them into a consistent shape for the frontend.

OpenSky state-vector array indices used:
    0  icao24         — unique ICAO 24-bit transponder address (used as entity id)
    1  callsign       — flight callsign (may be null or whitespace-padded)
    4  last_contact   — Unix timestamp of last ADS-B message
    5  longitude      — WGS-84 longitude in decimal degrees (null if unknown)
    6  latitude       — WGS-84 latitude in decimal degrees (null if unknown)
    7  baro_altitude  — barometric altitude in metres (null if unknown)
    9  velocity       — ground speed in m/s (null if unknown)
   10  true_track     — track angle in degrees clockwise from north (null if unknown)

Docs: https://openskynetwork.github.io/opensky-api/rest.html

Auth: OpenSky uses OAuth2 client credentials. Set OPENSKY_CLIENT_ID and
OPENSKY_CLIENT_SECRET in your .env. The access token is cached in memory
and refreshed automatically when it expires.
"""

import asyncio
import os
import time
import httpx
from fastapi import APIRouter, HTTPException, Query
from cache import get_or_fetch
import db

router = APIRouter()

OPENSKY_URL       = "https://opensky-network.org/api/states/all"
OPENSKY_TOKEN_URL = "https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token"

# In-memory token cache: (access_token, expires_at_monotonic)
_token_cache: tuple[str, float] | None = None


async def _get_access_token() -> str | None:
    """
    Fetch an OAuth2 client-credentials token from OpenSky and cache it
    until 30 seconds before expiry.  Returns None if credentials are absent
    (falls back to anonymous/unauthenticated access).
    """
    global _token_cache

    client_id     = os.getenv("OPENSKY_CLIENT_ID", "").strip()
    client_secret = os.getenv("OPENSKY_CLIENT_SECRET", "").strip()
    if not client_id or not client_secret:
        return None  # anonymous access

    now = time.monotonic()
    if _token_cache and now < _token_cache[1]:
        return _token_cache[0]  # still valid

    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            OPENSKY_TOKEN_URL,
            data={
                "grant_type":    "client_credentials",
                "client_id":     client_id,
                "client_secret": client_secret,
            },
        )

    if resp.status_code != 200:
        raise HTTPException(
            status_code=502,
            detail=f"OpenSky token request failed: HTTP {resp.status_code}",
        )

    body = resp.json()
    token      = body["access_token"]
    expires_in = int(body.get("expires_in", 300))
    _token_cache = (token, now + expires_in - 30)  # refresh 30s early
    return token


def _normalize_state(state: list) -> dict | None:
    """Convert a single OpenSky state vector to a normalised dict.
    Returns None if lat or lon is missing."""
    lat = state[6]
    lon = state[5]
    if lat is None or lon is None:
        return None

    callsign = state[1]
    if callsign:
        callsign = callsign.strip()

    return {
        "id": state[0],           # icao24 — EntityLayer key
        "callsign": callsign or "",
        "lat": lat,
        "lon": lon,
        "altitude": state[7],     # metres barometric; may be None
        "velocity": state[9],     # m/s; may be None
        "heading": state[10],     # degrees clockwise from north; may be None
        "timestamp": state[4],    # Unix epoch seconds
    }


async def _fetch_planes(lamin: float, lomin: float, lamax: float, lomax: float) -> list[dict]:
    params = {"lamin": lamin, "lomin": lomin, "lamax": lamax, "lomax": lomax}
    token = await _get_access_token()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(timeout=15.0) as client:
        response = await client.get(OPENSKY_URL, params=params, headers=headers)

    if response.status_code == 429:
        raise HTTPException(status_code=429, detail="OpenSky rate limit exceeded — try again shortly.")
    if response.status_code != 200:
        raise HTTPException(status_code=502, detail=f"OpenSky returned HTTP {response.status_code}")

    states = response.json().get("states") or []
    result = [n for s in states if (n := _normalize_state(s)) is not None]
    # Fire-and-forget DB write — does not block the response.
    asyncio.create_task(db.insert_planes(time.time(), result))
    return result


@router.get("/planes")
async def get_planes(
    lamin: float = Query(..., description="South latitude of bounding box"),
    lomin: float = Query(..., description="West longitude of bounding box"),
    lamax: float = Query(..., description="North latitude of bounding box"),
    lomax: float = Query(..., description="East longitude of bounding box"),
):
    """
    Return live aircraft positions within the given bounding box.
    Cached for CACHE_TTL_SECONDS per unique (rounded) bbox.
    """
    # Round to 2 decimal places (~1 km) to maximise cache hit rate across small pans.
    bbox_key = f"{lamin:.2f},{lomin:.2f},{lamax:.2f},{lomax:.2f}"

    data = await get_or_fetch(
        domain="planes",
        key=bbox_key,
        fetcher=lambda: _fetch_planes(lamin, lomin, lamax, lomax),
    )
    return {"planes": data, "count": len(data)}
