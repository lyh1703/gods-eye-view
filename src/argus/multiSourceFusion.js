import {
  haversineDistanceKm,
  pointCoordinates,
} from './worldOperations.js';

// A bounded, read-only evidence comparison. It is NOT an entity linker or
// causal/event identity inference engine.
export const ARGUS_FUSION_CONTRACT_ID = 'argus-multi-source-fusion-v0.1';

function validUtcTimestamp(value) {
  if (
    typeof value !== 'string' ||
    !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    return null;
  }
  return Date.parse(value);
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 256)
    : null;
}

function coordinate(observation) {
  const geometry = observation?.geometry;
  if (geometry?.type !== 'Point') return null;
  const pair = geometry.coordinates;
  if (
    !Array.isArray(pair) ||
    pair.length < 2 ||
    pair[0] == null ||
    pair[1] == null ||
    typeof pair[0] === 'boolean' ||
    typeof pair[1] === 'boolean'
  ) {
    return null;
  }
  return pointCoordinates(observation);
}

function horizontalAccuracyKm(observation) {
  const properties = observation?.properties ?? {};
  for (const key of [
    'location_accuracy_m',
    'position_accuracy_m',
    'spatial_resolution_m',
  ]) {
    const value = properties[key];
    if (value === null || value === undefined || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number / 1000;
  }
  return null;
}

function provenance(observation) {
  const properties = observation?.properties ?? {};
  const origin = nonEmpty(properties.original_source_id) ||
    nonEmpty(properties.source_origin_id) ||
    nonEmpty(properties.upstream_source_id);
  if (origin) return { key: `declared:${origin}`, basis: 'declared-origin-id' };
  try {
    const url = new URL(observation?.source_url);
    if (url.protocol !== 'https:') return { key: null, basis: 'unverified' };
    return {
      key: `endpoint:${url.origin.toLowerCase()}${url.pathname}`,
      basis: 'source-endpoint-only',
    };
  } catch {
    return { key: null, basis: 'unverified' };
  }
}

function reference(record) {
  return {
    observation_id: record.observation.observation_id ?? null,
    provider_id: record.observation.provider_id,
    entity_id: record.observation.entity_id,
    timestamp_observed: record.observation.timestamp_observed,
    timestamp_received: record.observation.timestamp_received,
    source_url: record.observation.source_url,
    origin_key: record.origin.key,
    origin_basis: record.origin.basis,
    stale: record.stale,
    coordinate_precision_km: record.accuracyKm,
    point: record.point,
  };
}

function claimConflict(left, right) {
  const a = left.observation.properties?.fusion_claim;
  const b = right.observation.properties?.fusion_claim;
  if (
    !a || !b || typeof a !== 'object' || typeof b !== 'object' ||
    !nonEmpty(a.kind) || a.kind !== b.kind ||
    a.value === undefined || b.value === undefined
  ) return false;
  // Compare only an explicitly matching measurement kind, never unrelated
  // arbitrary provider-specific properties (such as radio codec vs route ID).
  return JSON.stringify(a.value) !== JSON.stringify(b.value);
}

function comparison(left, right, { maxDistanceKm, maxTimeDeltaSeconds }) {
  if (
    left.observation.entity_type !== right.observation.entity_type ||
    left.observation.observation_type !== right.observation.observation_type
  ) return null;
  if (left.observation.provider_id === right.observation.provider_id)
    return null;

  const sameCanonical = nonEmpty(left.observation.canonical_entity_id) &&
    left.observation.canonical_entity_id === right.observation.canonical_entity_id;
  const differentCanonical =
    nonEmpty(left.observation.canonical_entity_id) &&
    nonEmpty(right.observation.canonical_entity_id) &&
    !sameCanonical;
  if (differentCanonical) return null;

  const seconds = Math.abs(left.observedMs - right.observedMs) / 1000;
  if (seconds > maxTimeDeltaSeconds) return null;
  const distance = left.point && right.point
    ? haversineDistanceKm(left.point, right.point)
    : null;
  if (!sameCanonical && (distance == null || distance > maxDistanceKm))
    return null;

  const sameOrigin = left.origin.key && left.origin.key === right.origin.key;
  const independence =
    sameOrigin ? 'SAME_UPSTREAM'
      : left.origin.basis === 'declared-origin-id' &&
          right.origin.basis === 'declared-origin-id'
        ? 'DISTINCT_DECLARED_ORIGINS'
        : 'UNVERIFIED';

  const accuracySum = left.accuracyKm != null && right.accuracyKm != null
    ? left.accuracyKm + right.accuracyKm
    : null;
  const precisionUnknown = accuracySum == null;
  const spatialAmbiguous = accuracySum != null &&
    accuracySum > maxDistanceKm;
  const locationConflict = sameCanonical &&
    distance != null && accuracySum != null &&
    distance > maxDistanceKm + accuracySum;
  const conflictingClaim = sameCanonical && claimConflict(left, right);
  let status = 'PROXIMITY_ONLY';
  if (sameCanonical) {
    if (locationConflict || conflictingClaim) status = 'CONFLICT';
    else if (sameOrigin) status = 'SAME_UPSTREAM';
    else if (left.stale || right.stale) status = 'STALE_COMPARISON';
    else if (distance == null || precisionUnknown || spatialAmbiguous ||
      independence !== 'DISTINCT_DECLARED_ORIGINS') {
      status = 'INSUFFICIENT_EVIDENCE';
    } else if (distance <= maxDistanceKm + accuracySum) {
      status = 'CONSISTENT_REPORTS';
    } else {
      status = 'INSUFFICIENT_EVIDENCE';
    }
  } else if (sameOrigin) {
    status = 'SAME_UPSTREAM';
  }
  return {
    status,
    identity_basis: sameCanonical
      ? 'shared-canonical-entity-id' : 'spatiotemporal-proximity-only',
    independence,
    temporal_delta_seconds: seconds,
    distance_km: distance,
    combined_accuracy_km: accuracySum,
    coordinate_precision_unknown: precisionUnknown,
    location_conflict: Boolean(locationConflict),
    claim_conflict: Boolean(conflictingClaim),
    left: reference(left),
    right: reference(right),
    causal_relationship_verified: false,
    event_identity_verified: false,
  };
}

export function fuseObservations(observations, {
  now = new Date(),
  maxDistanceKm = 5,
  maxTimeDeltaSeconds = 300,
  staleAfterSeconds = 900,
  providerHealth = [],
} = {}) {
  if (!Array.isArray(observations) || observations.length > 300)
    throw new RangeError('fusion requires at most 300 observations');
  const clock = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(clock)) throw new TypeError('invalid fusion clock');
  for (const [name, value, ceiling] of [
    ['maxDistanceKm', maxDistanceKm, 100],
    ['maxTimeDeltaSeconds', maxTimeDeltaSeconds, 3600],
    ['staleAfterSeconds', staleAfterSeconds, 604800],
  ]) {
    if (!Number.isFinite(value) || value < 0 || value > ceiling)
      throw new RangeError(`${name} exceeds bounded fusion policy`);
  }
  const accepted = [];
  const excluded = [];
  const seen = new Set();
  let duplicateCount = 0;

  for (const observation of observations) {
    const observedMs = validUtcTimestamp(observation?.timestamp_observed);
    const receivedMs = validUtcTimestamp(observation?.timestamp_received);
    const id = nonEmpty(observation?.entity_id);
    const provider = nonEmpty(observation?.provider_id);
    const type = nonEmpty(observation?.entity_type);
    const observationType = nonEmpty(observation?.observation_type);
    if (
      !id || !provider || !type || !observationType ||
      observedMs == null || receivedMs == null
    ) {
      excluded.push({
        observation_id: observation?.observation_id ?? null,
        reason: 'INVALID_IDENTITY_OR_UTC_TIME',
      });
      continue;
    }
    if (observedMs > receivedMs + 300_000 || observedMs > clock + 300_000) {
      excluded.push({
        observation_id: observation?.observation_id ?? null,
        reason: 'FUTURE_OBSERVATION_CLOCK_SKEW',
      });
      continue;
    }
    const point = coordinate(observation);
    if (observation.geometry?.type === 'Point' && !point) {
      excluded.push({
        observation_id: observation?.observation_id ?? null,
        reason: 'INVALID_COORDINATES',
      });
      continue;
    }
    const key = JSON.stringify([
      provider, id, observationType, observedMs,
      point, observation.content_hash ?? null,
    ]);
    if (seen.has(key)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(key);
    const age = Math.max(0, (clock - observedMs) / 1000);
    accepted.push({
      observation, point, observedMs, receivedMs,
      origin: provenance(observation),
      accuracyKm: horizontalAccuracyKm(observation),
      stale: age > staleAfterSeconds,
    });
  }

  accepted.sort((a, b) =>
    a.observedMs - b.observedMs ||
    String(a.observation.provider_id).localeCompare(
      String(b.observation.provider_id),
    ),
  );
  const comparisons = [];
  for (let index = 0; index < accepted.length; index += 1) {
    for (let other = index + 1; other < accepted.length; other += 1) {
      const result = comparison(accepted[index], accepted[other], {
        maxDistanceKm, maxTimeDeltaSeconds,
      });
      if (result) comparisons.push(result);
    }
  }
  const statuses = [
    'CONSISTENT_REPORTS', 'CONFLICT', 'PROXIMITY_ONLY',
    'SAME_UPSTREAM', 'STALE_COMPARISON', 'INSUFFICIENT_EVIDENCE',
  ];
  const counts = Object.fromEntries(statuses.map((s) => [
    s, comparisons.filter((c) => c.status === s).length,
  ]));
  const providerStates = providerHealth.map(({ provider_id, state }) => ({
    provider_id, state,
  }));
  const failed = providerStates.filter(({ state }) =>
    ['UNKNOWN', 'PARTIAL', 'PROVIDER_FAILURE', 'RUNNING'].includes(state),
  );
  const status = counts.CONFLICT > 0
    ? 'CONFLICT'
    : counts.CONSISTENT_REPORTS > 0 && failed.length === 0
      ? 'CONSISTENT_REPORTS'
      : 'INSUFFICIENT_EVIDENCE';
  return {
    contract_id: ARGUS_FUSION_CONTRACT_ID,
    status,
    analysis_as_of: new Date(clock).toISOString(),
    causal_relationship_verified: false,
    event_identity_verified: false,
    independent_sources_proven: false,
    summary: {
      input_count: observations.length,
      accepted_count: accepted.length,
      exact_duplicate_count: duplicateCount,
      excluded_count: excluded.length,
      stale_count: accepted.filter((r) => r.stale).length,
      coordinate_missing_count: accepted.filter((r) => !r.point).length,
      delayed_receipt_count: accepted.filter((r) =>
        r.receivedMs - r.observedMs > staleAfterSeconds * 1000).length,
      comparison_count: comparisons.length,
      comparison_statuses: counts,
      incomplete_provider_count: failed.length,
    },
    observations: accepted.map((r) => reference(r)),
    comparisons,
    excluded,
    provider_reliability: providerStates,
    validation_steps: [
      'utc-observed-vs-received',
      'coordinate-bounds-and-precision',
      'provider-scoped-repeat-deduplication',
      'haversine-spatiotemporal-comparison',
      'declared-lineage-reuse-detection',
      'explicit-claim-conflict-only',
      'requested-provider-ingestion-health',
    ],
    unverified: [
      'physical event identity and causal linkage',
      'independence beyond explicit upstream lineage declarations',
      'source precision where accuracy metadata is absent',
      'live CCTV frames and radio audio availability',
    ],
  };
}
