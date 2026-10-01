import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';

import { createObservationEnvelope } from '../observationEnvelope.js';
import { createSatelliteSource } from '../../layers/satellites/source.js';

export const GEV_CELESTRAK_SATELLITES_PROVIDER = Object.freeze({
  provider_id: 'gev-celestrak-satellites',
  category: 'space',
  geography: 'global orbital objects',
  auth_mode: 'credential-free-public-via-inherited-gev-proxy',
  cost_class: 'free-public',
  update_frequency: 'tle-cache-six-hours',
  latency: 'source-and-cache-dependent',
  coverage: 'selected CelesTrak GP/TLE groups',
  license_class: 'celestrak-source-terms',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy: 'retain normalized propagated state and bounded TLE reference metadata',
  reliability: 'inherited-gev-cache-and-stale-fallback',
  adapter_status: 'argus-mapped-public-e2e',
  source_url: 'https://celestrak.org/NORAD/elements/gp.php',
});

const ALLOWED_GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

function providerError(message, { name = 'ProviderError', retryable = false, code = null } = {}) {
  const error = new Error(message);
  error.name = name;
  error.retryable = retryable;
  if (code) error.code = code;
  return error;
}

function parseTle(text) {
  const lines = String(text || '')
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const entries = [];
  for (let index = 0; index < lines.length - 2; index += 3) {
    const name = lines[index];
    const line1 = lines[index + 1];
    const line2 = lines[index + 2];
    if (line1.startsWith('1 ') && line2.startsWith('2 ')) {
      entries.push({ name, line1, line2 });
    }
  }
  return entries;
}

function tleEpochMs(line1) {
  const yearText = String(line1 || '').slice(18, 20);
  const dayText = String(line1 || '').slice(20, 32);
  const shortYear = Number(yearText);
  const dayOfYear = Number(dayText);
  if (!Number.isFinite(shortYear) || !Number.isFinite(dayOfYear) || dayOfYear <= 0) {
    return null;
  }
  const year = shortYear >= 57 ? 1900 + shortYear : 2000 + shortYear;
  return Date.UTC(year, 0, 1) + (dayOfYear - 1) * 86_400_000;
}

function propagateState(satrec, date) {
  try {
    const state = propagate(satrec, date);
    if (!state.position || typeof state.position === 'boolean') return null;
    const geo = eciToGeodetic(state.position, gstime(date));
    const velocity =
      state.velocity && typeof state.velocity !== 'boolean' ? state.velocity : null;
    const speedMps = velocity
      ? Math.hypot(velocity.x, velocity.y, velocity.z) * 1000
      : null;
    return {
      longitude: degreesLong(geo.longitude),
      latitude: degreesLat(geo.latitude),
      altitudeM: geo.height * 1000,
      speedMps: Number.isFinite(speedMps) ? speedMps : null,
    };
  } catch {
    return null;
  }
}

function bboxContains(state, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return true;
  const [west, south, east, north] = bbox.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new TypeError('scope.bbox values must be finite');
  }
  return (
    state.longitude >= west &&
    state.longitude <= east &&
    state.latitude >= south &&
    state.latitude <= north
  );
}

function timeContains(observedMs, time) {
  if (!time) return true;
  const start = time.start == null ? -Infinity : Date.parse(time.start);
  const end = time.end == null ? Infinity : Date.parse(time.end);
  if ((time.start != null && !Number.isFinite(start)) || (time.end != null && !Number.isFinite(end))) {
    throw new TypeError('time range must contain valid timestamps');
  }
  return observedMs >= start && observedMs <= end;
}

export function createGevCelestrakSatellitesAdapter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  maxTextBytes = 8_000_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('GEV CelesTrak adapter requires fetch');
  }
  const source = createSatelliteSource({ fetchImpl });

  return Object.freeze({
    metadata: GEV_CELESTRAK_SATELLITES_PROVIDER,

    async query({ scope, time, filters = {}, limit = 100, ingestionRunId } = {}) {
      if (filters.entity_type != null && filters.entity_type !== 'satellite') return [];
      const group = String(filters.group || 'stations').trim();
      if (!ALLOWED_GROUPS.has(group)) {
        throw providerError('Unsupported CelesTrak group', {
          name: 'TypeError',
          code: 'UNSUPPORTED_QUERY',
        });
      }

      let result;
      try {
        result = await source.readGroup(group);
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw providerError('CelesTrak provider timeout', {
            name: 'TimeoutError',
            retryable: true,
            code: 'TIMEOUT',
          });
        }
        throw providerError('CelesTrak provider unavailable', {
          retryable: true,
          code: 'PROVIDER_UNAVAILABLE',
        });
      }
      if (!result.ok) {
        throw providerError(`CelesTrak provider HTTP ${result.status}`, {
          retryable: result.status === 408 || result.status === 429 || result.status >= 500,
          code: result.status === 429 ? 'RATE_LIMIT' : 'HTTP_FAILURE',
        });
      }

      const text = String(result.text || '');
      if (new TextEncoder().encode(text).byteLength > maxTextBytes) {
        throw providerError('CelesTrak response exceeds bounded text limit', {
          name: 'RangeError',
          code: 'OVERSIZED_RESPONSE',
        });
      }
      const entries = parseTle(text);
      if (entries.length === 0) {
        throw providerError('Malformed CelesTrak TLE payload', {
          name: 'TypeError',
          code: 'MALFORMED_PAYLOAD',
        });
      }

      const receivedAt = now();
      const observedMs = receivedAt.getTime();
      if (!timeContains(observedMs, time)) return [];
      const entityId =
        filters.entity_id == null ? null : String(filters.entity_id).trim();
      const max = Math.max(0, Math.min(Number(limit) || 100, 5000));
      const observations = [];

      for (const entry of entries) {
        const satrec = twoline2satrec(entry.line1, entry.line2);
        if (!satrec || satrec.error !== 0) continue;
        const noradId = String(satrec.satnum || '').trim();
        if (!noradId || (entityId && noradId !== entityId)) continue;
        const state = propagateState(satrec, receivedAt);
        if (!state || !bboxContains(state, scope?.bbox)) continue;
        const epochMs = tleEpochMs(entry.line1);
        const tleAgeSeconds =
          epochMs == null ? null : Math.max(0, (receivedAt.getTime() - epochMs) / 1000);
        const staleTle = tleAgeSeconds == null || tleAgeSeconds > 72 * 3600;

        observations.push(
          createObservationEnvelope({
            provider_id: GEV_CELESTRAK_SATELLITES_PROVIDER.provider_id,
            entity_type: 'satellite',
            entity_id: noradId,
            observation_type: 'satellite-propagated-position',
            timestamp_observed: receivedAt,
            timestamp_received: receivedAt,
            freshness_seconds: tleAgeSeconds ?? 0,
            geometry: {
              type: 'Point',
              coordinates: [state.longitude, state.latitude],
            },
            properties: {
              name: entry.name || null,
              norad_id: noradId,
              group,
              altitude_m: state.altitudeM,
              speed_mps: state.speedMps,
              propagation_model: 'SGP4',
              tle_epoch: epochMs == null ? null : new Date(epochMs).toISOString(),
              tle_age_seconds: tleAgeSeconds,
              tle_stale: staleTle,
            },
            coverage: GEV_CELESTRAK_SATELLITES_PROVIDER.coverage,
            confidence: staleTle ? 0.7 : 0.9,
            source_url: `${GEV_CELESTRAK_SATELLITES_PROVIDER.source_url}?GROUP=${encodeURIComponent(group)}&FORMAT=tle`,
            license_class: GEV_CELESTRAK_SATELLITES_PROVIDER.license_class,
            commercial_allowed: GEV_CELESTRAK_SATELLITES_PROVIDER.commercial_allowed,
            attribution_required:
              GEV_CELESTRAK_SATELLITES_PROVIDER.attribution_required,
            retention_policy: GEV_CELESTRAK_SATELLITES_PROVIDER.retention_policy,
            rate_limit_class: 'celestrak-six-hour-cache-policy',
            ingestion_run_id:
              ingestionRunId ?? `gev-celestrak-${receivedAt.toISOString()}`,
            raw_reference: noradId,
          }),
        );
        if (observations.length >= max) break;
      }

      if (entries.length > 0 && observations.length === 0 && !entityId && !scope?.bbox) {
        throw providerError('CelesTrak payload contained no propagatable satellites', {
          name: 'TypeError',
          code: 'MALFORMED_ORBIT_STATE',
        });
      }
      return observations;
    },
  });
}
