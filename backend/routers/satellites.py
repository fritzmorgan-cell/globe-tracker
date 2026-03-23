"""
GET /api/satellites/tle?group=visual

Fetches Two-Line Element (TLE) orbital data from the SatNOGS database
(https://db.satnogs.org/api/tle/) and returns a list of {id, name, tle1, tle2}
records. The frontend uses satellite.js to propagate positions client-side.

SatNOGS sources its TLEs from Space-Track.org and updates them frequently.
The API returns all ~1500 currently-tracked active satellites.

Supported groups (filtered client-side from the full set):
    stations  — Space stations (ISS, Tiangong, etc.)
    visual    — All active (SatNOGS doesn't distinguish; ~1 500 objects)
    active    — All active (same as visual)
    starlink  — SpaceX Starlink constellation
    oneweb    — OneWeb constellation

TLE data is cached for 1 hour — TLEs change slowly.
"""

import time
import httpx
from fastapi import APIRouter, Query, HTTPException

router = APIRouter()

SATNOGS_URL = "https://db.satnogs.org/api/tle/?format=json"
ALLOWED_GROUPS = {"stations", "visual", "active", "starlink", "oneweb"}
CACHE_TTL      = 3600   # 1 hour

# Shared full-dataset cache (all groups draw from one fetch)
_all_cache: tuple[float, list[dict]] | None = None

# Group-specific name-filter keywords (lowercase)
_GROUP_FILTERS: dict[str, list[str]] = {
    "stations": ["iss", "zarya", "tiangong", "css", "unity", "zvezda", "progress"],
    "starlink":  ["starlink"],
    "oneweb":    ["oneweb"],
}


def _filter_group(records: list[dict], group: str) -> list[dict]:
    keywords = _GROUP_FILTERS.get(group)
    if not keywords:
        return records   # visual / active → return everything
    kws = keywords
    return [r for r in records if any(k in r["name"].lower() for k in kws)]


async def _fetch_all() -> list[dict]:
    """Fetch the full SatNOGS TLE dataset and normalise to {id, name, tle1, tle2}."""
    print("[satellites] fetching from SatNOGS…")
    async with httpx.AsyncClient(
        timeout=30.0,
        verify=False,
        follow_redirects=True,
    ) as client:
        try:
            resp = await client.get(
                SATNOGS_URL,
                headers={"User-Agent": "GlobeTracker/1.0"},
            )
            print(f"[satellites] SatNOGS → HTTP {resp.status_code}, {len(resp.content)} bytes")
            if resp.status_code != 200:
                raise HTTPException(
                    status_code=502,
                    detail=f"SatNOGS returned HTTP {resp.status_code}",
                )
            raw = resp.json()
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"SatNOGS fetch error: {e}")

    result = []
    for entry in raw:
        try:
            # tle0 is "0 NAME" in 3-line format; strip the leading "0 " if present
            name = entry.get("tle0", "").strip()
            if name.startswith("0 "):
                name = name[2:]
            tle1 = entry.get("tle1", "").strip()
            tle2 = entry.get("tle2", "").strip()
            if not (tle1.startswith("1 ") and tle2.startswith("2 ")):
                continue
            cat_num = str(entry.get("norad_cat_id", tle1[2:7].strip()))
            result.append({"id": cat_num, "name": name, "tle1": tle1, "tle2": tle2})
        except Exception:
            continue

    print(f"[satellites] parsed {len(result)} TLEs from SatNOGS")
    return result


async def _cached_fetch(group: str) -> list[dict]:
    global _all_cache
    now = time.monotonic()
    if _all_cache is not None:
        ts, data = _all_cache
        if now - ts < CACHE_TTL:
            return _filter_group(data, group)

    data = await _fetch_all()
    _all_cache = (now, data)
    return _filter_group(data, group)


@router.get("/satellites/tle")
async def get_satellite_tles(
    group: str = Query(
        "visual",
        description="TLE group: stations | visual | active | starlink | oneweb",
    ),
):
    """
    Return TLE data for a satellite group.
    The frontend propagates positions using satellite.js.
    Cached for 1 hour (one fetch serves all groups).
    """
    if group not in ALLOWED_GROUPS:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown group '{group}'. Allowed: {', '.join(sorted(ALLOWED_GROUPS))}",
        )
    return await _cached_fetch(group)
