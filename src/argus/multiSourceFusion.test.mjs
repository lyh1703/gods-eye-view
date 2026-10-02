import assert from 'node:assert/strict';
import test from 'node:test';
import { performance } from 'node:perf_hooks';

import { createObservationEnvelope } from './observationEnvelope.js';
import { fuseObservations } from './multiSourceFusion.js';
import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createInMemoryWorldMemoryRepository } from './memory/repository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { USGS_EARTHQUAKES_PROVIDER } from './providers/usgsEarthquakes.js';

const NOW = '2026-10-03T00:00:00.000Z';
const CANONICAL = 'a2345678-1234-4234-8234-1234567890ab';
const source = (provider, id, {
  lon = 127.01, lat = 37.55, time = '2026-10-02T23:59:50.000Z',
  received = NOW, canonical = CANONICAL, origin = provider,
  accuracy = 150, claim = { kind: 'event-severity', value: 3 },
  geometry = null,
} = {}) => createObservationEnvelope({
  provider_id: provider,
  entity_type: 'earthquake',
  entity_id: id,
  observation_type: 'earthquake-event',
  timestamp_observed: time,
  timestamp_received: received,
  geometry: geometry ?? { type: 'Point', coordinates: [lon, lat] },
  canonical_entity_id: canonical,
  properties: {
    original_source_id: origin,
    location_accuracy_m: accuracy,
    ...(claim == null ? {} : { fusion_claim: claim }),
  },
  source_url: `https://${provider}.example.org/record/${id}`,
  license_class: 'fixture-only',
  retention_policy: 'test-only',
  rate_limit_class: 'mock',
  ingestion_run_id: `run-${provider}`,
});
const pair = (optionsA = {}, optionsB = {}) => [
  source('provider-a', 'one', optionsA),
  source('provider-b', 'two', optionsB),
];
const fuse = (observations, options = {}) =>
  fuseObservations(observations, { now: NOW, ...options });

test('same canonical ID and distinctly declared upstream origins give comparable reports, not proven event identity', () => {
  const result = fuse(pair());
  assert.equal(result.status, 'CONSISTENT_REPORTS');
  assert.equal(result.comparisons[0].status, 'CONSISTENT_REPORTS');
  assert.equal(result.comparisons[0].independence, 'DISTINCT_DECLARED_ORIGINS');
  assert.equal(result.event_identity_verified, false);
  assert.equal(result.independent_sources_proven, false);
  assert.equal(result.summary.comparison_count, 1);
});

test('relay of the same source does not become independent corroboration', () => {
  const result = fuse(pair({ origin: 'usgs-original' }, {
    origin: 'usgs-original',
  }));
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.comparisons[0].status, 'SAME_UPSTREAM');
  assert.equal(result.comparisons[0].independence, 'SAME_UPSTREAM');
});

test('explicit contradictory claim is preserved as CONFLICT without inventing causality', () => {
  const result = fuse(pair({}, { claim: { kind: 'event-severity', value: 7 } }));
  assert.equal(result.status, 'CONFLICT');
  assert.equal(result.comparisons[0].claim_conflict, true);
  assert.equal(result.comparisons[0].causal_relationship_verified, false);
});

test('only positional/time proximity never asserts event identity', () => {
  const result = fuse(pair({ canonical: null }, { canonical: null }));
  assert.equal(result.status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.comparisons[0].status, 'PROXIMITY_ONLY');
});

test('spatial precision missing/large fails closed rather than inflating confidence', () => {
  const unknown = fuse(pair({ accuracy: null }, { accuracy: null }));
  assert.equal(unknown.comparisons[0].status, 'INSUFFICIENT_EVIDENCE');
  assert.equal(unknown.comparisons[0].coordinate_precision_unknown, true);
  const vague = fuse(pair({ accuracy: 8000 }, { accuracy: 8000 }));
  assert.equal(vague.comparisons[0].status, 'INSUFFICIENT_EVIDENCE');
  const separated = fuse(pair({ accuracy: 10 }, {
    accuracy: 10, lon: 127.3,
  }));
  assert.equal(separated.comparisons[0].status, 'CONFLICT');
  assert.equal(separated.comparisons[0].location_conflict, true);
});

test('date line, observed-time conversion and delayed receipt are retained without false staleness', () => {
  const observations = pair(
    { lon: 179.99, lat: 0, time: '2026-10-02T23:59:50Z' },
    { lon: -179.99, lat: 0, time: '2026-10-03T08:59:55+09:00' },
  );
  const result = fuse(observations);
  assert.equal(result.comparisons[0].status, 'CONSISTENT_REPORTS');
  assert.ok(result.comparisons[0].distance_km < 5);
  assert.equal(result.comparisons[0].temporal_delta_seconds, 5);
  const late = fuse(pair({
    time: '2026-10-02T20:00:00Z', received: NOW,
  }), { staleAfterSeconds: 120 });
  assert.ok(late.summary.stale_count > 0);
  assert.ok(late.summary.delayed_receipt_count > 0);
});

test('future clock anomaly, no-timezone, invalid coordinate, missing geo, repeated records', () => {
  const observations = pair();
  const naive = { ...observations[0], timestamp_observed: '2026-10-02T23:59:50' };
  const bad = { ...observations[0], geometry: {
    type: 'Point', coordinates: [null, 37.5],
  } };
  const future = { ...observations[1], timestamp_observed: '2026-10-03T01:00:00Z' };
  const missing = { ...observations[0], entity_id: 'missing-geo', geometry: null };
  const result = fuse([
    ...observations, observations[0], naive, bad, future, missing,
  ]);
  assert.equal(result.summary.exact_duplicate_count, 1);
  assert.equal(result.summary.excluded_count, 3);
  assert.equal(result.summary.coordinate_missing_count, 1);
  assert.ok(result.excluded.some((x) => x.reason === 'FUTURE_OBSERVATION_CLOCK_SKEW'));
});

test('bounded memory and provider-health carry failure uncertainty', () => {
  assert.throws(() => fuse(Array(301).fill(pair()[0])), /at most 300/);
  const health = [{
    provider_id: 'provider-b', state: 'PROVIDER_FAILURE',
  }];
  const result = fuse(pair(), { providerHealth: health });
  assert.equal(result.summary.incomplete_provider_count, 1);
  assert.equal(result.provider_reliability[0].state, 'PROVIDER_FAILURE');
});

function mockProvider(providerId, observation) {
  return {
    metadata: {
      ...USGS_EARTHQUAKES_PROVIDER,
      provider_id: providerId,
      source_url: observation.source_url,
    },
    async query() { return [observation]; },
  };
}

test('in-memory World Memory observed-range → NEXUS fusion with source/clock evidence', async () => {
  const repository = createInMemoryWorldMemoryRepository({
    now: () => new Date(NOW),
  });
  let counter = 0;
  const ingestor = createExternalProviderIngestor({
    repository, now: () => new Date(NOW),
    uuid: () =>
      `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, '0')}`,
    maxAttempts: 1,
  });
  const observations = pair();
  for (let i = 0; i < observations.length; i++) {
    assert.equal((await ingestor.ingest(mockProvider(
      observations[i].provider_id, observations[i],
    ))).inserted, 1);
  }
  const nexus = createNexusVerifiedQueryAdapter({
    world: createWorldMemoryQueryEngine({
      repository, now: () => new Date(NOW),
    }),
    now: () => new Date(NOW),
  });
  const result = await nexus.execute({
    operation: 'fusion',
    provider_ids: ['provider-a', 'provider-b'],
    area: [126.9, 37.4, 127.2, 37.7],
    time: {
      start: '2026-10-02T23:50:00Z', end: NOW,
    },
    limit: 100,
  });
  assert.equal(result.verified, true);
  assert.equal(result.operation, 'fusion');
  assert.equal(result.fusion.status, 'CONSISTENT_REPORTS');
  assert.equal(result.data.mode, 'history');
  assert.equal(result.evidence.source_urls.length, 2);
  assert.ok(result.fusion.comparisons[0].left.timestamp_received);
  assert.equal(result.fusion.query_window.time_basis, 'observed');
  assert.equal(result.health.requested_providers.length, 2);
  assert.deepEqual(result.fusion.unverified.includes(
    'physical event identity and causal linkage',
  ), true);
  const duplicate = await ingestor.ingest(mockProvider(
    observations[0].provider_id, observations[0],
  ));
  assert.equal(duplicate.duplicates, 1);
});

test('fusion API rejects unbounded requests, timezone ambiguity and non-observed time basis', async () => {
  const calls = [];
  const world = {
    repository: {
      async getIngestionRun() { return null; },
      async getLatestIngestionRunForProvider() { return null; },
    },
    async get() { return {}; },
    async history() { return {}; },
    async query(v) { calls.push(v); return {}; },
    async near() { return {}; },
  };
  const nexus = createNexusVerifiedQueryAdapter({ world });
  const request = {
    operation: 'fusion', provider_ids: ['provider-a'],
    area: [126, 37, 128, 38],
    time: { start: '2026-10-02T00:00:00Z', end: NOW },
  };
  for (const invalid of [
    { time: { start: '2026-10-02T00:00:00', end: NOW } },
    { area: [181, 37, 183, 38] },
    { provider_ids: [] },
    { limit: 5000 },
    { time_basis: 'received' },
  ]) {
    await assert.rejects(() => nexus.execute({
      ...request, ...invalid,
    }));
  }
  assert.equal(calls.length, 0);
});

test('fixture-labeled precision recall false positives false negatives and measured execution latency', () => {
  const examples = [
    [pair(), true],
    [pair({ lon: 179.99, lat: 0 }, { lon: -179.99, lat: 0 }), true],
    [pair({}, { lon: 127.02 }), true],
    [pair({ origin: 'shared' }, { origin: 'shared' }), false],
    [pair({ canonical: null }, { canonical: null }), false],
    [pair({}, { claim: { kind: 'event-severity', value: 1 } }), false],
    [pair({}, { lon: 128, accuracy: 5 }), false],
  ];
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const start = performance.now();
  for (const [observations, expected] of examples) {
    const actual = fuse(observations).status === 'CONSISTENT_REPORTS';
    if (expected && actual) tp += 1;
    else if (!expected && actual) fp += 1;
    else if (expected) fn += 1;
    else tn += 1;
  }
  const elapsed = performance.now() - start;
  const precision = tp / (tp + fp || 1);
  const recall = tp / (tp + fn || 1);
  assert.deepEqual({ tp, fp, fn, tn }, { tp: 3, fp: 0, fn: 0, tn: 4 });
  console.info('ARGUS_FUSION_FIXTURE_BENCHMARK', JSON.stringify({
    corpus: 'seven deterministic labeled rule fixtures; not real-world accuracy',
    tp, fp, fn, tn, precision, recall,
    elapsed_ms: Number(elapsed.toFixed(3)),
    avg_ms: Number((elapsed / examples.length).toFixed(3)),
  }));
});
