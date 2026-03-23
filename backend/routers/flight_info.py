"""
GET /api/flight-info?callsign=<callsign>&icao24=<hex>

Looks up route, airline, and photo information for a flight.

Data sources (both called in parallel, no auth required):
  - adsbdb.com  — route, airline, aircraft type, registration
      GET https://api.adsbdb.com/v0/callsign/{callsign}
  - Planespotters.net — aircraft photos (much better coverage than adsbdb)
      GET https://api.planespotters.net/pub/photos/hex/{icao24}

Results are cached for 60 seconds per callsign.
"""

import time
import asyncio
import httpx
from fastapi import APIRouter, Query

router = APIRouter()

ADSBDB_CALLSIGN_URL = "https://api.adsbdb.com/v0/callsign/{callsign}"
ADSBDB_AIRCRAFT_URL = "https://api.adsbdb.com/v0/aircraft/{icao24}"
PLANESPOTTERS_URL   = "https://api.planespotters.net/pub/photos/hex/{icao24}"

_flight_cache: dict[str, tuple[float, dict]] = {}


def _normalize_adsbdb(body: dict) -> dict:
    resp     = body.get("response", {})
    route    = resp.get("flightroute", {})
    aircraft = resp.get("aircraft", {})
    airline  = route.get("airline", {})
    origin   = route.get("origin", {})
    dest     = route.get("destination", {})

    def airport_str(ap: dict) -> str | None:
        if not ap:
            return None
        parts = [ap.get("iata_code"), ap.get("name"), ap.get("municipality"), ap.get("country_name")]
        return " · ".join(p for p in parts if p) or None

    return {
        "callsign":     route.get("callsign") or route.get("callsign_iata"),
        "airline":      airline.get("name"),
        "iata":         airline.get("iata"),
        "origin":       airport_str(origin),
        "origin_iata":  origin.get("iata_code"),
        "destination":  airport_str(dest),
        "dest_iata":    dest.get("iata_code"),
    }


def _extract_planespotters_photo(body: dict) -> tuple[str | None, str | None]:
    """Return (thumb_url, full_url) from the first Planespotters result."""
    photos = body.get("photos", [])
    if not photos:
        return None, None
    first = photos[0]
    thumb = first.get("thumbnail_large", {}).get("src") or first.get("thumbnail", {}).get("src")
    full  = first.get("link")
    return thumb, full


async def _fetch_both(callsign: str, icao24: str | None) -> dict:
    async with httpx.AsyncClient(timeout=10.0) as client:
        tasks = [client.get(ADSBDB_CALLSIGN_URL.format(callsign=callsign.upper()))]
        if icao24:
            tasks.append(client.get(ADSBDB_AIRCRAFT_URL.format(icao24=icao24.lower())))
            tasks.append(client.get(PLANESPOTTERS_URL.format(icao24=icao24.lower())))

        results = await asyncio.gather(*tasks, return_exceptions=True)

    callsign_resp = results[0]
    aircraft_resp = results[1] if icao24 and len(results) > 1 else None
    ps_resp       = results[2] if icao24 and len(results) > 2 else None

    # Route info from callsign endpoint
    info: dict = {}
    if isinstance(callsign_resp, httpx.Response) and callsign_resp.status_code == 200:
        info = _normalize_adsbdb(callsign_resp.json())

    # Aircraft make/model/registration from aircraft endpoint
    if isinstance(aircraft_resp, httpx.Response) and aircraft_resp.status_code == 200:
        ac = aircraft_resp.json().get("response", {}).get("aircraft", {})
        mfr  = ac.get("manufacturer", "")
        typ  = ac.get("type", "")
        info["aircraft"]     = f"{mfr} {typ}".strip() if mfr or typ else None
        info["registration"] = ac.get("registration")
        info["icao_type"]    = ac.get("icao_type")

    # Planespotters photo
    photo_thumb, photo_url = None, None
    if isinstance(ps_resp, httpx.Response) and ps_resp.status_code == 200:
        photo_thumb, photo_url = _extract_planespotters_photo(ps_resp.json())

    info["photo_thumb"] = photo_thumb
    info["photo_url"]   = photo_url
    return info


async def _cached_fetch(callsign: str, icao24: str | None) -> dict:
    key = f"{callsign.upper()}|{(icao24 or '').lower()}"
    now = time.monotonic()
    if key in _flight_cache:
        ts, data = _flight_cache[key]
        if now - ts < 60:
            return data
    data = await _fetch_both(callsign, icao24)
    _flight_cache[key] = (now, data)
    return data


@router.get("/flight-info")
async def get_flight_info(
    callsign: str = Query(..., description="Flight callsign, e.g. UAL123"),
    icao24: str | None = Query(None, description="ICAO 24-bit hex address for photo lookup"),
):
    """
    Return route, airline, and photo info for a flight.
    adsbdb (route) and Planespotters (photo) are fetched in parallel.
    Returns an empty object if no data is available.
    """
    if not callsign.strip():
        return {}
    return await _cached_fetch(callsign.strip(), icao24.strip() if icao24 else None)
