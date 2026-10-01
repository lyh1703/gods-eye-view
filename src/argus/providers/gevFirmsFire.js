import { createObservationEnvelope } from '../observationEnvelope.js';
import { acquisitionMsUtc } from '../../data/firmsCsv.js';
import { normalizeConfidence } from '../../data/firmsAdapt.js';

export const GEV_FIRMS_FIRE_PROVIDER = Object.freeze({
  provider_id: 'gev-nasa-firms-fire',
  category: 'disaster',
  geography: 'global active-fire detections',
  auth_mode: 'server-side-map-key-via-inherited-gev-proxy',
  cost_class: 'free-api-key',
  update_frequency: 'near-real-time-with-gev-cache',
  latency: 'source-and-cache-dependent',
  coverage: 'NASA FIRMS trailing active-fire detections',
  license_class: 'nasa-firms-source-terms',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy: 'retain normalized detections and bounded source evidence',
  reliability: 'inherited-gev-partial-source-and-stale-cache',
  adapter_status: 'argus-query-callable',
  source_url: 'https://firms.modaps.eosdis.nasa.gov/',
});

function providerError(message, { name = 'ProviderError', retryable = false, code = null } = {}) {
  const error = new Error(message);
  error.name = name;
  error.retryable = retryable;
  if (code) error.code = code;
  return error;
}

function bboxContains(record, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return true;
  const [west, south, east, north] = bbox.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new TypeError('scope.bbox values must be finite');
  }
  return record.lon >= west && record.lon <= east && record.lat >= south && record.lat <= north;
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

function finiteNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === '' ||
    typeof value === 'boolean'
  ) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function detectionId(record) {
  const parts = [
    record.satellite || 'unknown-satellite',
    record.instrument || 'unknown-instrument',
    record.acqDate || 'unknown-date',
    String(record.acqTime ?? ''),
    Number(record.lat).toFixed(5),
    Number(record.lon).toFixed(5),
  ];
  return parts.join(':');
}

function sourceName(record) {
  const satellite = String(record.satellite || '').trim();
  const instrument = String(record.instrument || '').trim();
  return [satellite, instrument].filter(Boolean).join('/') || null;
}

export function createGevFirmsFireAdapter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 60_000,
  maxResponseRecords = 500_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('GEV FIRMS adapter requires fetch');
  }

  return Object.freeze({
    metadata: GEV_FIRMS_FIRE_PROVIDER,

    async query({ scope, time, filters = {}, limit = 100, ingestionRunId } = {}) {
      if (filters.entity_type != null && filters.entity_type !== 'fire-detection') {
        return [];
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, Number(timeoutMs) || 60_000));
      let response;
      try {
        response = await fetchImpl('/api/firms', {
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw providerError('FIRMS provider timeout', {
            name: 'TimeoutError',
            retryable: true,
            code: 'TIMEOUT',
          });
        }
        throw providerError('FIRMS provider unavailable', {
          retryable: true,
          code: 'PROVIDER_UNAVAILABLE',
        });
      } finally {
        clearTimeout(timer);
      }

      let payload = null;
      try {
        payload = await response.json();
      } catch {
        throw providerError('Malformed FIRMS provider payload', {
          name: 'TypeError',
          code: 'MALFORMED_PAYLOAD',
        });
      }

      if (!response.ok) {
        if (response.status === 503 && payload?.error === 'no_key') {
          throw providerError('FIRMS_MAP_KEY is required', {
            name: 'ProviderCredentialError',
            code: 'CREDENTIAL_MISSING',
          });
        }
        throw providerError(`FIRMS provider HTTP ${response.status}`, {
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          code: response.status === 429 ? 'RATE_LIMIT' : 'HTTP_FAILURE',
        });
      }
      if (!Array.isArray(payload?.fires)) {
        throw providerError('Malformed FIRMS provider payload', {
          name: 'TypeError',
          code: 'MALFORMED_PAYLOAD',
        });
      }
      if (payload.fires.length > maxResponseRecords) {
        throw providerError('FIRMS provider response exceeds bounded record limit', {
          name: 'RangeError',
          code: 'OVERSIZED_RESPONSE',
        });
      }

      const receivedAt = now();
      const entityId =
        filters.entity_id == null ? null : String(filters.entity_id).trim();
      const sourcePartial =
        Array.isArray(payload.sources) && payload.sources.some((source) => source?.ok === false);

      let coordinateRows = 0;
      let timestampRows = 0;
      const observations = [];
      const max = Math.max(0, Math.min(Number(limit) || 100, 10_000));

      for (const record of payload.fires) {
        const lat = finiteNumber(record?.lat);
        const lon = finiteNumber(record?.lon);
        if (
          lat == null ||
          lon == null ||
          Math.abs(lat) > 90 ||
          Math.abs(lon) > 180
        ) {
          continue;
        }
        coordinateRows += 1;

        const observedMs = acquisitionMsUtc(record.acqDate, record.acqTime);
        if (!Number.isFinite(observedMs)) continue;
        timestampRows += 1;

        const id = detectionId(record);
        if (entityId && id !== entityId) continue;
        if (!bboxContains({ lat, lon }, scope?.bbox)) continue;
        if (!timeContains(observedMs, time)) continue;
        if (observations.length >= max) break;

        observations.push(
          createObservationEnvelope({
            provider_id: GEV_FIRMS_FIRE_PROVIDER.provider_id,
            entity_type: 'fire-detection',
            entity_id: id,
            observation_type: 'active-fire-detection',
            timestamp_observed: new Date(observedMs),
            timestamp_received: receivedAt,
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
              satellite: record.satellite || null,
              instrument: record.instrument || null,
              source_sensor: sourceName(record),
              source_native_confidence: record.confidence ?? null,
              source_quality_normalized: normalizeConfidence(record.confidence),
              frp_mw: finiteNumber(record.frp),
              brightness: finiteNumber(record.brightness),
              day_night: record.daynight || null,
              acquisition_date: record.acqDate || null,
              acquisition_time_utc: String(record.acqTime ?? ''),
              source_batch_partial: sourcePartial,
              proxy_stale: Boolean(payload.stale),
            },
            coverage: GEV_FIRMS_FIRE_PROVIDER.coverage,
            confidence: payload.stale || sourcePartial ? 0.75 : 0.9,
            source_url: GEV_FIRMS_FIRE_PROVIDER.source_url,
            license_class: GEV_FIRMS_FIRE_PROVIDER.license_class,
            commercial_allowed: GEV_FIRMS_FIRE_PROVIDER.commercial_allowed,
            attribution_required: GEV_FIRMS_FIRE_PROVIDER.attribution_required,
            retention_policy: GEV_FIRMS_FIRE_PROVIDER.retention_policy,
            rate_limit_class: 'firms-map-key-quota',
            ingestion_run_id:
              ingestionRunId ?? `gev-firms-${receivedAt.toISOString()}`,
            raw_reference: id,
          }),
        );
      }

      if (payload.fires.length > 0 && coordinateRows === 0) {
        throw providerError('FIRMS payload contained no usable coordinates', {
          name: 'TypeError',
          code: 'MISSING_COORDINATES',
        });
      }
      if (coordinateRows > 0 && timestampRows === 0) {
        throw providerError('FIRMS payload contained no valid detection timestamps', {
          name: 'TypeError',
          code: 'INVALID_TIMESTAMP',
        });
      }

      return observations;
    },
  });
}
