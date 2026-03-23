"""
GET /api/ship-info?mmsi=<mmsi>

Returns vessel type description and a MarineTraffic photo URL for a given MMSI.
No external API call is made — the type description comes from the AIS spec
lookup table and the photo URL is constructed and returned for the browser to load.

MarineTraffic photo URL format:
    https://photos.marinetraffic.com/ais/showphoto.aspx?mmsi=<mmsi>&size=thumb300
This is a public URL. The browser loads it directly; it may return a real photo
or a placeholder image if no photo is on file.
"""

from fastapi import APIRouter, Query

router = APIRouter()

# AIS vessel type code → human-readable description.
# Codes 60-69 = Passenger, 70-79 = Cargo, 80-89 = Tanker, 90-99 = Other.
# Single representative code covers the whole decade band.
_AIS_TYPES: dict[int, str] = {
    0:  "Unknown",
    20: "Wing In Ground",
    30: "Fishing",
    31: "Towing",
    32: "Towing (Large)",
    33: "Dredging / Underwater Ops",
    34: "Diving Ops",
    35: "Military Ops",
    36: "Sailing",
    37: "Pleasure Craft",
    40: "High Speed Craft",
    50: "Pilot Vessel",
    51: "Search And Rescue",
    52: "Tug",
    53: "Port Tender",
    54: "Anti-Pollution",
    55: "Law Enforcement",
    58: "Medical Transport",
    59: "Non-Combatant",
    60: "Passenger",
    70: "Cargo",
    80: "Tanker",
    90: "Other",
}


def _type_description(code: int | None) -> str:
    if code is None:
        return "Unknown"
    # Exact match first, then decade band (e.g. 73 → 70 → "Cargo").
    if code in _AIS_TYPES:
        return _AIS_TYPES[code]
    band = (code // 10) * 10
    return _AIS_TYPES.get(band, "Unknown")


@router.get("/ship-info")
async def get_ship_info(
    mmsi: str = Query(..., description="MMSI number as a string"),
    type_code: int | None = Query(None, description="AIS vessel type integer from position report"),
):
    """
    Return vessel type description and a MarineTraffic photo URL.
    The photo URL is returned for the browser to load directly — it may or may
    not have a photo on file for this vessel.
    """
    mmsi = mmsi.strip()
    return {
        "mmsi":        mmsi,
        "type_label":  _type_description(type_code),
        "photo_thumb": f"https://photos.marinetraffic.com/ais/showphoto.aspx?mmsi={mmsi}&size=thumb300",
        "photo_url":   f"https://photos.marinetraffic.com/ais/showphoto.aspx?mmsi={mmsi}",
    }
