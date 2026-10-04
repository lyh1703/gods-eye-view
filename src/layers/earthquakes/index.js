import * as Cesium from 'cesium';
import {
  EARTHQUAKE_OVERLAY_SOURCE_ID,
  EARTHQUAKE_OVERLAY_COHORT_LIMIT,
  EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
  depthColor,
  createEarthquakeOverlayEntry,
  selectEarthquakeOverlayCohort,
  mapAnalystRecord,
} from './model.js';
export * from './model.js';
export { createUsgsEarthquakeSource } from './source.js';
export { createWorldMemoryEarthquakeSource } from './worldMemorySource.js';

// Presentation is distinct from the provenance: cached observations are not
// fresh measurements merely because their original provider was official.
function presentationClass(evidence, refreshFailed = false) {
  if (refreshFailed || evidence?.stale) return 'STALE_REFERENCE';
  return evidence ? 'PERSISTED_OBSERVATION' : 'DIRECT_OBSERVATION';
}

function presentationLabel(classification) {
  if (classification === 'STALE_REFERENCE') return 'STALE REF';
  if (classification === 'PERSISTED_OBSERVATION') return 'PERSISTED OBS';
  return 'DIRECT OBS';
}

/** Own one earthquake display and its refresh lifecycle. */
export function createEarthquakesLayer({ source, overlayHost } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Earthquakes require a snapshot source');
  if (!overlayHost) throw new TypeError('Earthquakes require an overlay host');
  let _viewer = null;
  let _request = null;
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _lastOverlayEntries = [];
  let _enabled = false;

  const layer = {
    id: 'earthquakes',
    name:
      typeof source.getEvidenceStatus === 'function'
        ? 'Stored USGS Earthquakes'
        : 'Earthquakes (24h)',
    icon: '🌋',
    source: 'USGS',
    updateInterval: 60000,

    init(viewer) {
      if (_viewer) throw new Error('Earthquake layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('earthquakes');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastOverlayEntries = [];
      _enabled = false;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      console.log('[Data:Earthquakes] Initialized');
    },

    enable(viewer) {
      _enabled = true;
      // No continuous-render hold: the discs are static geometry now, so the
      // layer has no per-frame animator to keep the render loop alive for.
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, true);
    },

    disable(viewer) {
      _request?.abort();
      _request = null;
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
    },

    async update(viewer) {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const rows = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;

        const nextEntities = [];
        let count = 0;
        const overlayEntries = [];

        for (const {
          stableId,
          usgsId,
          lon,
          lat,
          depthKm,
          mag,
          place,
          time,
          evidence = null,
        } of rows) {
          count++;
          const presentation = presentationClass(evidence);
          const baseRadius = Math.pow(2, mag) * 1000;
          const color = depthColor(depthKm || 0);
          const isSignificant = mag >= 5.0;
          const fillAlpha = isSignificant ? 0.4 : 0.3;
          const outlineAlpha = isSignificant ? 1.0 : 0.8;

          const position = Cesium.Cartesian3.fromDegrees(lon, lat);
          nextEntities.push(
            new Cesium.Entity({
              id: `earthquake:${stableId}`,
              position,
              ellipse: {
                // Static axes — see the module header. A CallbackProperty here
                // re-tessellates the clamped ground geometry every frame.
                semiMajorAxis: baseRadius,
                semiMinorAxis: baseRadius,
                material: new Cesium.ColorMaterialProperty(
                  color.withAlpha(fillAlpha),
                ),
                outline: true,
                outlineColor: color.withAlpha(outlineAlpha),
                outlineWidth: isSignificant ? 3 : 2,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
              },
              properties: {
                // Analyst seam (additive): the USGS event id (e.g. "us7000abcd").
                usgsId,
                mag,
                place,
                time,
                depth: depthKm,
                evidenceKind: 'OBSERVATION',
                evidenceMode: evidence?.source_mode ?? 'DIRECT_USGS_FEED',
                presentationClass: presentation,
                refreshFailedReference: false,
                sourceUrl: evidence?.source_url ?? null,
                timestampObserved: evidence?.timestamp_observed ?? null,
                timestampReceived: evidence?.timestamp_received ?? null,
                analyzedAt: evidence?.analyzed_at ?? null,
                staleEvidence: evidence?.stale ?? null,
                evidence,
              },
            }),
          );
          overlayEntries.push({
            ...createEarthquakeOverlayEntry({
              id: String(stableId),
              position,
              magnitude: mag,
              accent: color.toCssColorString(),
            }),
            title: `M${mag.toFixed(1)} · ${presentationLabel(presentation)}`,
          });
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          _lastOverlayEntries = selectEarthquakeOverlayCohort(overlayEntries);
          overlayHost.setEntries(
            EARTHQUAKE_OVERLAY_SOURCE_ID,
            _lastOverlayEntries,
            {
              cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
              collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = count;
        _lastUpdate = Date.now();
        _lastError = null;
        console.log(
          `[Data:Earthquakes] Updated: ${_count} ${source.getEvidenceStatus ? 'stored observations' : 'events (M2.5+)'}`,
        );
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Earthquakes] Fetch error:', e);
        _lastError = e?.message || 'Earthquake source unavailable';
        // Never leave previously displayed entities labeled as current
        // observations after their source failed to refresh. Keep the last
        // known position and provenance for reference, not a fabricated fact.
        if (_count > 0) {
          for (const entity of _dataSource.entities.values) {
            entity.properties.presentationClass = 'STALE_REFERENCE';
            entity.properties.refreshFailedReference = true;
          }
          _lastOverlayEntries = _lastOverlayEntries.map((entry) => ({
            ...entry,
            title: entry.title.replace(
              / · (?:DIRECT OBS|PERSISTED OBS|STALE REF)$/,
              ' · STALE REF',
            ),
          }));
          overlayHost.setEntries(
            EARTHQUAKE_OVERLAY_SOURCE_ID,
            _lastOverlayEntries,
            {
              cohortLimit: EARTHQUAKE_OVERLAY_COHORT_LIMIT,
              collisionCapacity: EARTHQUAKE_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }
        return false;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;
      _viewer = null;
      _enabled = false;
      overlayHost.clearSource(EARTHQUAKE_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(EARTHQUAKE_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _lastOverlayEntries = [];
    },

    /**
     * Snapshot the layer's in-memory earthquake records as plain JSON-safe
     * objects for the analyst query engine. On-demand only (called at most
     * once per spoken query) — zero per-frame cost, no listeners, no caching.
     * Returns [] while the layer is disabled or empty.
     * @param {number} [maxCount=2000] - Maximum records to return (truncation).
     * @returns {Array<Object>} See mapAnalystRecord for the record shape.
     */
    getAnalystRecords(maxCount = 2000) {
      if (!_dataSource || !_dataSource.show) return [];
      const entities = _dataSource.entities.values;
      if (!entities.length) return [];
      const limit = Number.isFinite(maxCount)
        ? Math.max(1, Math.floor(maxCount))
        : 2000;
      const now = Cesium.JulianDate.now();
      const result = [];
      for (const entity of entities) {
        if (result.length >= limit) break;
        const cartesian = entity.position
          ? entity.position.getValue(now)
          : null;
        const carto = cartesian
          ? Cesium.Cartographic.fromCartesian(cartesian)
          : null;
        const p = entity.properties;
        const analystRecord = mapAnalystRecord(
          {
            id: p?.usgsId?.getValue(now) ?? null,
            mag: p?.mag?.getValue(now),
            place: p?.place?.getValue(now),
            time: p?.time?.getValue(now),
            depth: p?.depth?.getValue(now),
            lat: carto ? Cesium.Math.toDegrees(carto.latitude) : null,
            lon: carto ? Cesium.Math.toDegrees(carto.longitude) : null,
          },
          result.length,
        );
        const evidence = p?.evidence?.getValue(now);
        result.push({
          ...analystRecord,
          presentation_class: p?.presentationClass?.getValue(now) ?? null,
          refresh_failed_reference:
            p?.refreshFailedReference?.getValue(now) ?? false,
          ...(evidence ? { evidence } : {}),
        });
      }
      return result;
    },

    getRowControls() {
      const state = source.getEvidenceStatus?.();
      if (_lastError && _count > 0) {
        return {
          info: `STALE REFERENCE · previous observation retained; latest refresh failed: ${_lastError} · not independently verified`,
        };
      }
      if (!state) {
        return {
          info: 'DIRECT OBSERVATION · USGS public feed; not a World Memory readback or independently verified event',
        };
      }
      return {
        info: `PERSISTED OBSERVATION · ARGUS World Memory · ${state.stale_count} stale reference(s) · upstream run: ${state.provider_state} · analysis: ${state.analyzed_at ?? 'not yet read'} · not independently verified`,
      };
    },

    getStats() {
      const state = source.getEvidenceStatus?.();
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        source:
          _lastError && _count
            ? 'CACHED · STALE REFERENCE'
            : state
              ? 'ARGUS World Memory · PERSISTED OBSERVATION'
              : 'USGS · DIRECT OBSERVATION',
        status: _lastError ? 'degraded' : (state?.status ?? 'nominal'),
        stale: Boolean(_lastError && _count) || (state?.stale_count ?? 0) > 0,
        degraded: Boolean(_lastError) || state?.status === 'degraded',
      };
    },
  };
  return layer;
}
