import { createObservationEnvelope } from '../observationEnvelope.js';

export function recoveryError(code, message, retryable = false) {
  const error = new Error(message);
  error.name = 'ProviderError';
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function finiteCoordinate(value, max) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const result = Number(value);
  return Number.isFinite(result) && Math.abs(result) <= max ? result : null;
}

export function inArea(lon, lat, scope) {
  const bbox = scope?.bbox;
  if (!bbox) return true;
  if (!Array.isArray(bbox) || bbox.length !== 4 ||
      bbox.some((n) => !Number.isFinite(n))) throw new TypeError('invalid bbox');
  const [west, south, east, north] = bbox;
  return lat >= south && lat <= north && lon >= west && lon <= east;
}

export function inTime(timestamp, time) {
  if (!time) return true;
  const start = time.start == null ? -Infinity : Date.parse(time.start);
  const end = time.end == null ? Infinity : Date.parse(time.end);
  if (Number.isNaN(start) || Number.isNaN(end) || start > end)
    throw new TypeError('invalid temporal range');
  return Date.parse(timestamp) >= start && Date.parse(timestamp) <= end;
}

export function boundedLimit(limit, cap = 500) {
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1) return 100;
  return Math.min(n, cap);
}

export async function deadline(operation, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError')
      throw recoveryError('TIMEOUT', 'provider timed out', true);
    if (error?.code) throw error;
    throw recoveryError('PROVIDER_FAILURE', error?.message || 'provider unavailable', true);
  } finally {
    clearTimeout(timer);
  }
}

export async function boundedJson(response, maxBytes = 2_000_000) {
  if (response.status === 429) throw recoveryError('RATE_LIMIT', 'provider rate limited', true);
  if (response.status === 401 || response.status === 403)
    throw recoveryError('ACCESS_DENIED', 'provider credential or access denied');
  if (!response.ok)
    throw recoveryError('PROVIDER_FAILURE', `provider HTTP ${response.status}`, response.status >= 500);
  const header = Number(response.headers?.get?.('content-length'));
  if (header > maxBytes) throw recoveryError('OVERSIZED_RESPONSE', 'provider result exceeds limit');
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw recoveryError('MALFORMED_PAYLOAD', 'provider JSON malformed');
  }
  const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (bytes > maxBytes) throw recoveryError('OVERSIZED_RESPONSE', 'provider result exceeds limit');
  return payload;
}

export function pointObservation({
  metadata, id, type, observationType, timestamp, receivedAt, lon, lat,
  properties, ingestionRunId, rawReference, confidence = null, sourceUrl = null,
}) {
  return createObservationEnvelope({
    provider_id: metadata.provider_id,
    entity_type: type,
    entity_id: id,
    observation_type: observationType,
    timestamp_observed: timestamp,
    timestamp_received: receivedAt,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties,
    coverage: metadata.coverage,
    confidence,
    source_url: sourceUrl || metadata.source_url,
    license_class: metadata.license_class,
    commercial_allowed: metadata.commercial_allowed,
    attribution_required: metadata.attribution_required,
    retention_policy: metadata.retention_policy,
    rate_limit_class: metadata.rate_limit_class,
    ingestion_run_id: ingestionRunId || `${metadata.provider_id}-${receivedAt}`,
    raw_reference: rawReference ?? id,
  });
}
