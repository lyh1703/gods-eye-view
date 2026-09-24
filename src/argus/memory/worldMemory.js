import { validateObservationEnvelope } from '../observationEnvelope.js';

export const WORLD_MEMORY_REPOSITORY_METHODS = Object.freeze([
  'appendObservations',
  'history',
]);

function cloneJson(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeOptionalTimestamp(value, field) {
  if (value == null) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new TypeError(`${field} must be a valid timestamp`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeLimit(value, fallback = 100) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError('limit must be a non-negative finite number');
  }
  return Math.floor(number);
}

function normalizeOrder(order) {
  if (order == null) return 'desc';
  if (order !== 'asc' && order !== 'desc') {
    throw new TypeError("order must be 'asc' or 'desc'");
  }
  return order;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

export function validateWorldMemoryRepository(repository) {
  if (!repository || typeof repository !== 'object') {
    throw new TypeError('worldMemory must be a repository object');
  }

  for (const method of WORLD_MEMORY_REPOSITORY_METHODS) {
    if (typeof repository[method] !== 'function') {
      throw new TypeError(`worldMemory.${method}() is required`);
    }
  }

  return repository;
}

export function createInMemoryWorldMemory({ now = () => new Date() } = {}) {
  const records = [];
  let sequence = 0;

  async function appendObservations(observations, { recorded_at } = {}) {
    if (!Array.isArray(observations)) {
      throw new TypeError('observations must be an array');
    }

    const recordedAt = normalizeOptionalTimestamp(
      recorded_at ?? now(),
      'recorded_at',
    );
    const pending = observations.map((observation) => {
      const validation = validateObservationEnvelope(observation);
      if (!validation.ok) {
        throw new TypeError(
          `invalid observation for World Memory: ${validation.errors.join('; ')}`,
        );
      }

      return {
        sequence: ++sequence,
        recorded_at: recordedAt,
        observation: cloneJson(observation),
      };
    });

    records.push(...pending);
    return {
      inserted: pending.length,
      total: records.length,
      first_sequence: pending[0]?.sequence ?? null,
      last_sequence: pending.at(-1)?.sequence ?? null,
    };
  }

  async function history({
    entity_type,
    entity_id,
    provider_ids,
    from = null,
    to = null,
    limit = 100,
    order = 'desc',
  } = {}) {
    const entityType = requireString(entity_type, 'entity_type');
    const entityId = requireString(entity_id, 'entity_id');
    const fromIso = normalizeOptionalTimestamp(from, 'from');
    const toIso = normalizeOptionalTimestamp(to, 'to');
    const fromTimestamp = fromIso ? Date.parse(fromIso) : -Infinity;
    const toTimestamp = toIso ? Date.parse(toIso) : Infinity;
    if (fromTimestamp > toTimestamp) {
      throw new RangeError('from must not be after to');
    }

    const providerSet =
      Array.isArray(provider_ids) && provider_ids.length > 0
        ? new Set(provider_ids.map((providerId) => String(providerId)))
        : null;
    const normalizedOrder = normalizeOrder(order);
    const normalizedLimit = normalizeLimit(limit);

    return records
      .filter(({ observation }) => {
        if (
          observation.entity_type !== entityType ||
          observation.entity_id !== entityId
        ) {
          return false;
        }
        if (providerSet && !providerSet.has(observation.provider_id)) {
          return false;
        }

        const observedAt = Date.parse(observation.timestamp_observed);
        return observedAt >= fromTimestamp && observedAt <= toTimestamp;
      })
      .sort((left, right) => {
        const delta =
          Date.parse(left.observation.timestamp_observed) -
          Date.parse(right.observation.timestamp_observed);
        return normalizedOrder === 'asc' ? delta : -delta;
      })
      .slice(0, normalizedLimit)
      .map(({ observation }) => cloneJson(observation));
  }

  return Object.freeze({
    kind: 'in-memory',
    appendObservations,
    history,
    size: () => records.length,
  });
}
