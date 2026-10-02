import { fuseObservations } from './multiSourceFusion.js';
export const ARGUS_NEXUS_QUERY_CONTRACT_ID = 'argus-nexus-verified-query-v0.1';

const OPERATIONS = new Set(['current', 'history', 'query', 'near', 'fusion']);

function requireObject(value, field) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  return value;
}

function normalizeRequest(request) {
  requireObject(request, 'request');
  const operation = String(request.operation ?? '')
    .trim()
    .toLowerCase();
  if (!OPERATIONS.has(operation)) {
    throw new TypeError(
      "operation must be 'current', 'history', 'query', 'near', or 'fusion'",
    );
  }
  return { ...structuredClone(request), operation };
}

function validateWorld(world) {
  if (!world || typeof world !== 'object') {
    throw new TypeError('ARGUS world query engine is required');
  }
  for (const method of ['get', 'history', 'query', 'near']) {
    if (typeof world[method] !== 'function') {
      throw new TypeError(`world.${method}() is required`);
    }
  }
  if (typeof world.repository?.getIngestionRun !== 'function') {
    throw new TypeError('world.repository.getIngestionRun() is required');
  }
  return world;
}

function validateEvidence(evidence) {
  requireObject(evidence, 'result.evidence');
  for (const field of [
    'provider_ids',
    'observation_ids',
    'ingestion_run_ids',
    'source_artifact_ids',
    'source_urls',
    'canonical_validity',
    'supersessions',
    'conflicts',
  ]) {
    if (!Array.isArray(evidence[field])) {
      throw new TypeError(`result.evidence.${field} must be an array`);
    }
  }
  requireObject(evidence.timestamps, 'result.evidence.timestamps');
  const conflictCount = Number(evidence.conflict_count);
  if (
    !Number.isInteger(conflictCount) ||
    conflictCount !== evidence.conflicts.length
  ) {
    throw new TypeError(
      'result.evidence.conflict_count must match conflicts.length',
    );
  }
  if (
    evidence.staleness_seconds != null &&
    (!Number.isFinite(Number(evidence.staleness_seconds)) ||
      Number(evidence.staleness_seconds) < 0)
  ) {
    throw new TypeError(
      'result.evidence.staleness_seconds must be null or non-negative',
    );
  }
  return structuredClone(evidence);
}

function summarizeRun(run, ingestionRunId) {
  if (!run) {
    return {
      ingestion_run_id: ingestionRunId,
      provider_id: null,
      status: 'UNKNOWN',
      degraded: null,
      started_at: null,
      completed_at: null,
      last_normal_observation_at: null,
      retry_count: null,
      error: null,
    };
  }
  const metadata = run.metadata ?? {};
  const degraded =
    typeof metadata.degraded === 'boolean'
      ? metadata.degraded
      : run.status === 'FAILED'
        ? true
        : run.status === 'SUCCEEDED'
          ? false
          : null;
  return {
    ingestion_run_id: run.ingestion_run_id ?? ingestionRunId,
    provider_id: run.provider_id ?? null,
    status: run.status ?? 'UNKNOWN',
    degraded,
    started_at: run.started_at ?? null,
    completed_at: run.completed_at ?? null,
    last_normal_observation_at: metadata.last_normal_observation_at ?? null,
    retry_count: metadata.retry_count ?? null,
    error: metadata.error ?? null,
  };
}

function providerRunState(run) {
  if (!run) return 'UNKNOWN';
  if (run.status === 'FAILED' || run.status === 'CANCELLED') {
    return 'PROVIDER_FAILURE';
  }
  if (run.status === 'PARTIAL') return 'PARTIAL';
  if (run.status === 'RUNNING') return 'RUNNING';
  if (run.status === 'SUCCEEDED') {
    if (Number(run.metadata?.stale_count) > 0) return 'STALE';
    const accepted = Number(run.records_accepted ?? 0);
    const duplicates = Number(run.metadata?.duplicates ?? 0);
    const lastNormal = run.metadata?.last_normal_observation_at ?? null;
    if (accepted === 0 && duplicates === 0 && !lastNormal) return 'NO_DATA';
    return 'OK';
  }
  return 'UNKNOWN';
}

async function requestedProviderHealth(world, providerIds) {
  if (!Array.isArray(providerIds) || providerIds.length === 0) return [];
  const unique = [...new Set(providerIds.map(String))].filter(Boolean);
  return Promise.all(
    unique.map(async (providerId) => {
      try {
        const run =
          await world.repository.getLatestIngestionRunForProvider(providerId);
        return {
          provider_id: providerId,
          state: providerRunState(run),
          run: summarizeRun(run, run?.ingestion_run_id ?? null),
        };
      } catch (error) {
        return {
          provider_id: providerId,
          state: 'UNKNOWN',
          run: {
            ingestion_run_id: null,
            provider_id: providerId,
            status: 'UNKNOWN',
            degraded: null,
            started_at: null,
            completed_at: null,
            last_normal_observation_at: null,
            retry_count: null,
            error: {
              name: error?.name ?? 'Error',
              message: error?.message ?? String(error),
            },
          },
        };
      }
    }),
  );
}

async function referencedRunHealth(world, evidence) {
  const runs = [];
  for (const ingestionRunId of evidence.ingestion_run_ids) {
    try {
      const run = await world.repository.getIngestionRun(ingestionRunId);
      runs.push(summarizeRun(run, ingestionRunId));
    } catch (error) {
      runs.push({
        ingestion_run_id: ingestionRunId,
        provider_id: null,
        status: 'UNKNOWN',
        degraded: null,
        started_at: null,
        completed_at: null,
        last_normal_observation_at: null,
        retry_count: null,
        error: {
          name: error?.name ?? 'Error',
          message: error?.message ?? String(error),
        },
      });
    }
  }

  let degraded = null;
  if (runs.some((run) => run.degraded === true)) {
    degraded = true;
  } else if (runs.length > 0 && runs.every((run) => run.degraded === false)) {
    degraded = false;
  }

  return {
    degraded,
    basis: 'referenced_ingestion_runs',
    ingestion_runs: runs,
  };
}

function queryOptions(request) {
  return {
    observation_type: request.observation_type ?? null,
    time_basis: request.time_basis,
    limit: request.limit,
    order: request.order,
  };
}

function validateFusionRequest(request) {
  const area = request.area ?? request.bbox;
  if (!Array.isArray(area) || area.length !== 4 ||
      area.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new TypeError('fusion requires a finite WGS84 area [west,south,east,north]');
  }
  const [west, south, east, north] = area;
  if (Math.abs(west) > 180 || Math.abs(east) > 180 ||
      Math.abs(south) > 90 || Math.abs(north) > 90 || south > north) {
    throw new RangeError('fusion area coordinates are out of bounds');
  }
  if (!Array.isArray(request.provider_ids) ||
      request.provider_ids.length === 0 ||
      request.provider_ids.length > 12 ||
      request.provider_ids.some((id) => typeof id !== 'string' || !id.trim())) {
    throw new TypeError('fusion requires 1-12 explicit provider_ids');
  }
  const time = request.time;
  const zoned = (value) => typeof value === 'string' &&
    /(?:Z|[+-]\\d{2}:\\d{2})$/i.test(value) &&
    Number.isFinite(Date.parse(value));
  if (!time || !zoned(time.start) || !zoned(time.end)) {
    throw new TypeError('fusion requires explicit timezone-aware start/end');
  }
  const duration = Date.parse(time.end) - Date.parse(time.start);
  if (duration < 0 || duration > 7 * 86400 * 1000) {
    throw new RangeError('fusion time range must be 0-7 days');
  }
  const limit = request.limit == null ? 100 : request.limit;
  if (!Number.isInteger(limit) || limit < 1 || limit > 150) {
    throw new RangeError('fusion limit must be between 1 and 150');
  }
  if (request.time_basis != null && request.time_basis !== 'observed') {
    throw new TypeError('fusion requires observed-time basis');
  }
  return {
    area,
    regions: west <= east ? [area] : [
      [west, south, 180, north], [-180, south, east, north],
    ],
    time: {
      start: new Date(time.start).toISOString(),
      end: new Date(time.end).toISOString(),
    },
    limit,
  };
}

function combineFusionQueryParts(parts, requestedArea) {
  if (parts.length === 1) return parts[0];
  const observations = [];
  const ids = new Set();
  for (const part of parts) {
    validateEvidence(part.evidence);
    if (!Array.isArray(part.observations) || part.mode !== 'history') {
      throw new TypeError('fusion requires observed-range World Memory output');
    }
    for (const observation of part.observations) {
      const key = observation.observation_id ??
        JSON.stringify([observation.provider_id, observation.entity_id,
          observation.timestamp_observed, observation.geometry]);
      if (ids.has(key)) continue;
      ids.add(key);
      observations.push(observation);
    }
  }
  observations.sort((a, b) =>
    Date.parse(a.timestamp_observed) - Date.parse(b.timestamp_observed),
  );
  const unique = (key) => [
    ...new Set(parts.flatMap((part) => part.evidence[key])),
  ];
  const bounds = (key) => {
    const min = parts.map((part) => part.evidence.timestamps[key]?.min)
      .filter(Boolean).sort();
    const max = parts.map((part) => part.evidence.timestamps[key]?.max)
      .filter(Boolean).sort();
    return { min: min[0] ?? null, max: max.at(-1) ?? null };
  };
  const objectUnion = (key) => [
    ...new Map(parts.flatMap((part) => part.evidence[key])
      .map((row) => [JSON.stringify(row), row])).values(),
  ];
  const conflicts = objectUnion('conflicts');
  const evidence = {
    provider_ids: unique('provider_ids'),
    observation_ids: unique('observation_ids'),
    ingestion_run_ids: unique('ingestion_run_ids'),
    source_artifact_ids: unique('source_artifact_ids'),
    source_urls: unique('source_urls'),
    canonical_validity: objectUnion('canonical_validity'),
    supersessions: objectUnion('supersessions'),
    conflicts,
    conflict_count: conflicts.length,
    timestamps: {
      observed: bounds('observed'),
      effective: bounds('effective'),
      received: bounds('received'),
      ingested: bounds('ingested'),
    },
    staleness_seconds: Math.max(
      0, ...parts.map((part) =>
        Number(part.evidence.staleness_seconds ?? 0)),
    ),
  };
  return {
    ...parts[0], area: requestedArea, observations,
    count: observations.length, evidence,
  };
}

export function createNexusVerifiedQueryAdapter({
  world,
  now = () => new Date(),
} = {}) {
  const argus = validateWorld(world);

  async function execute(input) {
    const request = normalizeRequest(input);
    let data;
    let fusionWindow = null;
    if (request.operation === 'fusion') {
      fusionWindow = validateFusionRequest(request);
      const parts = await Promise.all(
        fusionWindow.regions.map((area) => argus.query({
          area,
          time: fusionWindow.time,
          type: request.type ?? request.entity_type ?? null,
          observation_type: request.observation_type ?? null,
          provider_ids: request.provider_ids,
          time_basis: 'observed',
          order: 'asc',
          limit: fusionWindow.limit,
        })),
      );
      data = combineFusionQueryParts(parts, fusionWindow.area);
      if (data.mode !== 'history' || !Array.isArray(data.observations)) {
        throw new TypeError('fusion requires observed-range World Memory output');
      }
    } else if (request.operation === 'current') {
      data = await argus.get(
        request.identity,
        request.at ?? null,
        queryOptions(request),
      );
    } else if (request.operation === 'history') {
      data = await argus.history(
        request.identity,
        request.start ?? null,
        request.end ?? null,
        queryOptions(request),
      );
    } else if (request.operation === 'query') {
      data = await argus.query({
        area: request.area ?? request.bbox ?? null,
        time: request.time ?? null,
        type: request.type ?? request.entity_type ?? null,
        provider_ids: request.provider_ids,
        observation_type: request.observation_type ?? null,
        time_basis: request.time_basis,
        limit: request.limit,
        order: request.order,
      });
    } else {
      data = await argus.near({
        point: request.point ?? request.center,
        radius_km: request.radius_km,
        time: request.time ?? null,
        type: request.type ?? request.entity_type ?? null,
        provider_ids: request.provider_ids,
        observation_type: request.observation_type ?? null,
        time_basis: request.time_basis,
        limit: request.limit,
      });
    }

    requireObject(data, 'ARGUS query result');
    const evidence = validateEvidence(data.evidence);
    const [referencedHealth, requestedProviders] = await Promise.all([
      referencedRunHealth(argus, evidence),
      requestedProviderHealth(
        argus,
        request.provider_ids ?? request.identity?.provider_ids,
      ),
    ]);
    const requestedDegraded = requestedProviders.some((provider) =>
      ['PROVIDER_FAILURE', 'PARTIAL', 'UNKNOWN'].includes(provider.state),
    );
    const health = {
      ...referencedHealth,
      requested_providers: requestedProviders,
      partial_failure: requestedDegraded,
      degraded:
        referencedHealth.degraded === true || requestedDegraded
          ? true
          : referencedHealth.degraded,
    };

    let fusion = null;
    if (fusionWindow) {
      const incomplete = data.observations.length >=
        fusionWindow.limit * fusionWindow.regions.length;
      fusion = fuseObservations(data.observations, {
        now: now(),
        providerHealth: requestedProviders,
        maxDistanceKm: request.max_distance_km ?? 5,
        maxTimeDeltaSeconds: request.max_time_delta_seconds ?? 300,
        staleAfterSeconds: request.stale_after_seconds ?? 900,
      });
      fusion.query_window = {
        area: fusionWindow.area,
        time: fusionWindow.time,
        time_basis: 'observed',
      };
      fusion.possibly_truncated = incomplete;
      if (incomplete || requestedDegraded) {
        if (fusion.status !== 'CONFLICT') fusion.status = 'INSUFFICIENT_EVIDENCE';
      }
    }

    return {
      contract_id: ARGUS_NEXUS_QUERY_CONTRACT_ID,
      operation: request.operation,
      verified: true,
      data: structuredClone(data),
      evidence,
      health,
      ...(fusion ? { fusion } : {}),
    };
  }

  return Object.freeze({ execute });
}
