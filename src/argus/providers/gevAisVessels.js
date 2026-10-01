import { createObservationEnvelope } from '../observationEnvelope.js';
import { vesselSnapshot } from '../../sources/live/vessels.js';

export const GEV_AIS_VESSELS_PROVIDER = Object.freeze({
  provider_id: 'gev-aisstream-vessels',
  category: 'maritime',
  geography: 'AISStream subscription coverage',
  auth_mode: 'server-side-api-key-via-inherited-gev-proxy',
  cost_class: 'provider-account',
  update_frequency: 'near-real-time-stream-snapshot',
  latency: 'stream-and-cache-dependent',
  coverage: 'received AIS vessel positions',
  license_class: 'inherited-gev-source-license-review',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy:
    'retain normalized vessel observations; bounded source metadata only',
  reliability: 'inherited-gev-watchdog-and-stale-state',
  adapter_status: 'argus-query-callable',
  source_url: 'https://aisstream.io/',
});

function providerError(
  message,
  { name = 'ProviderError', retryable = false, code = null } = {},
) {
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
  return (
    record.longitude >= west &&
    record.longitude <= east &&
    record.latitude >= south &&
    record.latitude <= north
  );
}

function timeContains(observedMs, time) {
  if (!time) return true;
  const start = time.start == null ? -Infinity : Date.parse(time.start);
  const end = time.end == null ? Infinity : Date.parse(time.end);
  if (
    (time.start != null && !Number.isFinite(start)) ||
    (time.end != null && !Number.isFinite(end))
  ) {
    throw new TypeError('time range must contain valid timestamps');
  }
  return observedMs >= start && observedMs <= end;
}

export function createGevAisVesselsAdapter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 10_000,
  maxResponseRows = 50_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('GEV AIS adapter requires fetch');
  }

  return Object.freeze({
    metadata: GEV_AIS_VESSELS_PROVIDER,

    async query({
      scope,
      time,
      filters = {},
      limit = 100,
      ingestionRunId,
    } = {}) {
      if (filters.entity_type != null && filters.entity_type !== 'vessel')
        return [];
      const maxRows = Math.max(
        1,
        Math.min(maxResponseRows, Math.max(Number(limit) || 100, 100)),
      );
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(),
        Math.max(1, Number(timeoutMs) || 10_000),
      );
      let response;
      try {
        response = await fetchImpl(`/api/ais-live?maxRows=${maxRows}`, {
          signal: controller.signal,
          cache: 'no-store',
        });
      } catch (error) {
        if (error?.name === 'AbortError') {
          throw providerError('AIS provider timeout', {
            name: 'TimeoutError',
            retryable: true,
            code: 'TIMEOUT',
          });
        }
        throw providerError('AIS provider unavailable', {
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
        throw providerError('Malformed AIS provider payload', {
          name: 'TypeError',
          code: 'MALFORMED_PAYLOAD',
        });
      }

      if (!response.ok) {
        const status = String(payload?.status || '');
        if (
          response.status === 503 &&
          (status === 'missing-key' || payload?.error === 'no_key')
        ) {
          throw providerError('AISSTREAM_API_KEY is required', {
            name: 'ProviderCredentialError',
            code: 'CREDENTIAL_MISSING',
          });
        }
        if (
          status === 'auth-failed' ||
          response.status === 401 ||
          response.status === 403
        ) {
          throw providerError('AIS provider credential rejected', {
            name: 'ProviderCredentialError',
            code: 'CREDENTIAL_REJECTED',
          });
        }
        throw providerError(`AIS provider HTTP ${response.status}`, {
          retryable:
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          code: response.status === 429 ? 'RATE_LIMIT' : 'HTTP_FAILURE',
        });
      }

      if (!Array.isArray(payload?.rows)) {
        throw providerError('Malformed AIS provider payload', {
          name: 'TypeError',
          code: 'MALFORMED_PAYLOAD',
        });
      }
      if (payload.rows.length > maxResponseRows) {
        throw providerError('AIS provider response exceeds bounded row limit', {
          name: 'RangeError',
          code: 'OVERSIZED_RESPONSE',
        });
      }

      const receivedAt = now();
      const snapshot = vesselSnapshot(payload);
      if (payload.rows.length > 0 && snapshot.records.length === 0) {
        throw providerError('AIS payload contained no usable coordinates', {
          name: 'TypeError',
          code: 'MISSING_COORDINATES',
        });
      }

      const entityId =
        filters.entity_id == null ? null : String(filters.entity_id).trim();
      const usable = snapshot.records.filter((record) =>
        Number.isFinite(record.observedAtMs),
      );
      if (
        payload.rows.length > 0 &&
        snapshot.records.length > 0 &&
        usable.length === 0
      ) {
        throw providerError(
          'AIS payload contained no valid observation timestamps',
          {
            name: 'TypeError',
            code: 'INVALID_TIMESTAMP',
          },
        );
      }

      return usable
        .filter((record) => !entityId || record.id === entityId)
        .filter((record) => bboxContains(record, scope?.bbox))
        .filter((record) => timeContains(record.observedAtMs, time))
        .slice(0, Math.max(0, Math.min(Number(limit) || 100, 5000)))
        .map((record) =>
          createObservationEnvelope({
            provider_id: GEV_AIS_VESSELS_PROVIDER.provider_id,
            entity_type: 'vessel',
            entity_id: record.id,
            observation_type: 'vessel-position',
            timestamp_observed: new Date(record.observedAtMs),
            timestamp_received: receivedAt,
            geometry: {
              type: 'Point',
              coordinates: [record.longitude, record.latitude],
            },
            properties: {
              speed_mps: record.speedMps,
              course_deg: record.courseDeg,
              heading_deg: record.headingDeg,
              vessel_type: record.type || null,
              altitude_datum: record.altitudeDatum,
              transport_status: snapshot.transportStatus,
              source_freshness: snapshot.freshness,
              source_complete: snapshot.complete,
            },
            coverage: snapshot.coverage,
            confidence: snapshot.stale ? 0.65 : 0.9,
            source_url: GEV_AIS_VESSELS_PROVIDER.source_url,
            license_class: GEV_AIS_VESSELS_PROVIDER.license_class,
            commercial_allowed: GEV_AIS_VESSELS_PROVIDER.commercial_allowed,
            attribution_required: GEV_AIS_VESSELS_PROVIDER.attribution_required,
            retention_policy: GEV_AIS_VESSELS_PROVIDER.retention_policy,
            rate_limit_class: 'inherited-gev-aisstream-budget',
            ingestion_run_id:
              ingestionRunId ?? `gev-ais-${receivedAt.toISOString()}`,
            raw_reference: record.reference,
          }),
        );
    },
  });
}
