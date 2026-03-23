/**
 * app.js — Application orchestrator.
 *
 * Responsibilities:
 *   1. Initialise the CesiumJS Viewer.
 *   2. Create EntityLayer instances for planes and ships.
 *   3. Compute the camera bounding box on each poll cycle.
 *   4. Poll the backend every POLL_INTERVAL_MS milliseconds.
 *   5. Wire up checkbox events to show/hide layers.
 *   6. Update the status bar.
 *
 * Load order (enforced by index.html): api.js → entityLayer.js → app.js
 */

// ─── Configuration ────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 8_000;

/**
 * Skip fetching when the camera is higher than this (metres above ellipsoid).
 * Above ~4 000 km the bbox covers a huge portion of the globe and the response
 * would be enormous or rejected by upstream APIs.
 */
const MAX_FETCH_ALTITUDE_M = 4_000_000;

// ─── CesiumJS Viewer ──────────────────────────────────────────────────────────

// Detect whether a real Google Maps API key has been provided.
const _useGoogleTiles = typeof GOOGLE_MAPS_API_KEY !== 'undefined' &&
                        GOOGLE_MAPS_API_KEY !== 'YOUR_GOOGLE_MAPS_API_KEY';

const viewer = new Cesium.Viewer('cesiumContainer', {
  // Skip Cesium World Terrain when Google Photorealistic 3D Tiles will be used —
  // Google tiles include their own terrain and imagery.
  terrain: _useGoogleTiles ? undefined : Cesium.Terrain.fromWorldTerrain(),
  timeline:              false,
  animation:             false,
  baseLayerPicker:       !_useGoogleTiles,  // Google tiles manage their own imagery
  geocoder:              false,
  navigationHelpButton:  true,
  useBrowserRecommendedResolution: true,
});

if (_useGoogleTiles) {
  Cesium.GoogleMaps.defaultApiKey = GOOGLE_MAPS_API_KEY;
  Cesium.createGooglePhotorealistic3DTileset()
    .then(tileset => {
      viewer.scene.primitives.add(tileset);
      // Hide the default WGS-84 ellipsoid globe — Google tiles provide
      // photorealistic terrain and imagery in its place.
      viewer.scene.globe.show = false;
      console.log('[Google 3D Tiles] Photorealistic tiles loaded');
    })
    .catch(err => {
      console.warn('[Google 3D Tiles] Failed to load — falling back to Cesium terrain:', err);
      viewer.scene.globe.show = true;
    });
}

// Start with a world overview.
viewer.camera.setView({
  destination: Cesium.Cartesian3.fromDegrees(0, 20, 18_000_000),
});

// ─── Roads tile overlay (CartoDB Voyager, no labels — roads are clearly styled)
const _roadsLayer = viewer.imageryLayers.addImageryProvider(
  new Cesium.UrlTemplateImageryProvider({
    url: 'https://a.basemaps.cartocdn.com/rastertiles/voyager_nolabels/{z}/{x}/{y}.png',
    maximumLevel: 19,
    credit: '© OpenStreetMap contributors, © CARTO',
  })
);
_roadsLayer.alpha = 0.75;
_roadsLayer.show  = true;

// ─── Icons (inline SVG data URIs — no extra network request) ─────────────────

const PLANE_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <!-- Top-down aircraft silhouette pointing north; EntityLayer rotates to heading -->
  <polygon points="16,2 12,14 4,13 4,17 12,16 10,28 16,25 22,28 20,16 28,17 28,13 20,14"
           fill="#4fc3f7" stroke="#1a6b8a" stroke-width="1"/>
</svg>
`)}`;

// ─── Aircraft type icons (top-down silhouettes, all pointing north) ───────────
// Applied to a plane entity after fetchFlightInfo returns the ICAO type code.
// Falls back to PLANE_ICON (generic) until type data loads.

const AIRCRAFT_TYPE_ICONS = (() => {
  const e = s => `data:image/svg+xml;utf8,${encodeURIComponent(s)}`;
  const C = '#4fc3f7', S = '#1a6b8a', D = '#2d8aad';
  return {

    // ── 4-engine wide-body (B747, A380, A340) ────────────────────────────────
    jet_wide4: e(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <ellipse cx="16" cy="15.5" rx="3" ry="13" fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <path d="M13,11 L0.5,19.5 L0.5,22 L13,17.5 L19,17.5 L31.5,22 L31.5,19.5 L19,11Z"
              fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <ellipse cx="4.5"  cy="20"   rx="1.8" ry="3.1" fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <ellipse cx="9.5"  cy="18"   rx="1.8" ry="3.1" fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <ellipse cx="22.5" cy="18"   rx="1.8" ry="3.1" fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <ellipse cx="27.5" cy="20"   rx="1.8" ry="3.1" fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <path d="M11,27 L16,26 L21,27 L16,28.5Z" fill="${C}"/>
      </svg>`),

    // ── 2-engine wide-body (B777, B787, A330, A350, B767) ────────────────────
    jet_wide2: e(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <ellipse cx="16" cy="15.5" rx="2.5" ry="13" fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <path d="M13.5,11.5 L1,20 L1,23 L13.5,18 L18.5,18 L31,23 L31,20 L18.5,11.5Z"
              fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <ellipse cx="6"  cy="20.5" rx="2.4" ry="3.8" fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <ellipse cx="26" cy="20.5" rx="2.4" ry="3.8" fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <path d="M11.5,27 L16,26 L20.5,27 L16,28.5Z" fill="${C}"/>
      </svg>`),

    // ── 2-engine narrow-body (B737, A320, MD-80) — default commercial ─────────
    jet_narrow: e(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <ellipse cx="16" cy="15.5" rx="1.8" ry="13" fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <path d="M14.2,12 L2,20 L2,22.5 L14.2,17.5 L17.8,17.5 L30,22.5 L30,20 L17.8,12Z"
              fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <ellipse cx="6.5"  cy="19.5" rx="1.8" ry="3"   fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <ellipse cx="25.5" cy="19.5" rx="1.8" ry="3"   fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <path d="M12.5,27.5 L16,26.5 L19.5,27.5 L16,29Z" fill="${C}"/>
      </svg>`),

    // ── Regional jet — tail-mounted engines (CRJ, ERJ, E-jets) ───────────────
    jet_regional: e(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <ellipse cx="16" cy="15" rx="1.3" ry="13.5" fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <path d="M14.7,13.5 L5,18 L5,20.5 L14.7,16.5 L17.3,16.5 L27,20.5 L27,18 L17.3,13.5Z"
              fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <ellipse cx="13" cy="26" rx="1.5" ry="3"   fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <ellipse cx="19" cy="26" rx="1.5" ry="3"   fill="${D}" stroke="${S}" stroke-width="0.4"/>
        <path d="M10,23 L16,22 L22,23 L16,24Z" fill="${C}" stroke="${S}" stroke-width="0.3"/>
      </svg>`),

    // ── Turboprop — propeller discs visible (ATR, Dash 8, PC-12) ─────────────
    turboprop: e(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <ellipse cx="16" cy="15.5" rx="1.5" ry="13" fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <path d="M14.5,12.5 L3,14 L3,17 L14.5,15.5 L17.5,15.5 L29,17 L29,14 L17.5,12.5Z"
              fill="${C}" stroke="${S}" stroke-width="0.5"/>
        <circle cx="5"  cy="15.5" r="3.5" fill="none" stroke="${C}" stroke-width="1.3"
                stroke-dasharray="3.2 2" opacity="0.9"/>
        <circle cx="27" cy="15.5" r="3.5" fill="none" stroke="${C}" stroke-width="1.3"
                stroke-dasharray="3.2 2" opacity="0.9"/>
        <circle cx="5"  cy="15.5" r="1.3" fill="${D}"/>
        <circle cx="27" cy="15.5" r="1.3" fill="${D}"/>
        <path d="M12.5,27.5 L16,26.5 L19.5,27.5 L16,29Z" fill="${C}"/>
      </svg>`),

    // ── Helicopter — main rotor disc + oval body + tail boom ─────────────────
    helicopter: e(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
        <circle cx="15" cy="14" r="12" fill="none" stroke="${C}" stroke-width="1.2" opacity="0.6"/>
        <line x1="3"  y1="14" x2="27" y2="14" stroke="${C}" stroke-width="1.8"/>
        <line x1="15" y1="2"  x2="15" y2="26" stroke="${C}" stroke-width="1.8"/>
        <ellipse cx="15" cy="19.5" rx="4.5" ry="7" fill="${C}" stroke="${S}" stroke-width="0.7"/>
        <circle cx="15" cy="14" r="2" fill="${D}"/>
        <line x1="14.5" y1="26.5" x2="14.5" y2="31"  stroke="${C}" stroke-width="1.5"/>
        <line x1="11.5" y1="30.5" x2="18.5" y2="30.5" stroke="${C}" stroke-width="1.2"/>
      </svg>`),
  };
})();

// ICAO aircraft type designator → icon category
const _ICAO_CAT = {
  // 4-engine wide-body
  B741:'jet_wide4',B742:'jet_wide4',B743:'jet_wide4',B744:'jet_wide4',B748:'jet_wide4',
  B74F:'jet_wide4',B74D:'jet_wide4',B74S:'jet_wide4',BLCF:'jet_wide4',
  A380:'jet_wide4',A388:'jet_wide4',
  A342:'jet_wide4',A343:'jet_wide4',A345:'jet_wide4',A346:'jet_wide4',IL96:'jet_wide4',
  // 2-engine wide-body
  B762:'jet_wide2',B763:'jet_wide2',B764:'jet_wide2',
  B772:'jet_wide2',B773:'jet_wide2',B77F:'jet_wide2',B77L:'jet_wide2',B77W:'jet_wide2',B779:'jet_wide2',
  B788:'jet_wide2',B789:'jet_wide2',B78X:'jet_wide2',
  A300:'jet_wide2',A30B:'jet_wide2',A310:'jet_wide2',
  A332:'jet_wide2',A333:'jet_wide2',A338:'jet_wide2',A339:'jet_wide2',
  A359:'jet_wide2',A35K:'jet_wide2',
  // Narrow-body jets
  B732:'jet_narrow',B733:'jet_narrow',B734:'jet_narrow',B735:'jet_narrow',
  B736:'jet_narrow',B737:'jet_narrow',B738:'jet_narrow',B739:'jet_narrow',
  B37M:'jet_narrow',B38M:'jet_narrow',B39M:'jet_narrow',B3XM:'jet_narrow',
  B752:'jet_narrow',B753:'jet_narrow',
  A318:'jet_narrow',A319:'jet_narrow',A320:'jet_narrow',A321:'jet_narrow',
  A19N:'jet_narrow',A20N:'jet_narrow',A21N:'jet_narrow',
  MD80:'jet_narrow',MD81:'jet_narrow',MD82:'jet_narrow',MD83:'jet_narrow',
  MD87:'jet_narrow',MD88:'jet_narrow',MD90:'jet_narrow',
  M80:'jet_narrow',M82:'jet_narrow',M83:'jet_narrow',M88:'jet_narrow',M90:'jet_narrow',
  B717:'jet_narrow',DC91:'jet_narrow',DC92:'jet_narrow',DC93:'jet_narrow',DC94:'jet_narrow',DC95:'jet_narrow',
  C919:'jet_narrow',T204:'jet_narrow',T214:'jet_narrow',
  // Regional jets (tail-mounted engines)
  CRJ1:'jet_regional',CRJ2:'jet_regional',CRJ7:'jet_regional',CRJ9:'jet_regional',
  CRJX:'jet_regional',CR1X:'jet_regional',
  E110:'jet_regional',E135:'jet_regional',E140:'jet_regional',E145:'jet_regional',
  E170:'jet_regional',E175:'jet_regional',E75L:'jet_regional',E75S:'jet_regional',
  E190:'jet_regional',E195:'jet_regional',E290:'jet_regional',E295:'jet_regional',
  SU95:'jet_regional',AJ21:'jet_regional',MRJ7:'jet_regional',MRJ9:'jet_regional',
  // Turboprops
  AT43:'turboprop',AT44:'turboprop',AT45:'turboprop',AT46:'turboprop',
  AT72:'turboprop',AT73:'turboprop',AT75:'turboprop',AT76:'turboprop',
  DH8A:'turboprop',DH8B:'turboprop',DH8C:'turboprop',DH8D:'turboprop',DHC8:'turboprop',
  SF34:'turboprop',SF3:'turboprop',J328:'turboprop',E120:'turboprop',
  C208:'turboprop',PC12:'turboprop',BE99:'turboprop',BE9L:'turboprop',
  DHC6:'turboprop',DH6:'turboprop',JS41:'turboprop',JS31:'turboprop',
  TBM7:'turboprop',TBM8:'turboprop',TBM9:'turboprop',C212:'turboprop',CN35:'turboprop',
  // Helicopters
  H60:'helicopter',S70:'helicopter',S61:'helicopter',S76:'helicopter',S92:'helicopter',
  B06:'helicopter',B206:'helicopter',
  EC35:'helicopter',EC30:'helicopter',EC20:'helicopter',EC45:'helicopter',
  AS50:'helicopter',AS32:'helicopter',AS55:'helicopter',AS65:'helicopter',
  R22:'helicopter',R44:'helicopter',R66:'helicopter',
  MI8:'helicopter',MI17:'helicopter',MI24:'helicopter',
  A139:'helicopter',AW89:'helicopter',CH47:'helicopter',H64:'helicopter',
};

/** Return the type-specific icon data URI, or null if ICAO type is unknown. */
function _aircraftIcon(icaoType) {
  const cat = _ICAO_CAT[(icaoType || '').toUpperCase()];
  return cat ? AIRCRAFT_TYPE_ICONS[cat] : null;
}

const SHIP_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <!-- Top-down vessel silhouette pointing north -->
  <path d="M16 2 L22 8 L22 24 L16 30 L10 24 L10 8 Z"
        fill="#aed581" stroke="#5a7a2a" stroke-width="1"/>
  <rect x="14" y="10" width="4" height="8" fill="#7cb342"/>
</svg>
`)}`;

const AIRPORT_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">
  <circle cx="7" cy="7" r="5.5" fill="#ffb300" stroke="#e65100" stroke-width="1"/>
</svg>
`)}`;

// ─── Entity layers ────────────────────────────────────────────────────────────

const planeLayer = new EntityLayer(viewer, {
  idField:        'id',
  labelField:     'callsign',
  billboardUrl:   PLANE_ICON,
  billboardScale: 0.8,
  labelColor:     Cesium.Color.fromCssColorString('#4fc3f7'),
});

const shipLayer = new EntityLayer(viewer, {
  idField:        'mmsi',
  labelField:     'name',
  billboardUrl:   SHIP_ICON,
  billboardScale: 0.8,
  labelColor:     Cesium.Color.fromCssColorString('#aed581'),
});

const airportLayer = new EntityLayer(viewer, {
  idField:           'iata',
  labelField:        'iata',
  billboardUrl:      AIRPORT_ICON,
  billboardScale:    1.0,
  labelColor:        Cesium.Color.fromCssColorString('#ffb300'),
  labelMaxDistance:  2_000_000,  // show IATA labels up to 2 000 km
  disableDepthTest:  true,       // always draw on top of terrain
});

const SAT_ICON = `data:image/svg+xml;utf8,${encodeURIComponent(`
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <!-- Satellite body -->
  <rect x="9" y="8" width="6" height="8" rx="1" fill="#e1bee7" stroke="#9c27b0" stroke-width="0.5"/>
  <!-- Solar panels left -->
  <rect x="1" y="10" width="7" height="4" rx="0.5" fill="#64b5f6" stroke="#1565c0" stroke-width="0.5"/>
  <!-- Solar panels right -->
  <rect x="16" y="10" width="7" height="4" rx="0.5" fill="#64b5f6" stroke="#1565c0" stroke-width="0.5"/>
  <!-- Dish -->
  <circle cx="12" cy="6" r="2.5" fill="none" stroke="#ce93d8" stroke-width="1.2"/>
  <line x1="12" y1="8" x2="12" y2="8.5" stroke="#ce93d8" stroke-width="1"/>
</svg>
`)}`;

// ─── Selection ring ───────────────────────────────────────────────────────────

const SELECTION_RING_SVG = `data:image/svg+xml;utf8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 52 52">
    <circle cx="26" cy="26" r="22" fill="none" stroke="#ff3333" stroke-width="2.5" stroke-dasharray="6 3" opacity="0.95"/>
  </svg>`
)}`;

let _selectedEntity = null;

const _selectionRing = viewer.entities.add({
  id: '__selection_ring__',
  show: false,
  position: new Cesium.CallbackProperty(() => {
    if (!_selectedEntity) return undefined;
    const pos = _selectedEntity.position;
    return pos ? pos.getValue(viewer.clock.currentTime) : undefined;
  }, false),
  billboard: {
    image: SELECTION_RING_SVG,
    scale: 1.5,
    disableDepthTestDistance: Number.POSITIVE_INFINITY,
    verticalOrigin:   Cesium.VerticalOrigin.CENTER,
    horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
  },
});

function _selectEntity(cesiumId) {
  _selectedEntity = cesiumId ? viewer.entities.getById(String(cesiumId)) : null;
  _selectionRing.show = !!_selectedEntity;
}

function _clearSelection() {
  _selectedEntity = null;
  _selectionRing.show = false;
}

// ─── Satellite propagation (SampledPositionProperty — smooth 60 fps motion) ───
//
// Instead of updating positions every 5 s (causing visible jumps), we pre-compute
// SGP4 samples at 30-second intervals and store them in a SampledPositionProperty.
// Cesium interpolates between samples on every render frame with no JS overhead.

let _satrecs     = [];
const _satEntityMap = new Map();  // String(norad_id) → Cesium.Entity

// Advance the Cesium clock in real-time so SampledPositionProperty animates.
viewer.clock.clockStep     = Cesium.ClockStep.SYSTEM_CLOCK;
viewer.clock.shouldAnimate = true;
viewer.clock.multiplier    = 1;

const SAT_STEP_S  = 30;    // SGP4 sample spacing (seconds)
const SAT_AHEAD_S = 600;   // pre-compute 10 minutes ahead

/** Compute Cartesian3 for a satrec at a given Date, or null on failure. */
function _satPos(satrec, date) {
  try {
    const pv = satellite.propagate(satrec, date);
    if (!pv?.position) return null;
    const gmst = satellite.gstime(date);
    const geo   = satellite.eciToGeodetic(pv.position, gmst);
    return Cesium.Cartesian3.fromDegrees(
      satellite.degreesLong(geo.longitude),
      satellite.degreesLat(geo.latitude),
      geo.height * 1000
    );
  } catch { return null; }
}

/** Append durationS seconds of 30 s samples to a SampledPositionProperty. */
function _addSatSamples(prop, satrec, fromDate, durationS) {
  const steps = Math.ceil(durationS / SAT_STEP_S);
  for (let i = 0; i <= steps; i++) {
    const date = new Date(fromDate.getTime() + i * SAT_STEP_S * 1000);
    const pos  = _satPos(satrec, date);
    if (pos) prop.addSample(Cesium.JulianDate.fromDate(date), pos);
  }
}

/**
 * (Re)build all satellite entities with SampledPositionProperty.
 * Done in batches of 100 to avoid blocking the UI.
 */
async function _buildSatEntities() {
  _satEntityMap.forEach(e => viewer.entities.remove(e));
  _satEntityMap.clear();

  const visible  = document.getElementById('toggleSats').checked;
  const labelClr = Cesium.Color.fromCssColorString('#ce93d8');
  const now      = new Date();

  for (let b = 0; b < _satrecs.length; b += 100) {
    for (const { id, name, satrec } of _satrecs.slice(b, b + 100)) {
      const prop = new Cesium.SampledPositionProperty();
      prop.setInterpolationOptions({
        interpolationDegree:    5,
        interpolationAlgorithm: Cesium.LagrangePolynomialApproximation,
      });
      _addSatSamples(prop, satrec, now, SAT_AHEAD_S);

      const entity = viewer.entities.add({
        id:       String(id),
        position: prop,
        show:     visible,
        billboard: {
          image:  SAT_ICON,
          scale:  0.8,
          disableDepthTestDistance: 5_000_000,
        },
        label: {
          text:             name,
          font:             '11px sans-serif',
          fillColor:        labelClr,
          outlineColor:     Cesium.Color.BLACK,
          outlineWidth:     2,
          style:            Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset:      new Cesium.Cartesian2(0, -18),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 50_000_000),
        },
        properties: { id: String(id), name, _satrec: satrec },
      });
      _satEntityMap.set(String(id), entity);
    }
    await new Promise(r => setTimeout(r, 0));  // yield to browser between batches
  }
  document.getElementById('satCount').textContent = _satEntityMap.size;
}

/** Extend sample window so satellites stay smooth as wall-clock time advances. */
async function _extendSatSamples() {
  if (!liveMode) return;
  const from = new Date(Date.now() + SAT_AHEAD_S * 500);  // half-way into current window
  for (let b = 0; b < _satrecs.length; b += 100) {
    for (const { id, satrec } of _satrecs.slice(b, b + 100)) {
      const entity = _satEntityMap.get(String(id));
      if (entity?.position instanceof Cesium.SampledPositionProperty)
        _addSatSamples(entity.position, satrec, from, SAT_AHEAD_S);
    }
    await new Promise(r => setTimeout(r, 0));
  }
}
setInterval(_extendSatSamples, SAT_AHEAD_S * 500);  // refresh before window expires

async function loadSatelliteGroup(group) {
  document.getElementById('satCount').textContent = '…';
  try {
    console.log('[satellites] satellite.js available:', typeof satellite !== 'undefined');
    const tles = await fetchTLEs(group);
    console.log(`[satellites] TLEs received from backend: ${tles.length}`);
    _satrecs = tles.map(t => {
      try {
        return { id: String(t.id), name: t.name, satrec: satellite.twoline2satrec(t.tle1, t.tle2) };
      } catch { return null; }
    }).filter(Boolean);
    console.log(`[satellites] parsed ${_satrecs.length} satrecs for group '${group}'`);
    await _buildSatEntities();
  } catch (err) {
    console.error('[satellites]', err);
    document.getElementById('satCount').textContent = 'err';
  }
}

/**
 * In replay mode: compute satellite positions at a specific timestamp.
 * Live mode is handled automatically by SampledPositionProperty.
 */
function updateSatellitePositions() {
  if (!document.getElementById('toggleSats').checked) return;
  if (liveMode) return;  // live positions animate via SampledPositionProperty

  const replayDate = new Date(replayTs * 1000);
  for (const { id, satrec } of _satrecs) {
    const entity = _satEntityMap.get(String(id));
    if (!entity) continue;
    const pos = _satPos(satrec, replayDate);
    if (pos) entity.position = new Cesium.ConstantPositionProperty(pos);
  }
  document.getElementById('satCount').textContent = _satEntityMap.size;
}

// Satellite visibility toggle.
document.getElementById('toggleSats').addEventListener('change', e => {
  _satEntityMap.forEach(entity => { entity.show = e.target.checked; });
  if (!e.target.checked) document.getElementById('satCount').textContent = '—';
  else document.getElementById('satCount').textContent = _satEntityMap.size;
});

// Group selector — rebuild entities for the new group.
document.getElementById('satGroup').addEventListener('change', e => {
  _satEntityMap.forEach(entity => viewer.entities.remove(entity));
  _satEntityMap.clear();
  loadSatelliteGroup(e.target.value);
});

// Initial load.
loadSatelliteGroup('visual');

// ─── Borders (GroundPolylinePrimitive — correctly draped on terrain) ──────────
// GeoJsonDataSource polygon outlines are incompatible with terrain clamping in
// Cesium (they are silently disabled). Instead we fetch the boundary LINE files
// from Natural Earth and create GroundPolylinePrimitive instances directly.

let _borderPrimitives = [];

/**
 * Fetch a GeoJSON URL and add every line/ring as a GroundPolylinePrimitive.
 * Handles LineString, MultiLineString, Polygon, and MultiPolygon geometries.
 */
async function _loadAsGroundLines(url, color, width) {
  const resp = await fetch(url);
  const gj   = await resp.json();
  const out   = [];

  function addLine(coords) {
    if (coords.length < 2) return;
    const positions = Cesium.Cartesian3.fromDegreesArray(
      coords.flatMap(([lon, lat]) => [lon, lat])
    );
    out.push(viewer.scene.groundPrimitives.add(
      new Cesium.GroundPolylinePrimitive({
        geometryInstances: new Cesium.GeometryInstance({
          geometry: new Cesium.GroundPolylineGeometry({ positions, width }),
          attributes: { color: Cesium.ColorGeometryInstanceAttribute.fromColor(color) },
        }),
        appearance: new Cesium.PolylineColorAppearance(),
      })
    ));
  }

  for (const feat of gj.features) {
    const g = feat.geometry;
    if (!g) continue;
    if      (g.type === 'LineString')      addLine(g.coordinates);
    else if (g.type === 'MultiLineString') g.coordinates.forEach(addLine);
    else if (g.type === 'Polygon')         g.coordinates.forEach(addLine);
    else if (g.type === 'MultiPolygon')    g.coordinates.forEach(p => p.forEach(addLine));
  }
  return out;
}

async function loadBoundaries() {
  if (_borderPrimitives.length > 0) return;
  const base = 'https://d2ad6b4ur7yvpq.cloudfront.net/naturalearth-3.3.0';
  const [cr, sr] = await Promise.allSettled([
    _loadAsGroundLines(`${base}/ne_50m_admin_0_boundary_lines_land.geojson`,
      Cesium.Color.WHITE.withAlpha(0.9), 2.0),
    _loadAsGroundLines(`${base}/ne_50m_admin_1_states_provinces_lines.geojson`,
      Cesium.Color.WHITE.withAlpha(0.65), 1.2),
  ]);
  if (cr.status === 'fulfilled') _borderPrimitives.push(...cr.value);
  else console.error('[borders countries]', cr.reason);
  if (sr.status === 'fulfilled') _borderPrimitives.push(...sr.value);
  else console.error('[borders states]', sr.reason);
  console.log(`[borders] loaded ${_borderPrimitives.length} segments`);
}

document.getElementById('toggleBorders').addEventListener('change', async e => {
  if (e.target.checked) {
    if (_borderPrimitives.length === 0) await loadBoundaries();
    _borderPrimitives.forEach(p => { p.show = true; });
  } else {
    _borderPrimitives.forEach(p => { p.show = false; });
  }
});

document.getElementById('toggleRoads').addEventListener('change', e => {
  _roadsLayer.show = e.target.checked;
});

// ─── Airport layer ────────────────────────────────────────────────────────────

/** Fetch all airports once and populate the layer. Called once at startup. */
async function loadAirports() {
  try {
    const airports = await fetchAirports();
    airportLayer.update(airports);
    console.log(`[airports] loaded ${airports.length} airports`);
  } catch (err) {
    console.error('[airports]', err);
  }
}

document.getElementById('toggleAirports').addEventListener('change', e => {
  airportLayer.setVisible(e.target.checked);
});

// ─── Bounding box ─────────────────────────────────────────────────────────────

/**
 * Compute a lat/lon bounding box from the current Cesium camera view.
 * Returns null if the camera is too high or looking above the horizon.
 *
 * @returns {{ lamin, lomin, lamax, lomax } | null}
 */
function computeBbox() {
  if (viewer.camera.positionCartographic.height > MAX_FETCH_ALTITUDE_M) return null;

  const rect = viewer.camera.computeViewRectangle();
  if (!rect) return null;

  const d = Cesium.Math.toDegrees;
  return {
    lamin: d(rect.south),
    lomin: d(rect.west),
    lamax: d(rect.north),
    lomax: d(rect.east),
  };
}

// ─── Status bar ───────────────────────────────────────────────────────────────

const elIndicator  = document.getElementById('fetchIndicator');
const elStatusText = document.getElementById('statusText');
const elPlaneCount = document.getElementById('planeCount');
const elShipCount  = document.getElementById('shipCount');
const elLastUpdate = document.getElementById('lastUpdate');

function setStatus(state, message) {
  // state: 'idle' | 'fetching' | 'error'
  elIndicator.className = state === 'fetching' ? 'fetching' : state === 'error' ? 'error' : '';
  elStatusText.textContent = message;
}

function updateCounts() {
  elPlaneCount.textContent = planeLayer.count;
  elShipCount.textContent  = shipLayer.count;
  elLastUpdate.textContent = new Date().toLocaleTimeString();
}

// ─── Poll loop ────────────────────────────────────────────────────────────────

/**
 * Fetch fresh data for all visible layers in parallel.
 * Promise.allSettled ensures a failure in one layer does not suppress the other.
 */
async function pollAll() {
  const bbox = computeBbox();
  if (!bbox) {
    setStatus('idle', 'Zoom in to load data');
    return;
  }

  setStatus('fetching', 'Fetching…');

  const showPlanes = document.getElementById('togglePlanes').checked;
  const showShips  = document.getElementById('toggleShips').checked;

  const [planeResult, shipResult] = await Promise.allSettled([
    showPlanes ? fetchPlanes(bbox) : Promise.resolve({ planes: [], count: 0 }),
    showShips  ? fetchShips(bbox)  : Promise.resolve({ ships:  [], count: 0 }),
  ]);

  let hasError = false;

  if (planeResult.status === 'fulfilled') {
    planeLayer.update(planeResult.value.planes);
  } else {
    console.error('[planes]', planeResult.reason?.message);
    hasError = true;
  }

  if (shipResult.status === 'fulfilled') {
    shipLayer.update(shipResult.value.ships);
  } else {
    console.error('[ships]', shipResult.reason?.message);
    hasError = true;
  }

  updateCounts();
  setStatus(hasError ? 'error' : 'idle', hasError ? 'Partial data — see console' : 'Live');
}

// ─── Track rendering ─────────────────────────────────────────────────────────

const TRACK_COLORS = {
  plane:     Cesium.Color.fromCssColorString('#4fc3f7').withAlpha(0.85),
  ship:      Cesium.Color.fromCssColorString('#aed581').withAlpha(0.85),
  satellite: Cesium.Color.fromCssColorString('#ce93d8').withAlpha(0.85),
};

const TRACK_ENTITY_ID = '__active_track__';

/** Remove any currently displayed track polyline. */
function clearTrack() {
  const existing = viewer.entities.getById(TRACK_ENTITY_ID);
  if (existing) viewer.entities.remove(existing);
}

/**
 * Draw a polyline track from an array of {lat, lon, altitude} points.
 * @param {Array<{lat,lon,altitude}>} points  sorted oldest → newest
 * @param {'plane'|'ship'|'satellite'} type
 */
function drawTrack(points, type) {
  clearAllTracks();
  if (points.length < 2) return;

  // Build flat [lon, lat, alt, lon, lat, alt …] array for Cesium.
  const coords = [];
  for (const p of points) {
    coords.push(p.lon, p.lat, p.altitude ?? 0);
  }

  const color = TRACK_COLORS[type] || Cesium.Color.WHITE.withAlpha(0.7);

  viewer.entities.add({
    id: TRACK_ENTITY_ID,
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArrayHeights(coords),
      width: 2,
      material: new Cesium.PolylineGlowMaterialProperty({
        color,
        glowPower: 0.15,
      }),
      clampToGround: type === 'ship',  // ships sit on the surface
    },
  });
}

/**
 * Fetch and draw the historical track for a plane or ship.
 * Uses replayTs when in replay mode, otherwise the last 12 hours.
 */
async function showEntityTrack(type, id) {
  const endTs = liveMode ? null : replayTs;
  const { points } = await fetchTrack(type, id, 12, endTs).catch(() => ({ points: [] }));

  // For planes, only show the current flight by trimming at any gap > 30 min.
  // The same icao24 may have flown multiple routes in the 12-hour window.
  let track = points;
  if (type === 'plane' && points.length > 1) {
    const GAP_S = 30 * 60;
    let segStart = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].ts - points[i - 1].ts > GAP_S) segStart = i;
    }
    track = points.slice(segStart);
  }

  drawTrack(track, type);
}

// Tracks which satellite entity currently has entity.path enabled.
let _satTrackEntity = null;

/**
 * Show a satellite track using entity.path — it stays connected to the moving
 * entity because Cesium drives it from the same SampledPositionProperty.
 *
 * In live mode: backfill 3 hours of historical SGP4 samples into the entity's
 * SampledPositionProperty so entity.path has data to draw, then enable it with
 * trailTime = 3 h.  The track automatically follows the entity every frame.
 *
 * In replay mode: fall back to a static polyline (entity is ConstantPosition).
 *
 * @param {string} satId   NORAD ID string (key in _satEntityMap)
 * @param {object} satrec  satellite.js satrec object
 */
function showSatelliteTrack(satId, satrec) {
  clearAllTracks();

  if (liveMode) {
    const entity = _satEntityMap.get(satId);
    if (!entity || !(entity.position instanceof Cesium.SampledPositionProperty)) return;

    // Backfill 3 hours of historical samples (30 s steps = 360 samples).
    const TRAIL_S = 3 * 60 * 60;
    _addSatSamples(entity.position, satrec, new Date(Date.now() - TRAIL_S * 1000), TRAIL_S);

    entity.path = new Cesium.PathGraphics({
      trailTime: TRAIL_S,
      leadTime:  0,
      width:     1.5,
      material:  new Cesium.PolylineGlowMaterialProperty({
        color:      TRACK_COLORS.satellite,
        glowPower:  0.15,
      }),
      resolution: 60,
    });
    _satTrackEntity = entity;
    return;
  }

  // ── Replay mode: static polyline (entity has ConstantPositionProperty) ──────
  const endMs   = replayTs * 1000;
  const startMs = endMs - 3 * 60 * 60 * 1000;
  const stepMs  = 2 * 60 * 1000;

  const points = [];
  for (let t = startMs; t <= endMs; t += stepMs) {
    try {
      const date = new Date(t);
      const pv   = satellite.propagate(satrec, date);
      if (!pv || !pv.position) continue;
      const gmst = satellite.gstime(date);
      const geo  = satellite.eciToGeodetic(pv.position, gmst);
      points.push({
        lat:      satellite.degreesLat(geo.latitude),
        lon:      satellite.degreesLong(geo.longitude),
        altitude: geo.height * 1000,
      });
    } catch (_) {}
  }

  const segments = [];
  let current = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0 && Math.abs(points[i].lon - points[i - 1].lon) > 180) {
      if (current.length > 1) segments.push(current);
      current = [];
    }
    current.push(points[i]);
  }
  if (current.length > 1) segments.push(current);

  segments.forEach((seg, idx) => {
    const coords = seg.flatMap(p => [p.lon, p.lat, p.altitude]);
    viewer.entities.add({
      id: idx === 0 ? TRACK_ENTITY_ID : `${TRACK_ENTITY_ID}_${idx}`,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights(coords),
        width: 1.5,
        material: new Cesium.PolylineGlowMaterialProperty({
          color: TRACK_COLORS.satellite,
          glowPower: 0.15,
        }),
      },
    });
  });
}

/** Remove all track segments (including multi-segment satellite tracks). */
function clearAllTracks() {
  // Remove the primary track entity and any satellite antimeridian segments.
  const toRemove = viewer.entities.values.filter(
    e => e.id && e.id.startsWith(TRACK_ENTITY_ID)
  );
  toRemove.forEach(e => viewer.entities.remove(e));

  // Disable entity.path on the previously-tracked satellite (live mode).
  if (_satTrackEntity) {
    _satTrackEntity.path = undefined;
    _satTrackEntity = null;
  }
}

// ─── Info modal (planes + ships) ─────────────────────────────────────────────

const modal      = document.getElementById('infoModal');
const modalPhoto = document.getElementById('modalPhoto');
const modalPhotoPlaceholder = document.getElementById('modalPhotoPlaceholder');
const _controls  = document.getElementById('controls');

/** Position the modal just below the controls panel. */
function _positionModal() {
  const rect = _controls.getBoundingClientRect();
  const top = Math.round(rect.bottom + 8);
  document.documentElement.style.setProperty('--modal-top', top + 'px');
}
window.addEventListener('resize', () => { if (modal.classList.contains('visible')) _positionModal(); });

function fmt(val, unit) {
  return val != null ? `${Math.round(val).toLocaleString()} ${unit}` : 'Unknown';
}

function _setPhoto(thumbUrl, placeholderEmoji) {
  modalPhoto.classList.remove('loaded');
  modalPhotoPlaceholder.textContent = placeholderEmoji;
  modalPhotoPlaceholder.classList.remove('hidden');

  if (!thumbUrl) return;

  modalPhoto.onload = () => {
    modalPhoto.classList.add('loaded');
    modalPhotoPlaceholder.classList.add('hidden');
  };
  modalPhoto.onerror = () => {
    // No photo available — keep the placeholder emoji.
    modalPhoto.classList.remove('loaded');
  };
  modalPhoto.src = thumbUrl;
}

function _airportTypeLabel(type) {
  if (type === 'large_airport')  return 'Large Airport';
  if (type === 'medium_airport') return 'Medium Airport';
  if (type === 'small_airport')  return 'Small Airport';
  return 'Airport';
}

function openAirportModal(airport) {
  modal.classList.remove('ship-mode');
  modal.classList.add('airport-mode');
  document.getElementById('modalTitle').textContent     = airport.iata;
  document.getElementById('modalSubtitle').textContent  = airport.name || '';
  document.getElementById('modalTypeBadge').textContent = _airportTypeLabel(airport.type);
  document.getElementById('modalRoute').classList.add('hidden');
  document.getElementById('statLabel1').textContent = 'City';
  document.getElementById('statLabel2').textContent = 'Country';
  document.getElementById('statLabel3').textContent = 'Elevation';
  document.getElementById('statLabel4').textContent = 'Coordinates';
  document.getElementById('modalStat1').textContent = airport.city    || '—';
  document.getElementById('modalStat2').textContent = airport.country || '—';
  document.getElementById('modalStat3').textContent = airport.elevation_ft != null
    ? `${airport.elevation_ft.toLocaleString()} ft` : '—';
  document.getElementById('modalStat4').textContent = airport.lat != null
    ? `${airport.lat.toFixed(2)}°, ${airport.lon.toFixed(2)}°` : '—';
  document.getElementById('modalFooter').textContent = '';
  modalPhoto.classList.remove('loaded');
  modalPhotoPlaceholder.classList.add('hidden');
  _selectEntity(airport.iata);
  _positionModal();
  modal.classList.add('visible');
  clearAllTracks();
}

function openPlaneModal(plane) {
  modal.classList.remove('ship-mode', 'airport-mode');
  document.getElementById('modalTitle').textContent    = plane.callsign || plane.id;
  document.getElementById('modalSubtitle').textContent = 'Loading route…';
  document.getElementById('modalTypeBadge').textContent = '';
  document.getElementById('modalRoute').classList.remove('hidden');
  document.getElementById('modalOriginIata').textContent = '—';
  document.getElementById('modalOriginCity').textContent = '—';
  document.getElementById('modalDestIata').textContent   = '—';
  document.getElementById('modalDestCity').textContent   = '—';
  document.getElementById('statLabel1').textContent = 'Altitude';
  document.getElementById('statLabel2').textContent = 'Speed';
  document.getElementById('statLabel3').textContent = 'Heading';
  document.getElementById('statLabel4').textContent = 'Aircraft';
  document.getElementById('modalStat1').textContent = fmt(plane.altitude, 'm');
  document.getElementById('modalStat2').textContent = fmt(plane.velocity, 'm/s');
  document.getElementById('modalStat3').textContent = plane.heading != null ? `${Math.round(plane.heading)}°` : 'Unknown';
  document.getElementById('modalStat4').textContent = '…';
  document.getElementById('modalFooter').textContent = `ICAO: ${plane.id || '—'}`;
  _setPhoto(null, '✈');
  _selectEntity(plane.id);
  _positionModal();
  modal.classList.add('visible');
  showEntityTrack('plane', plane.id);

  if (!plane.callsign) {
    document.getElementById('modalSubtitle').textContent = 'No callsign';
    return;
  }

  fetchFlightInfo(plane.callsign, plane.id).then(info => {
    if (!modal.classList.contains('visible')) return;

    document.getElementById('modalSubtitle').textContent =
      info.airline ? `${info.airline}${info.iata ? '  ·  ' + info.iata : ''}` : 'Airline unknown';

    document.getElementById('modalOriginIata').textContent = info.origin_iata || '—';
    document.getElementById('modalOriginCity').textContent =
      info.origin ? info.origin.split(' · ')[0] : 'Unknown';
    document.getElementById('modalDestIata').textContent = info.dest_iata || '—';
    document.getElementById('modalDestCity').textContent =
      info.destination ? info.destination.split(' · ')[0] : 'Unknown';

    document.getElementById('modalStat4').textContent = info.aircraft || 'Unknown';
    if (info.registration) {
      document.getElementById('modalFooter').textContent =
        `ICAO: ${plane.id || '—'}  ·  Reg: ${info.registration}`;
    }
    document.getElementById('modalTypeBadge').textContent = '';

    // Swap the globe icon to match the actual aircraft type.
    const typeIcon = _aircraftIcon(info.icao_type);
    if (typeIcon) {
      const ent = viewer.entities.getById(String(plane.id));
      if (ent?.billboard) ent.billboard.image = new Cesium.ConstantProperty(typeIcon);
    }
    if (info.photo_thumb) {
      _setPhoto(info.photo_thumb, '✈');
    }
  }).catch(() => {
    document.getElementById('modalSubtitle').textContent = 'Route data unavailable';
    document.getElementById('modalStat4').textContent = '—';
  });
}

function openShipModal(ship) {
  modal.classList.remove('airport-mode');
  modal.classList.add('ship-mode');
  document.getElementById('modalTitle').textContent    = ship.name || ship.mmsi;
  document.getElementById('modalSubtitle').textContent = 'Loading vessel info…';
  document.getElementById('modalTypeBadge').textContent = '';
  document.getElementById('modalRoute').classList.add('hidden');
  document.getElementById('statLabel1').textContent = 'Speed';
  document.getElementById('statLabel2').textContent = 'Course';
  document.getElementById('statLabel3').textContent = 'Latitude';
  document.getElementById('statLabel4').textContent = 'MMSI';
  document.getElementById('modalStat1').textContent = ship.speed != null ? `${ship.speed.toFixed(1)} kn` : 'Unknown';
  document.getElementById('modalStat2').textContent = ship.course != null ? `${Math.round(ship.course)}°` : 'Unknown';
  document.getElementById('modalStat3').textContent = ship.lat != null ? ship.lat.toFixed(4) : '—';
  document.getElementById('modalStat4').textContent = ship.mmsi || '—';
  document.getElementById('modalFooter').textContent = '';
  _setPhoto(null, '⚓');
  _selectEntity(ship.mmsi);
  _positionModal();
  modal.classList.add('visible');
  showEntityTrack('ship', ship.mmsi);

  fetchShipInfo(ship.mmsi, ship.type).then(info => {
    if (!modal.classList.contains('visible')) return;

    document.getElementById('modalSubtitle').textContent =
      info.type_label && info.type_label !== 'Unknown' ? info.type_label : 'Vessel';

    if (info.type_label) {
      document.getElementById('modalTypeBadge').textContent = info.type_label;
    }
    if (info.photo_thumb) {
      _setPhoto(info.photo_thumb, '⚓');
    }
  }).catch(() => {
    document.getElementById('modalSubtitle').textContent = 'Vessel';
  });
}

document.getElementById('modalClose').addEventListener('click', () => {
  modal.classList.remove('visible', 'ship-mode', 'airport-mode');
  modalPhoto.src = '';
  clearAllTracks();
  _clearSelection();
});

// Click handler — fires when the user clicks any entity on the globe.
viewer.screenSpaceEventHandler.setInputAction((click) => {
  const picked = viewer.scene.pick(click.position);
  if (!Cesium.defined(picked) || !Cesium.defined(picked.id)) {
    // Clicked on empty space — dismiss the modal.
    modal.classList.remove('visible', 'ship-mode', 'airport-mode');
    modalPhoto.src = '';
    clearAllTracks();
    _clearSelection();
    return;
  }

  const props = picked.id?.properties?.getValue(Cesium.JulianDate.now());
  if (!props) return;

  if (props.mmsi !== undefined) {
    openShipModal(props);
  } else if (props.iata !== undefined) {
    openAirportModal(props);
  } else if (_satEntityMap.has(String(props.id))) {
    // Satellite entity — read live position from the entity's position property.
    const satrec  = props._satrec;
    const satEnt  = _satEntityMap.get(String(props.id));
    let lat = null, lon = null, altKm = null;
    const cesiumPos = satEnt?.position?.getValue(viewer.clock.currentTime);
    if (cesiumPos) {
      const carto = Cesium.Cartographic.fromCartesian(cesiumPos);
      lat   = Cesium.Math.toDegrees(carto.latitude);
      lon   = Cesium.Math.toDegrees(carto.longitude);
      altKm = carto.height / 1000;
    }
    modal.classList.remove('ship-mode', 'airport-mode');
    _positionModal();
    modal.classList.add('visible');
    document.getElementById('modalTitle').textContent     = props.name || props.id;
    document.getElementById('modalSubtitle').textContent  = 'Satellite';
    document.getElementById('modalTypeBadge').textContent = 'Satellite';
    document.getElementById('modalRoute').classList.add('hidden');
    document.getElementById('statLabel1').textContent = 'Altitude';
    document.getElementById('statLabel2').textContent = 'Latitude';
    document.getElementById('statLabel3').textContent = 'Longitude';
    document.getElementById('statLabel4').textContent = 'NORAD ID';
    document.getElementById('modalStat1').textContent = altKm != null ? `${Math.round(altKm)} km` : '—';
    document.getElementById('modalStat2').textContent = lat   != null ? lat.toFixed(2) + '°' : '—';
    document.getElementById('modalStat3').textContent = lon   != null ? lon.toFixed(2) + '°' : '—';
    document.getElementById('modalStat4').textContent = props.id || '—';
    document.getElementById('modalFooter').textContent = '';
    _setPhoto(null, '🛰');
    _selectEntity(props.id);
    if (satrec) showSatelliteTrack(String(props.id), satrec);
  } else if (props.id !== undefined) {
    openPlaneModal(props);
  }
}, Cesium.ScreenSpaceEventType.LEFT_CLICK);

// ─── Timeline / replay ───────────────────────────────────────────────────────

const slider          = document.getElementById('timeSlider');
const liveBtnEl       = document.getElementById('liveBtn');
const replayTimeDisp  = document.getElementById('replayTimeDisplay');

let liveMode   = true;
let replayTs   = null;   // Unix timestamp currently shown in replay mode
let pollHandle = null;   // setInterval handle for live polling

/** Format a Unix timestamp as a short local datetime string. */
function fmtTs(ts) {
  return new Date(ts * 1000).toLocaleString([], {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

/** Switch to live mode — resume polling and reset UI. */
function goLive() {
  const wasReplay = !liveMode;
  liveMode = true;
  replayTs = null;
  // Rebuild satellite entities with SampledPositionProperty for smooth animation.
  if (wasReplay) {
    viewer.clock.clockStep     = Cesium.ClockStep.SYSTEM_CLOCK;
    viewer.clock.shouldAnimate = true;
    _buildSatEntities();
  }
  liveBtnEl.textContent = '● Live';
  liveBtnEl.classList.remove('replay-mode');
  replayTimeDisp.classList.remove('replay-mode');
  slider.value = slider.max;
  replayTimeDisp.textContent = slider.max > 0 ? fmtTs(Number(slider.max)) : 'No history yet';
  if (!pollHandle) pollHandle = setInterval(pollAll, POLL_INTERVAL_MS);
  pollAll();
}

/** Switch to replay mode at the given Unix timestamp. */
function goReplay(ts) {
  liveMode = false;
  replayTs = ts;
  liveBtnEl.textContent = '⏸ Replay';
  liveBtnEl.classList.add('replay-mode');
  replayTimeDisp.classList.add('replay-mode');
  replayTimeDisp.textContent = fmtTs(ts);
  // Pause live polling.
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  fetchReplay(ts);
}

/** Fetch historical data for the given timestamp and update entities. */
async function fetchReplay(ts) {
  const bbox = computeBbox();
  if (!bbox) { setStatus('idle', 'Zoom in to load data'); return; }

  setStatus('fetching', `Loading ${fmtTs(ts)}…`);

  const showPlanes = document.getElementById('togglePlanes').checked;
  const showShips  = document.getElementById('toggleShips').checked;

  const [pr, sr] = await Promise.allSettled([
    showPlanes ? fetchHistoryPlanes(ts, bbox) : Promise.resolve({ planes: [], count: 0 }),
    showShips  ? fetchHistoryShips(ts, bbox)  : Promise.resolve({ ships:  [], count: 0 }),
  ]);

  if (pr.status === 'fulfilled') planeLayer.update(pr.value.planes);
  if (sr.status === 'fulfilled') shipLayer.update(sr.value.ships);
  updateSatellitePositions();

  updateCounts();
  setStatus('idle', `Replay: ${fmtTs(ts)}`);
}

// Satellite positions update instantly on drag (pure math).
// DB fetch for planes/ships is debounced to 150ms after the last move.
let _sliderDebounce = null;
slider.addEventListener('input', () => {
  const ts = Number(slider.value);
  replayTimeDisp.textContent = fmtTs(ts);
  if (liveMode) {
    liveMode = false;
    replayTs = ts;
    liveBtnEl.textContent = '⏸ Replay';
    liveBtnEl.classList.add('replay-mode');
    replayTimeDisp.classList.add('replay-mode');
    if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
  } else {
    replayTs = ts;
  }
  // Satellites move continuously — update their position on every slider tick.
  updateSatellitePositions();
  clearTimeout(_sliderDebounce);
  _sliderDebounce = setTimeout(() => goReplay(ts), 150);
});

liveBtnEl.addEventListener('click', goLive);

/** Poll /api/history/range every 10s to keep the slider max current. */
async function refreshTimeRange() {
  const { min_ts, max_ts } = await fetchHistoryRange().catch(() => ({}));
  if (!min_ts || !max_ts) return;

  slider.min      = Math.floor(min_ts);
  slider.max      = Math.floor(max_ts);
  slider.disabled = false;

  if (liveMode) {
    slider.value = slider.max;
    replayTimeDisp.textContent = fmtTs(Number(slider.max));
  }
}

setInterval(refreshTimeRange, 10_000);
refreshTimeRange();  // run once immediately

// ─── Checkbox wiring ──────────────────────────────────────────────────────────

document.getElementById('togglePlanes').addEventListener('change', (e) => {
  planeLayer.setVisible(e.target.checked);
  if (e.target.checked) pollAll();
});

document.getElementById('toggleShips').addEventListener('change', (e) => {
  shipLayer.setVisible(e.target.checked);
  if (e.target.checked) pollAll();
});

// ─── Start ────────────────────────────────────────────────────────────────────

loadBoundaries();
loadAirports();
pollAll();
pollHandle = setInterval(pollAll, POLL_INTERVAL_MS);

// Future extension hook — history/replay:
//   Replace setInterval above with a timeline scrubber that calls
//   GET /api/history?domain=planes&ts=<unix> (backed by the SQLite hook in cache.py).
//   EntityLayer.update() works identically for live and replayed data.
