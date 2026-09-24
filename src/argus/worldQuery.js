import { createProviderRegistry } from './providerRegistry.js';
import {
  compareWorldSnapshots,
  haversineDistanceKm,
  normalizeWorldPoint,
  pointCoordinates,
  radiusBbox,
} from './worldOperations.js';

function normalizeLimit(value, fallback = 100) {
  return Math.max(0, Number(value) || fallback);
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function observedDescending(left, right) {
  return (
    Date.parse(right.timestamp_observed) - Date.parse(left.timestamp_observed)
  );
}

export function createWorldQueryEngine({
  providerRegistry = createProviderRegistry(),
  adapters = [],
  now = () => new Date(),
} = {}) {
  const adapterMap = new Map();

  function registerAdapter(adapter, options) {
    if (
      !adapter?.metadata?.provider_id ||
      typeof adapter.query !== 'function'
    ) {
      throw new TypeError('adapter requires metadata.provider_id and query()');
    }

    providerRegistry.register(adapter.metadata, options);
    adapterMap.set(adapter.metadata.provider_id, adapter);
    return adapter.metadata;
  }

  for (const adapter of adapters) registerAdapter(adapter);

  function selectedProviderIds(providerIds) {
    return Array.isArray(providerIds) && providerIds.length > 0
      ? providerIds
      : [...adapterMap.keys()];
  }

  async function runProviders({
    provider_ids,
    scope = null,
    time = null,
    filters = {},
    limit = 100,
    ingestion_run_id,
  } = {}) {
    return Promise.all(
      selectedProviderIds(provider_ids).map(async (providerId) => {
        const adapter = adapterMap.get(providerId);
        if (!adapter) {
          return {
            provider_id: providerId,
            ok: false,
            error: 'provider-not-registered',
            observations: [],
          };
        }

        try {
          const observations = await adapter.query({
            scope,
            time,
            filters,
            limit,
            ingestionRunId: ingestion_run_id,
          });
          return {
            provider_id: providerId,
            ok: true,
            error: null,
            observations: Array.isArray(observations) ? observations : [],
          };
        } catch (error) {
          return {
            provider_id: providerId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            observations: [],
          };
        }
      }),
    );
  }

  function summarizeProviders(providerResults, observationSelector) {
    return providerResults.map((result) => ({
      provider_id: result.provider_id,
      ok: result.ok,
      error: result.error,
      count: observationSelector
        ? observationSelector(result).length
        : result.observations.length,
    }));
  }

  async function query(options = {}) {
    const providerResults = await runProviders(options);

    return {
      as_of: now().toISOString(),
      scope: options.scope ?? null,
      time: options.time ?? null,
      filters: options.filters ?? {},
      providers: summarizeProviders(providerResults),
      observations: providerResults
        .flatMap((result) => result.observations)
        .slice(0, normalizeLimit(options.limit)),
    };
  }

  async function entity({
    entity_type,
    entity_id,
    provider_ids,
    time = null,
    filters = {},
    limit = 100,
    ingestion_run_id,
  } = {}) {
    const entityType = requireNonEmptyString(entity_type, 'entity_type');
    const entityId = requireNonEmptyString(entity_id, 'entity_id');
    const providerResults = await runProviders({
      provider_ids,
      time,
      filters: {
        ...filters,
        entity_type: entityType,
        entity_id: entityId,
      },
      limit,
      ingestion_run_id,
    });

    const selectMatches = (result) =>
      result.observations.filter(
        (observation) =>
          observation.entity_type === entityType &&
          observation.entity_id === entityId,
      );

    const observations = providerResults
      .flatMap(selectMatches)
      .sort(observedDescending)
      .slice(0, normalizeLimit(limit));

    return {
      as_of: now().toISOString(),
      entity: {
        entity_type: entityType,
        entity_id: entityId,
      },
      found: observations.length > 0,
      latest_observation: observations[0] ?? null,
      providers: summarizeProviders(providerResults, selectMatches),
      observations,
    };
  }

  async function nearby({
    center,
    radius_km = 5,
    provider_ids,
    time = null,
    filters = {},
    limit = 100,
    ingestion_run_id,
  } = {}) {
    const normalizedCenter = normalizeWorldPoint(center);
    const radiusKm = Number(radius_km);
    if (!Number.isFinite(radiusKm) || radiusKm < 0) {
      throw new TypeError('radius_km must be a non-negative finite number');
    }

    const resultLimit = normalizeLimit(limit);
    const candidateLimit = Math.min(
      1000,
      Math.max(100, resultLimit > 0 ? resultLimit * 20 : 100),
    );
    const bbox = radiusBbox(normalizedCenter, radiusKm);
    const providerResults = await runProviders({
      provider_ids,
      scope: bbox ? { bbox } : null,
      time,
      filters,
      limit: candidateLimit,
      ingestion_run_id,
    });

    const matchesFor = (result) =>
      result.observations
        .map((observation) => {
          const coordinates = pointCoordinates(observation);
          if (!coordinates) return null;
          const distanceKm = haversineDistanceKm(normalizedCenter, coordinates);
          if (distanceKm > radiusKm) return null;
          return {
            distance_km: distanceKm,
            observation,
          };
        })
        .filter(Boolean);

    const results = providerResults
      .flatMap(matchesFor)
      .sort((left, right) => left.distance_km - right.distance_km)
      .slice(0, resultLimit);

    return {
      as_of: now().toISOString(),
      center: normalizedCenter,
      radius_km: radiusKm,
      providers: providerResults.map((result) => ({
        provider_id: result.provider_id,
        ok: result.ok,
        error: result.error,
        count: matchesFor(result).length,
      })),
      results,
    };
  }

  async function compare({ left = {}, right = {} } = {}) {
    const [leftSnapshot, rightSnapshot] = await Promise.all([
      query(left),
      query(right),
    ]);
    const comparison = compareWorldSnapshots(
      leftSnapshot.observations,
      rightSnapshot.observations,
    );

    return {
      compared_at: now().toISOString(),
      left: leftSnapshot,
      right: rightSnapshot,
      ...comparison,
    };
  }

  return Object.freeze({
    query,
    entity,
    nearby,
    compare,
    registerAdapter,
    providerRegistry,
    getAdapter: (providerId) => adapterMap.get(providerId) ?? null,
  });
}
