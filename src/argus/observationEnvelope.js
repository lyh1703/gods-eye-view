const REQUIRED_STRING_FIELDS = [
  'provider_id',
  'entity_type',
  'entity_id',
  'observation_type',
  'timestamp_observed',
  'timestamp_received',
  'source_url',
  'license_class',
  'retention_policy',
  'rate_limit_class',
  'ingestion_run_id',
];

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function toIsoTimestamp(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return date.toISOString();
}

function calculateFreshnessSeconds(observed, received) {
  return Math.max(
    0,
    (new Date(received).getTime() - new Date(observed).getTime()) / 1000,
  );
}

export function validateObservationEnvelope(observation) {
  const errors = [];

  if (!isPlainObject(observation)) {
    return { ok: false, errors: ['observation must be a plain object'] };
  }

  for (const field of REQUIRED_STRING_FIELDS) {
    if (
      typeof observation[field] !== 'string' ||
      observation[field].trim() === ''
    ) {
      errors.push(`${field} must be a non-empty string`);
    }
  }

  for (const field of ['timestamp_observed', 'timestamp_received']) {
    if (
      typeof observation[field] === 'string' &&
      Number.isNaN(Date.parse(observation[field]))
    ) {
      errors.push(`${field} must be an ISO-compatible timestamp`);
    }
  }

  if (
    observation.geometry !== null &&
    (!isPlainObject(observation.geometry) ||
      typeof observation.geometry.type !== 'string')
  ) {
    errors.push('geometry must be null or a GeoJSON-like object');
  }

  if (!isPlainObject(observation.properties)) {
    errors.push('properties must be a plain object');
  }

  if (
    !Number.isFinite(observation.freshness_seconds) ||
    observation.freshness_seconds < 0
  ) {
    errors.push('freshness_seconds must be a non-negative finite number');
  }

  if (
    observation.confidence !== null &&
    (!Number.isFinite(observation.confidence) ||
      observation.confidence < 0 ||
      observation.confidence > 1)
  ) {
    errors.push('confidence must be null or a number between 0 and 1');
  }

  if (
    observation.commercial_allowed !== null &&
    typeof observation.commercial_allowed !== 'boolean'
  ) {
    errors.push('commercial_allowed must be boolean or null');
  }

  if (typeof observation.attribution_required !== 'boolean') {
    errors.push('attribution_required must be boolean');
  }

  return { ok: errors.length === 0, errors };
}

export function createObservationEnvelope(input) {
  if (!isPlainObject(input)) {
    throw new TypeError('observation input must be a plain object');
  }

  const timestampObserved = toIsoTimestamp(
    input.timestamp_observed,
    'timestamp_observed',
  );
  const timestampReceived = toIsoTimestamp(
    input.timestamp_received,
    'timestamp_received',
  );

  const observation = {
    ...input,
    timestamp_observed: timestampObserved,
    timestamp_received: timestampReceived,
    geometry: input.geometry ?? null,
    properties: input.properties ?? {},
    freshness_seconds:
      input.freshness_seconds ??
      calculateFreshnessSeconds(timestampObserved, timestampReceived),
    coverage: input.coverage ?? null,
    confidence: input.confidence ?? null,
    commercial_allowed: input.commercial_allowed ?? null,
    attribution_required: input.attribution_required ?? false,
    raw_reference: input.raw_reference ?? null,
  };

  const result = validateObservationEnvelope(observation);
  if (!result.ok) {
    throw new TypeError(
      `invalid ARGUS observation: ${result.errors.join('; ')}`,
    );
  }

  return observation;
}
