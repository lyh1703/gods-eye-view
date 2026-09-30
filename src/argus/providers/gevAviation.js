import { createObservationEnvelope } from '../observationEnvelope.js';
import { openSkySnapshot } from '../../sources/live/aircraft.js';

export const GEV_OPENSKY_PROVIDER = Object.freeze({
  provider_id: 'gev-opensky-aircraft',
  category: 'aviation',
  geography: 'global with regional adsb.lol fallback',
  auth_mode: 'inherited-gev-proxy',
  cost_class: 'inherited-provider-budget',
  update_frequency: 'near-real-time',
  latency: 'provider-and-cache-dependent',
  coverage: 'OpenSky worldwide snapshot with inherited regional fallback',
  license_class: 'inherited-gev-source-license-review',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy: 'retain normalized observations with source provenance',
  reliability: 'inherited-gev-fail-soft',
  adapter_status: 'argus-mapped-validated',
  source_url: 'https://opensky-network.org/api/states/all',
});

function bboxCenter(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [west, south, east, north] = bbox.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return {
    latitude: (south + north) / 2,
    longitude: (west + east) / 2,
  };
}

function inBbox(record, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return true;
  const [west, south, east, north] = bbox.map(Number);
  return (
    record.longitude >= west &&
    record.longitude <= east &&
    record.latitude >= south &&
    record.latitude <= north
  );
}

function sourceUrl(source) {
  return String(source || '')
    .toLowerCase()
    .includes('adsb')
    ? 'https://api.adsb.lol/v2/'
    : GEV_OPENSKY_PROVIDER.source_url;
}

export function createGevOpenSkyAdapter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('GEV OpenSky adapter requires fetch');
  }

  return Object.freeze({
    metadata: GEV_OPENSKY_PROVIDER,

    async query({ scope, filters = {}, limit = 100, ingestionRunId } = {}) {
      const center = bboxCenter(scope?.bbox);
      const params = new URLSearchParams();
      if (center) {
        params.set('lat', center.latitude.toFixed(4));
        params.set('lon', center.longitude.toFixed(4));
      }
      const url = `/api/opensky${params.size ? `?${params}` : ''}`;
      const response = await fetchImpl(url);
      if (!response?.ok) {
        const error = new Error(
          `GEV OpenSky request failed with HTTP ${response?.status ?? 'unknown'}`,
        );
        error.retryable =
          response?.status === 408 ||
          response?.status === 429 ||
          Number(response?.status) >= 500;
        throw error;
      }

      const payload = await response.json();
      const receivedAt = now();
      const snapshot = openSkySnapshot(payload, {
        source: response.headers?.get?.('x-flight-source') || 'OpenSky Network',
        coverage:
          response.headers?.get?.('x-flight-coverage') ||
          GEV_OPENSKY_PROVIDER.coverage,
        now: receivedAt.getTime(),
        stale:
          String(
            response.headers?.get?.('x-opensky-cache') || '',
          ).toUpperCase() === 'STALE',
      });

      const entityFilter =
        filters.entity_id == null
          ? null
          : String(filters.entity_id).toLowerCase();
      const max = Math.max(0, Math.min(Number(limit) || 100, 2000));

      return snapshot.records
        .filter((record) => !entityFilter || record.id === entityFilter)
        .filter((record) => inBbox(record, scope?.bbox))
        .slice(0, max)
        .map((record) => {
          const observedMs =
            record.positionTimeMs ??
            record.contactTimeMs ??
            snapshot.observedAtMs;
          if (!Number.isFinite(observedMs)) return null;
          return createObservationEnvelope({
            provider_id: GEV_OPENSKY_PROVIDER.provider_id,
            entity_type: 'aircraft',
            entity_id: record.id,
            observation_type: 'aircraft-position',
            timestamp_observed: new Date(observedMs),
            timestamp_received: receivedAt,
            geometry: {
              type: 'Point',
              coordinates: [record.longitude, record.latitude],
            },
            properties: {
              callsign: record.callsign || null,
              origin_country: record.originCountry || null,
              baro_altitude_m: record.baroAltitudeM,
              ellipsoid_altitude_m: record.ellipsoidAltitudeM,
              on_ground: record.onGround,
              speed_mps: record.speedMps,
              course_deg: record.courseDeg,
              vertical_rate_mps: record.verticalRateMps,
              category: record.category,
              source: snapshot.source,
              source_freshness: snapshot.freshness,
              source_age_ms: snapshot.ageMs,
              source_complete: snapshot.complete,
            },
            coverage: snapshot.coverage,
            confidence: snapshot.stale ? 0.75 : 0.95,
            source_url: sourceUrl(snapshot.source),
            license_class: GEV_OPENSKY_PROVIDER.license_class,
            commercial_allowed: GEV_OPENSKY_PROVIDER.commercial_allowed,
            attribution_required: GEV_OPENSKY_PROVIDER.attribution_required,
            retention_policy: GEV_OPENSKY_PROVIDER.retention_policy,
            rate_limit_class: 'inherited-gev-opensky-budget',
            ingestion_run_id:
              ingestionRunId ?? `gev-opensky-${receivedAt.toISOString()}`,
            raw_reference: record.reference,
          });
        })
        .filter(Boolean);
    },
  });
}
