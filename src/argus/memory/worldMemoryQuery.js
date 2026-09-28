import {
  haversineDistanceKm,
  normalizeWorldPoint,
  pointCoordinates,
  radiusBbox,
} from '../worldOperations.js';
import { validateWorldMemoryRepository } from './repository.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(field + ' must be a non-empty string');
  }
  return value;
}

function requireCanonicalId(value) {
  const id = requireString(value, 'canonical_entity_id');
  if (!UUID_PATTERN.test(id)) {
    throw new TypeError('canonical_entity_id must be a UUID');
  }
  return id;
}

function toIso(value, field) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(field + ' must be a valid timestamp');
  }
  return date.toISOString();
}

function normalizeTimeBasis(value) {
  const basis = value ?? 'effective';
  if (!['observed', 'effective', 'received'].includes(basis)) {
    throw new TypeError(
      "time_basis must be 'observed', 'effective', or 'received'",
    );
  }
  return basis;
}

function observationTime(observation, basis) {
  const field = {
    observed: 'timestamp_observed',
    effective: 'effective_at',
    received: 'timestamp_received',
  }[basis];
  return Date.parse(
    observation?.[field] ??
      (basis === 'effective' ? observation?.timestamp_observed : ''),
  );
}

function providerScopedKey(observation) {
  return [
    observation.provider_id,
    observation.entity_type,
    observation.entity_id,
  ].join(':');
}

function latestSnapshot(observations, basis) {
  const latest = new Map();
  for (const observation of observations) {
    const key = providerScopedKey(observation);
    const previous = latest.get(key);
    if (
      !previous ||
      observationTime(observation, basis) >= observationTime(previous, basis)
    ) {
      latest.set(key, observation);
    }
  }
  return [...latest.values()].sort(
    (left, right) =>
      observationTime(right, basis) - observationTime(left, basis),
  );
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function stateFingerprint(observation) {
  return JSON.stringify(
    stableValue({
      observation_type: observation.observation_type,
      geometry: observation.geometry ?? null,
      properties: observation.properties ?? {},
    }),
  );
}

function evidenceStatus(observations, asOf, basis) {
  const providerIds = [...new Set(observations.map((item) => item.provider_id))]
    .filter(Boolean)
    .sort();
  const ingestionRunIds = [
    ...new Set(observations.map((item) => item.ingestion_run_id)),
  ]
    .filter(Boolean)
    .sort();
  const sourceUrls = [...new Set(observations.map((item) => item.source_url))]
    .filter(Boolean)
    .sort();

  const latestTime = observations.reduce((latest, observation) => {
    const timestamp = observationTime(observation, basis);
    return Number.isFinite(timestamp) ? Math.max(latest, timestamp) : latest;
  }, -Infinity);
  const asOfMs = Date.parse(asOf);
  const stalenessSeconds =
    Number.isFinite(latestTime) && Number.isFinite(asOfMs)
      ? Math.max(0, (asOfMs - latestTime) / 1000)
      : null;

  const canonicalGroups = new Map();
  for (const observation of observations) {
    if (!observation.canonical_entity_id) continue;
    const list = canonicalGroups.get(observation.canonical_entity_id) ?? [];
    list.push(observation);
    canonicalGroups.set(observation.canonical_entity_id, list);
  }

  const conflicts = [];
  for (const [canonicalEntityId, items] of canonicalGroups) {
    if (items.length < 2) continue;
    const fingerprints = new Set(items.map(stateFingerprint));
    if (fingerprints.size > 1) {
      conflicts.push({
        canonical_entity_id: canonicalEntityId,
        provider_ids: [
          ...new Set(items.map((item) => item.provider_id)),
        ].sort(),
        observation_ids: items
          .map((item) => item.observation_id)
          .filter(Boolean)
          .sort(),
      });
    }
  }

  return {
    provider_ids: providerIds,
    ingestion_run_ids: ingestionRunIds,
    source_urls: sourceUrls,
    staleness_seconds: stalenessSeconds,
    conflicts,
    conflict_count: conflicts.length,
  };
}

function normalizeIdentity(input) {
  if (typeof input === 'string') {
    return {
      scope: 'canonical',
      canonical_entity_id: requireCanonicalId(input),
      provider_ids: null,
      entity_type: null,
      provider_entity_id: null,
    };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(
      'identity must be a canonical entity UUID or an identity object',
    );
  }

  if (input.canonical_entity_id) {
    return {
      scope: 'canonical',
      canonical_entity_id: requireCanonicalId(input.canonical_entity_id),
      provider_ids: input.provider_ids ?? null,
      entity_type: input.entity_type ?? null,
      provider_entity_id: null,
    };
  }

  return {
    scope: 'provider',
    canonical_entity_id: null,
    provider_ids: input.provider_ids ?? null,
    entity_type: requireString(input.entity_type, 'entity_type'),
    provider_entity_id: requireString(
      input.provider_entity_id ?? input.entity_id,
      'provider_entity_id',
    ),
  };
}

function normalizeTime(time, now) {
  if (time == null) {
    const at = now().toISOString();
    return { mode: 'snapshot', at, start: null, end: null };
  }
  if (
    typeof time === 'string' ||
    typeof time === 'number' ||
    time instanceof Date
  ) {
    return {
      mode: 'snapshot',
      at: toIso(time, 'time'),
      start: null,
      end: null,
    };
  }
  if (typeof time !== 'object' || Array.isArray(time)) {
    throw new TypeError('time must be a timestamp or time object');
  }
  if (time.at != null) {
    return {
      mode: 'snapshot',
      at: toIso(time.at, 'time.at'),
      start: null,
      end: null,
    };
  }

  const start = time.start == null ? null : toIso(time.start, 'time.start');
  const end = time.end == null ? null : toIso(time.end, 'time.end');
  if (start && end && Date.parse(start) > Date.parse(end)) {
    throw new RangeError('time.start must not be after time.end');
  }
  if (!start && !end) {
    const at = now().toISOString();
    return { mode: 'snapshot', at, start: null, end: null };
  }
  return { mode: 'range', at: null, start, end };
}

function normalizeArea(area) {
  if (area == null) return null;
  const bbox = Array.isArray(area) ? area : area.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new TypeError('area must be bbox [west, south, east, north]');
  }
  return bbox.map(Number);
}

function normalizeLimit(value, fallback = 100) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError('limit must be a non-negative finite number');
  }
  return Math.floor(number);
}

function candidateLimit(limit) {
  return Math.min(5000, Math.max(500, normalizeLimit(limit) * 50));
}

function parseQueryArgs(optionsOrArea, timeArg, typeArg) {
  if (
    Array.isArray(optionsOrArea) ||
    optionsOrArea == null ||
    typeof optionsOrArea !== 'object'
  ) {
    return {
      area: optionsOrArea ?? null,
      time: timeArg ?? null,
      type: typeArg ?? null,
    };
  }
  return optionsOrArea;
}

function parseNearArgs(optionsOrPoint, radiusArg, timeArg) {
  if (Array.isArray(optionsOrPoint)) {
    return {
      point: optionsOrPoint,
      radius_km: radiusArg,
      time: timeArg ?? null,
    };
  }
  return optionsOrPoint ?? {};
}

export function createWorldMemoryQueryEngine({
  repository,
  now = () => new Date(),
} = {}) {
  const memory = validateWorldMemoryRepository(repository);

  async function fetchIdentity(identity, options) {
    if (identity.scope === 'canonical') {
      return memory.queryObservations({
        provider_ids: identity.provider_ids,
        entity_type: identity.entity_type,
        canonical_entity_id: identity.canonical_entity_id,
        ...options,
      });
    }
    return memory.getEntityHistory({
      provider_ids: identity.provider_ids,
      entity_type: identity.entity_type,
      provider_entity_id: identity.provider_entity_id,
      ...options,
    });
  }

  async function get(identityInput, at = null, options = {}) {
    const identity = normalizeIdentity(identityInput);
    const basis = normalizeTimeBasis(options.time_basis);
    const asOf = at == null ? now().toISOString() : toIso(at, 'at');
    const limit = candidateLimit(options.limit ?? 100);

    const history = await fetchIdentity(identity, {
      observation_type: options.observation_type ?? null,
      to: asOf,
      order: 'desc',
      limit,
      time_basis: basis,
    });
    const states = latestSnapshot(history, basis);

    return {
      as_of: asOf,
      time_basis: basis,
      identity,
      found: states.length > 0,
      state: states[0] ?? null,
      states,
      candidate_count: history.length,
      candidate_truncated: history.length >= limit,
      evidence: evidenceStatus(states, asOf, basis),
    };
  }

  async function history(
    identityInput,
    start = null,
    end = null,
    options = {},
  ) {
    const identity = normalizeIdentity(identityInput);
    const basis = normalizeTimeBasis(options.time_basis);
    const from = start == null ? null : toIso(start, 'start');
    const to = end == null ? null : toIso(end, 'end');
    if (from && to && Date.parse(from) > Date.parse(to)) {
      throw new RangeError('start must not be after end');
    }

    const observations = await fetchIdentity(identity, {
      observation_type: options.observation_type ?? null,
      from,
      to,
      order: options.order ?? 'asc',
      limit: normalizeLimit(options.limit, 1000),
      time_basis: basis,
    });

    return {
      time_basis: basis,
      identity,
      start: from,
      end: to,
      count: observations.length,
      observations,
      evidence: evidenceStatus(observations, to ?? now().toISOString(), basis),
    };
  }

  async function query(optionsOrArea = {}, timeArg = null, typeArg = null) {
    const options = parseQueryArgs(optionsOrArea, timeArg, typeArg);
    const basis = normalizeTimeBasis(options.time_basis);
    const time = normalizeTime(options.time, now);
    const limit = normalizeLimit(options.limit);
    const bbox = normalizeArea(options.area ?? options.bbox ?? null);
    const entityType = options.type ?? options.entity_type ?? null;

    if (time.mode === 'range') {
      const observations = await memory.queryObservations({
        provider_ids: options.provider_ids,
        entity_type: entityType,
        observation_type: options.observation_type ?? null,
        from: time.start,
        to: time.end,
        bbox,
        order: options.order ?? 'asc',
        limit,
        time_basis: basis,
      });
      return {
        mode: 'history',
        time_basis: basis,
        area: bbox,
        time,
        count: observations.length,
        observations,
        evidence: evidenceStatus(
          observations,
          time.end ?? now().toISOString(),
          basis,
        ),
      };
    }

    const candidates = candidateLimit(limit);
    const observations = await memory.queryObservations({
      provider_ids: options.provider_ids,
      entity_type: entityType,
      observation_type: options.observation_type ?? null,
      to: time.at,
      bbox,
      order: 'desc',
      limit: candidates,
      time_basis: basis,
    });
    const states = latestSnapshot(observations, basis).slice(0, limit);

    return {
      mode: 'snapshot',
      as_of: time.at,
      time_basis: basis,
      area: bbox,
      count: states.length,
      states,
      candidate_count: observations.length,
      candidate_truncated: observations.length >= candidates,
      evidence: evidenceStatus(states, time.at, basis),
    };
  }

  async function near(optionsOrPoint, radiusArg = null, timeArg = null) {
    const options = parseNearArgs(optionsOrPoint, radiusArg, timeArg);
    const point = normalizeWorldPoint(options.point ?? options.center);
    const radiusKm = Number(options.radius_km ?? 5);
    if (!Number.isFinite(radiusKm) || radiusKm < 0) {
      throw new TypeError('radius_km must be a non-negative finite number');
    }
    const basis = normalizeTimeBasis(options.time_basis);
    const time = normalizeTime(options.time, now);
    const limit = normalizeLimit(options.limit);
    const entityType = options.type ?? options.entity_type ?? null;

    if (time.mode === 'range') {
      const results = await memory.queryNearby({
        center: point,
        radius_km: radiusKm,
        provider_ids: options.provider_ids,
        entity_type: entityType,
        observation_type: options.observation_type ?? null,
        from: time.start,
        to: time.end,
        limit,
        time_basis: basis,
      });
      return {
        mode: 'history',
        point,
        radius_km: radiusKm,
        time_basis: basis,
        time,
        count: results.length,
        results,
        evidence: evidenceStatus(
          results.map((item) => item.observation),
          time.end ?? now().toISOString(),
          basis,
        ),
      };
    }

    const candidates = candidateLimit(limit);
    const bbox = radiusBbox(point, radiusKm);
    const observations = await memory.queryObservations({
      provider_ids: options.provider_ids,
      entity_type: entityType,
      observation_type: options.observation_type ?? null,
      to: time.at,
      bbox,
      order: 'desc',
      limit: candidates,
      time_basis: basis,
    });
    const snapshot = latestSnapshot(observations, basis);
    const results = snapshot
      .map((observation) => {
        const coordinates = pointCoordinates(observation);
        if (!coordinates) return null;
        const distanceKm = haversineDistanceKm(point, coordinates);
        if (distanceKm > radiusKm) return null;
        return { distance_km: distanceKm, observation };
      })
      .filter(Boolean)
      .sort((left, right) => left.distance_km - right.distance_km)
      .slice(0, limit);

    return {
      mode: 'snapshot',
      as_of: time.at,
      point,
      radius_km: radiusKm,
      time_basis: basis,
      count: results.length,
      results,
      candidate_count: observations.length,
      candidate_truncated: observations.length >= candidates,
      evidence: evidenceStatus(
        results.map((item) => item.observation),
        time.at,
        basis,
      ),
    };
  }

  return Object.freeze({
    get,
    history,
    query,
    near,
    repository: memory,
  });
}
