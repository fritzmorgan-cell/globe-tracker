"""
GET /api/airports — Commercial airports with IATA codes.

Data source: OurAirports (https://ourairports.com/data/airports.csv)
Includes:
  - All large_airport entries with an IATA code
  - medium_airport and small_airport with scheduled_service=yes and an IATA code
Cached for 24 hours (airport data changes infrequently).
"""

import csv
import io
import time
import httpx
from fastapi import APIRouter

router = APIRouter()

AIRPORTS_CSV_URL = "https://ourairports.com/data/airports.csv"
CACHE_TTL = 86_400  # 24 hours

_cache = None  # (monotonic_time, list[dict]) when populated


def _parse_csv(text: str) -> list[dict]:
    records = []
    reader = csv.DictReader(io.StringIO(text))
    for row in reader:
        iata = row.get("iata_code", "").strip()
        if not iata:
            continue
        atype = row.get("type", "")
        scheduled = row.get("scheduled_service", "")
        if atype == "large_airport":
            pass  # always include
        elif atype in ("medium_airport", "small_airport") and scheduled == "yes":
            pass  # include scheduled-service airports
        else:
            continue
        try:
            lat = float(row["latitude_deg"])
            lon = float(row["longitude_deg"])
        except (ValueError, KeyError):
            continue
        elev_raw = row.get("elevation_ft", "").strip()
        try:
            elevation_ft = int(float(elev_raw)) if elev_raw else 0
        except ValueError:
            elevation_ft = 0
        records.append({
            "iata":         iata,
            "name":         row.get("name", "").strip(),
            "city":         row.get("municipality", "").strip(),
            "country":      row.get("iso_country", "").strip(),
            "lat":          round(lat, 6),
            "lon":          round(lon, 6),
            "elevation_ft": elevation_ft,
            "altitude":     round(elevation_ft * 0.3048) + 150,  # metres above ellipsoid (+150 m buffer above terrain)
            "type":         atype,
        })
    return records


async def _fetch_airports() -> list[dict]:
    global _cache
    now = time.monotonic()
    if _cache and (now - _cache[0]) < CACHE_TTL:
        return _cache[1]
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(AIRPORTS_CSV_URL)
        resp.raise_for_status()
    data = _parse_csv(resp.text)
    _cache = (now, data)
    print(f"[airports] loaded {len(data)} airports")
    return data


@router.get("/airports")
async def get_airports():
    """Return all commercial airports with IATA codes."""
    return await _fetch_airports()
