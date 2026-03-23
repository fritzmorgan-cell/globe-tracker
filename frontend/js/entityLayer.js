/**
 * entityLayer.js — Generic Cesium entity manager for a single data layer.
 *
 * EntityLayer wraps a Cesium.EntityCollection and keeps a Map of currently
 * displayed entities keyed by a string ID. On each data refresh it:
 *   1. Updates position/properties of entities that already exist (in-place, no flicker).
 *   2. Adds new entities for IDs not yet tracked.
 *   3. Removes entities for IDs that disappeared from the latest data batch.
 *
 * The class is intentionally generic — any normalised array with a unique id
 * field and lat/lon coordinates can be rendered. To add a third layer (satellites,
 * weather stations, etc.), instantiate a new EntityLayer with a custom icon and
 * label colour. No changes to this file are needed.
 */

class EntityLayer {
  /**
   * @param {Cesium.Viewer} viewer
   * @param {object} options
   * @param {string}        options.idField          — Property used as unique key (e.g. 'id', 'mmsi')
   * @param {string}        options.labelField       — Property shown as label (e.g. 'callsign', 'name')
   * @param {string}        options.billboardUrl     — Icon URL or data-URI
   * @param {number}        [options.billboardScale] — Icon scale, default 0.9
   * @param {Cesium.Color}  [options.labelColor]     — Label text colour
   */
  constructor(viewer, options = {}) {
    this._viewer = viewer;
    this._idField    = options.idField    || 'id';
    this._labelField = options.labelField || 'id';
    this._billboardUrl    = options.billboardUrl   || '';
    this._billboardScale  = options.billboardScale ?? 0.9;
    this._labelColor      = options.labelColor || Cesium.Color.WHITE;
    // Max camera distance (metres) at which labels are shown.
    // Increase for high-altitude objects like satellites.
    this._labelMaxDistance = options.labelMaxDistance ?? 800_000;
    // When true, billboards render on top of terrain (never hidden underground).
    this._disableDepthTest = options.disableDepthTest ?? false;

    /** @type {Map<string, Cesium.Entity>} */
    this._entities = new Map();
    this._visible  = true;
  }

  /**
   * Replace displayed entities with a fresh data batch.
   * Records with missing lat/lon are silently skipped.
   *
   * @param {Array<object>} dataArray — Normalised records from the API.
   */
  update(dataArray) {
    const seenIds = new Set();

    for (const record of dataArray) {
      if (record.lat == null || record.lon == null) continue;

      const id  = String(record[this._idField]);
      const lat = record.lat;
      const lon = record.lon;
      const alt = record.altitude ?? 0;                         // metres
      const heading = record.heading ?? record.course ?? 0;    // degrees CW from north
      const label   = String(record[this._labelField] || id);

      seenIds.add(id);

      const position = Cesium.Cartesian3.fromDegrees(lon, lat, alt || 0);

      if (this._entities.has(id)) {
        // Update in place — avoids recreating the entity and the associated flicker.
        const entity = this._entities.get(id);
        entity.position = new Cesium.ConstantPositionProperty(position);
        entity.label.text = new Cesium.ConstantProperty(label);
        if (entity.billboard) {
          entity.billboard.rotation = new Cesium.ConstantProperty(
            Cesium.Math.toRadians(-heading)
          );
        }
      } else {
        // New entity.
        const entity = this._viewer.entities.add({
          id,
          position,
          show: this._visible,

          billboard: this._billboardUrl ? {
            image: this._billboardUrl,
            scale: this._billboardScale,
            rotation: Cesium.Math.toRadians(-heading),
            alignedAxis: Cesium.Cartesian3.UNIT_Z,
            verticalOrigin:   Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            sizeInMeters: false,
            disableDepthTestDistance: this._disableDepthTest
              ? Number.POSITIVE_INFINITY : undefined,
          } : undefined,

          label: {
            text: label,
            font: '11px sans-serif',
            fillColor: this._labelColor,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -18),
            // Hide labels when zoomed too far out to reduce clutter.
            distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, this._labelMaxDistance),
          },

          // Store full record for future click/hover handlers.
          properties: record,
        });

        this._entities.set(id, entity);
      }
    }

    // Remove entities that left the bounding box or disappeared from the feed.
    for (const [id, entity] of this._entities) {
      if (!seenIds.has(id)) {
        this._viewer.entities.remove(entity);
        this._entities.delete(id);
      }
    }
  }

  /**
   * Show or hide all entities in this layer.
   * @param {boolean} visible
   */
  setVisible(visible) {
    this._visible = visible;
    for (const entity of this._entities.values()) {
      entity.show = visible;
    }
  }

  /** Remove all entities and clear internal state. */
  clear() {
    for (const entity of this._entities.values()) {
      this._viewer.entities.remove(entity);
    }
    this._entities.clear();
  }

  /** @returns {number} */
  get count() {
    return this._entities.size;
  }
}
