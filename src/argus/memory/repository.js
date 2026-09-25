import { validateObservationEnvelope } from '../observationEnvelope.js';
import {
  geometryBbox,
  geometryBboxesIntersect,
} from '../spatial/geometry.js';
import {
  haversineDistanceKm,
  normalizeWorldPoint,
  pointCoordinates,
} from '../worldOperations.js';

export const WORLD_MEMORY_REPOSITORY_METHODS = Object.freeze([
  'appendObservations',
  'queryObservations',
  'getEntityHistory',
  'queryNearby',
  'saveIngestionRun',
  'getIngestionRun',
]);

const INGESTION_STATUSES = new Set([
  'RUNNING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'CANCELLED',
]);

function cloneValue(value) {
  return value == null ? value : structuredClone(value);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(field + ' must be a non-empty string');
  }
  return value;
}

function normalizeOptionalTimestamp(value, field) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(field + ' must be a valid timestamp');
  }
  return date.toISOString();
}

function normalizeLimit(value, fallback = 100) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError('limit must be a non-negative finite number');
  }
  return Math.floor(number);
}

function normalizeOrder(value) {
  const order = value ?? 'desc';
  if (order !== 'asc' && order !== 'desc') {
    throw new TypeError("order must be 'asc' or 'desc'");
  }
  return order;
}

function normalizeProviderIds(providerIds) {
  if (providerIds == null) return null;
  if (!Array.isArray(providerIds)) {
    throw new TypeError('provider_ids must be an array when provided');
  }
  if (providerIds.length === 0) return null;

  return new Set(
    providerIds.map((providerId) =>
      requireNonEmptyString(providerId, 'provider_ids item'),
    ),
  );
}

function normalizeBbox(bbox) {
  if (bbox == null) return null;
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new TypeError('bbox must be [west, south, east, north]');
  }

  const values = bbox.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('bbox values must be finite numbers');
  }

  const [west, south, east, north] = values;
  if (
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    south > 90 ||
    north < -90 ||
    north > 90 ||
    west > east ||
    south > north
  ) {
    throw new RangeError('bbox must be a valid non-antimeridian WGS84 bbox');
  }

  return values;
}

function observedAtMs(observation) {
  return Date.parse(observation.timestamp_observed);
}

function normalizeObservationQuery({
  provider_ids,
  entity_type = null,
  provider_entity_id = null,
  observation_type = null,
  from = null,
  to = null,
  bbox = null,
  limit = 100,
  order = 'desc',
} = {}) {
  const fromIso = normalizeOptionalTimestamp(from, 'from');
  const toIso = normalizeOptionalTimestamp(to, 'to');
  const fromMs = fromIso ? Date.parse(fromIso) : -Infinity;
  const toMs = toIso ? Date.parse(toIso) : Infinity;
  if (fromMs > toMs) {
    throw new RangeError('from must not be after to');
  }

  return {
    providerSet: normalizeProviderIds(provider_ids),
    entityType:
      entity_type == null
        ? null
        : requireNonEmptyString(entity_type, 'entity_type'),
    providerEntityId:
      provider_entity_id == null
        ? null
        : requireNonEmptyString(
            provider_entity_id,
            'provider_entity_id',
          ),
    observationType:
      observation_type == null
        ? null
        : requireNonEmptyString(observation_type, 'observation_type'),
    fromMs,
    toMs,
    bbox: normalizeBbox(bbox),
    limit: normalizeLimit(limit),
    order: normalizeOrder(order),
  };
}

function observationMatches(record, query) {
  const observation = record.observation;

  if (query.providerSet && !query.providerSet.has(observation.provider_id)) {
    return false;
  }
  if (
    query.entityType &&
    observation.entity_type !== query.entityType
  ) {
    return false;
  }
  if (
    query.providerEntityId &&
    observation.entity_id !== query.providerEntityId
  ) {
    return false;
  }
  if (
    query.observationType &&
    observation.observation_type !== query.observationType
  ) {
    return false;
  }

  const observed = observedAtMs(observation);
  if (observed < query.fromMs || observed > query.toMs) return false;

  if (query.bbox) {
    const observationBbox = geometryBbox(observation.geometry);
    if (
      !observationBbox ||
      !geometryBboxesIntersect(observationBbox, query.bbox)
    ) {
      return false;
    }
  }

  return true;
}

function compareRecords(left, right, order) {
  const delta = observedAtMs(left.observation) - observedAtMs(right.observation);
  if (delta !== 0) return order === 'asc' ? delta : -delta;
  return order === 'asc'
    ? left.sequence - right.sequence
    : right.sequence - left.sequence;
}

function normalizeIngestionRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new TypeError('ingestion run must be an object');
  }

  const status = requireNonEmptyString(run.status, 'status');
  if (!INGESTION_STATUSES.has(status)) {
    throw new RangeError('status is not a supported ingestion status');
  }

  const startedAt = normalizeOptionalTimestamp(run.started_at, 'started_at');
  if (!startedAt) {
    throw new TypeError('started_at is required');
  }

  const completedAt = normalizeOptionalTimestamp(
    run.completed_at,
    'completed_at',
  );
  if (
    completedAt &&
    Date.parse(completedAt) < Date.parse(startedAt)
  ) {
    throw new RangeError('completed_at must not be before started_at');
  }

  return {
    ...cloneValue(run),
    ingestion_run_id: requireNonEmptyString(
      run.ingestion_run_id,
      'ingestion_run_id',
    ),
    provider_id: requireNonEmptyString(run.provider_id, 'provider_id'),
    status,
    started_at: startedAt,
    completed_at: completedAt,
    metadata: cloneValue(run.metadata ?? {}),
  };
}

export function validateWorldMemoryRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('worldMemory repository must be an object');
  }

  for (const method of WORLD_MEMORY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError('worldMemory.' + method + '() is required');
    }
  }

  return repository;
}

export function createInMemoryWorldMemoryRepository({
  now = () => new Date(),
} = {}) {
  const observationRecords = [];
  const ingestionRuns = new Map();
  let sequence = 0;

  async function appendObservations(observations, { recorded_at } = {}) {
    if (!Array.isArray(observations)) {
      throw new TypeError('observations must be an array');
    }

    const recordedAt = normalizeOptionalTimestamp(
      recorded_at ?? now(),
      'recorded_at',
    );

    const validated = observations.map((observation) => {
      const result = validateObservationEnvelope(observation);
      if (!result.ok) {
        throw new TypeError(
          'invalid observation for World Memory: ' +
            result.errors.join('; '),
        );
      }
      return cloneValue(observation);
    });

    const pending = validated.map((observation) => ({
      sequence: ++sequence,
      recorded_at: recordedAt,
      observation,
    }));

    observationRecords.push(...pending);

    return {
      inserted: pending.length,
      total: observationRecords.length,
      first_sequence: pending[0]?.sequence ?? null,
      last_sequence: pending.at(-1)?.sequence ?? null,
    };
  }

  async function queryObservations(options = {}) {
    const query = normalizeObservationQuery(options);

    return observationRecords
      .filter((record) => observationMatches(record, query))
      .sort((left, right) => compareRecords(left, right, query.order))
      .slice(0, query.limit)
      .map((record) => cloneValue(record.observation));
  }

  async function getEntityHistory({
    entity_type,
    provider_entity_id,
    ...options
  } = {}) {
    return queryObservations({
      ...options,
      entity_type: requireNonEmptyString(entity_type, 'entity_type'),
      provider_entity_id: requireNonEmptyString(
        provider_entity_id,
        'provider_entity_id',
      ),
    });
  }

  async function queryNearby({
    center,
    radius_km = 5,
    provider_ids,
    entity_type = null,
    observation_type = null,
    from = null,
    to = null,
    limit = 100,
  } = {}) {
    const normalizedCenter = normalizeWorldPoint(center);
    const radiusKm = Number(radius_km);
    if (!Number.isFinite(radiusKm) || radiusKm < 0) {
      throw new TypeError(
        'radius_km must be a non-negative finite number',
      );
    }

    const candidates = await queryObservations({
      provider_ids,
      entity_type,
      observation_type,
      from,
      to,
      limit: Number.MAX_SAFE_INTEGER,
      order: 'desc',
    });

    return candidates
      .map((observation) => {
        const coordinates = pointCoordinates(observation);
        if (!coordinates) return null;

        const distanceKm = haversineDistanceKm(
          normalizedCenter,
          coordinates,
        );
        if (distanceKm > radiusKm) return null;

        return {
          distance_km: distanceKm,
          observation,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.distance_km - right.distance_km)
      .slice(0, normalizeLimit(limit));
  }

  async function saveIngestionRun(run) {
    const normalized = normalizeIngestionRun(run);
    ingestionRuns.set(
      normalized.ingestion_run_id,
      cloneValue(normalized),
    );
    return cloneValue(normalized);
  }

  async function getIngestionRun(ingestionRunId) {
    const id = requireNonEmptyString(
      ingestionRunId,
      'ingestion_run_id',
    );
    return cloneValue(ingestionRuns.get(id) ?? null);
  }

  return Object.freeze({
    kind: 'in-memory',
    appendObservations,
    queryObservations,
    getEntityHistory,
    queryNearby,
    saveIngestionRun,
    getIngestionRun,
    observationCount: () => observationRecords.length,
    ingestionRunCount: () => ingestionRuns.size,
  });
}
