"""
Simple in-memory TTL cache shared across the application.

Each cache entry is stored as:
    cache_store[cache_key] = (fetched_at: float, data: any)

where fetched_at is time.monotonic() at the moment data was stored.

Future extension hook — history/replay:
    After writing to this cache you could also write the raw payload to SQLite.
    Insert a call like `await db.insert_snapshot(domain, bbox_key, data, time.time())`
    immediately after the `store[key] = ...` line in get_or_fetch().
    Then expose a GET /api/history?domain=planes&ts=<unix> endpoint that
    queries that table to power a time-scrub replay UI.
"""

import time
from typing import Any, Callable, Awaitable

# Global in-memory stores — one dict per data domain keeps eviction simple.
_plane_cache: dict[str, tuple[float, Any]] = {}
_ship_cache: dict[str, tuple[float, Any]] = {}

# Time-to-live in seconds before a cached entry is considered stale.
# OpenSky allows ~1 request per 10 s (anonymous) / 5 s (registered).
# 30 s gives comfortable headroom and reduces rate-limit risk when the
# user pans slightly (which changes the bbox key).
CACHE_TTL_SECONDS = 30


def _select_store(domain: str) -> dict:
    if domain == "planes":
        return _plane_cache
    if domain == "ships":
        return _ship_cache
    raise ValueError(f"Unknown cache domain: {domain!r}")


async def get_or_fetch(
    domain: str,
    key: str,
    fetcher: Callable[[], Awaitable[Any]],
) -> Any:
    """
    Return cached data if fresh; otherwise call fetcher(), store, and return.
    If fetcher raises (e.g. 429 rate-limit), return stale cached data when
    available so the frontend keeps seeing the last known positions.

    Args:
        domain:  'planes' or 'ships'
        key:     Typically the rounded bbox string, e.g. '10.00,20.00,50.00,60.00'
        fetcher: Async callable returning fresh data
    """
    store = _select_store(domain)
    now = time.monotonic()

    if key in store:
        fetched_at, data = store[key]
        if now - fetched_at < CACHE_TTL_SECONDS:
            return data

    try:
        data = await fetcher()
    except Exception:
        # On upstream error return stale data if we have any; otherwise re-raise.
        if key in store:
            print(f"[cache] upstream error for {domain}/{key} — serving stale data")
            return store[key][1]
        raise

    store[key] = (now, data)

    # FUTURE HOOK — SQLite history write:
    # await db.insert_snapshot(domain=domain, bbox_key=key, payload=data, ts=time.time())

    return data
