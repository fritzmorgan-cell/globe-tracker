/**
 * api.js — Fetch wrappers for the Globe Tracker backend.
 *
 * Change API_BASE to point at a deployed backend; no other files need to change.
 *
 * Future extension hook — additional layers:
 *   Add a fetchSatellites(bbox) function here following the same pattern,
 *   then call it from app.js. No changes needed in entityLayer.js.
 */

const API_BASE = 'http://localhost:8000';

/** Build URLSearchParams from a bbox object, rounded to 4 decimal places. */
function _bboxParams(bbox) {
  return new URLSearchParams({
    lamin: bbox.lamin.toFixed(4),
    lomin: bbox.lomin.toFixed(4),
    lamax: bbox.lamax.toFixed(4),
    lomax: bbox.lomax.toFixed(4),
  }).toString();
}

/**
 * Fetch live aircraft within the given bounding box.
 * @param {{ lamin, lomin, lamax, lomax }} bbox
 * @returns {Promise<{ planes: Array, count: number }>}
 */
async function fetchPlanes(bbox) {
  const res = await fetch(`${API_BASE}/api/planes?${_bboxParams(bbox)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Planes API ${res.status}: ${body.detail || res.statusText}`);
  }
  return res.json();
}

/**
 * Fetch TLE orbital data for a CelesTrak satellite group.
 * @param {string} group  'visual' | 'stations' | 'starlink' | 'active' | 'oneweb'
 * @returns {Promise<Array<{id, name, tle1, tle2}>>}
 */
async function fetchTLEs(group = 'visual') {
  const res = await fetch(`${API_BASE}/api/satellites/tle?group=${encodeURIComponent(group)}`);
  if (!res.ok) throw new Error(`TLE fetch failed: ${res.status}`);
  return res.json();
}

/**
 * Fetch the recorded position track for a plane or ship.
 * @param {'plane'|'ship'} type
 * @param {string} id  icao24 for planes, mmsi for ships
 * @param {number} hours  how many hours of history to fetch
 * @param {number|null} endTs  end of window (Unix ts); defaults to now
 * @returns {Promise<{points: Array<{ts,lat,lon,altitude}>, count: number}>}
 */
async function fetchTrack(type, id, hours = 12, endTs = null) {
  const params = new URLSearchParams({ type, id, hours });
  if (endTs != null) params.set('end_ts', endTs);
  const res = await fetch(`${API_BASE}/api/history/track?${params}`);
  if (!res.ok) return { points: [], count: 0 };
  return res.json();
}

/**
 * Fetch the time range of recorded history {min_ts, max_ts}.
 * @returns {Promise<{min_ts: number|null, max_ts: number|null}>}
 */
async function fetchHistoryRange() {
  const res = await fetch(`${API_BASE}/api/history/range`);
  if (!res.ok) return { min_ts: null, max_ts: null };
  return res.json();
}

/**
 * Fetch historical plane positions at a given Unix timestamp.
 * @param {number} ts  Unix epoch seconds
 * @param {{ lamin, lomin, lamax, lomax }} bbox
 */
async function fetchHistoryPlanes(ts, bbox) {
  const params = new URLSearchParams({ ts, ...Object.fromEntries(
    Object.entries(bbox).map(([k, v]) => [k, v.toFixed(4)])
  )});
  const res = await fetch(`${API_BASE}/api/history/planes?${params}`);
  if (!res.ok) return { planes: [], count: 0 };
  return res.json();
}

/**
 * Fetch historical ship positions at a given Unix timestamp.
 * @param {number} ts
 * @param {{ lamin, lomin, lamax, lomax }} bbox
 */
async function fetchHistoryShips(ts, bbox) {
  const params = new URLSearchParams({ ts, ...Object.fromEntries(
    Object.entries(bbox).map(([k, v]) => [k, v.toFixed(4)])
  )});
  const res = await fetch(`${API_BASE}/api/history/ships?${params}`);
  if (!res.ok) return { ships: [], count: 0 };
  return res.json();
}

/**
 * Fetch route + airline info for a callsign.
 * Returns an empty object if no data is available (not an error).
 * @param {string} callsign
 * @returns {Promise<object>}
 */
async function fetchFlightInfo(callsign, icao24) {
  const params = new URLSearchParams({ callsign });
  if (icao24) params.set('icao24', icao24);
  const res = await fetch(`${API_BASE}/api/flight-info?${params}`);
  if (!res.ok) return {};
  return res.json();
}

/**
 * Fetch vessel type description and photo URL for an MMSI.
 * @param {string} mmsi
 * @param {number|null} typeCode  AIS vessel type integer
 * @returns {Promise<object>}
 */
async function fetchShipInfo(mmsi, typeCode) {
  const params = new URLSearchParams({ mmsi });
  if (typeCode != null) params.set('type_code', typeCode);
  const res = await fetch(`${API_BASE}/api/ship-info?${params}`);
  if (!res.ok) return {};
  return res.json();
}

/**
 * Fetch live vessels within the given bounding box.
 * @param {{ lamin, lomin, lamax, lomax }} bbox
 * @returns {Promise<{ ships: Array, count: number }>}
 */
async function fetchShips(bbox) {
  const res = await fetch(`${API_BASE}/api/ships?${_bboxParams(bbox)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Ships API ${res.status}: ${body.detail || res.statusText}`);
  }
  return res.json();
}
