import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createInMemoryWorldMemoryRepository,
  createObservationEnvelope,
  createWorldMemoryQueryEngine,
} from '../index.js';

const CANONICAL_ID = '00000000-0000-4000-8000-00000000c301';

function observation({
  id,
  providerId = 'provider-a',
  entityId = 'asset-1',
  observedAt,
  effectiveAt = observedAt,
  ingestedAt = observedAt,
  coordinates = [126.9, 37.5],
  value,
  canonicalEntityId = CANONICAL_ID,
  supersedesObservationId = null,
  validFrom = '2026-09-28T00:00:00Z',
  validTo = '2026-09-28T00:30:00Z',
}) {
  return createObservationEnvelope({
    observation_id: id,
    provider_id: providerId,
    entity_type: 'asset',
    entity_id: entityId,
    canonical_entity_id: canonicalEntityId,
    canonical_entity_valid_from: canonicalEntityId ? validFrom : null,
    canonical_entity_valid_to: canonicalEntityId ? validTo : null,
    observation_type: 'state',
    timestamp_observed: observedAt,
    effective_at: effectiveAt,
    timestamp_received: observedAt,
    ingested_at: ingestedAt,
    geometry: coordinates ? { type: 'Point', coordinates } : null,
    properties: { value },
    source_url: 'https://example.test/' + providerId + '/' + entityId,
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: false,
    retention_policy: 'test-only',
    rate_limit_class: 'test',
    ingestion_run_id: 'memory-query-' + providerId,
    supersedes_observation_id: supersedesObservationId,
  });
}

async function fixture() {
  const repository = createInMemoryWorldMemoryRepository({
    now: () => new Date('2026-09-28T00:20:00Z'),
  });

  await repository.appendObservations([
    observation({
      id: 'obs-t1',
      observedAt: '2026-09-28T00:00:00Z',
      ingestedAt: '2026-09-28T00:00:30Z',
      value: 1,
      coordinates: [126.9005, 37.5],
    }),
    observation({
      id: 'obs-t2',
      observedAt: '2026-09-28T00:06:00Z',
      effectiveAt: '2026-09-28T00:05:00Z',
      ingestedAt: '2026-09-28T00:06:30Z',
      value: 2,
      coordinates: [127.5, 37.5],
      supersedesObservationId: 'obs-t1',
    }),
    observation({
      id: 'obs-t3-correction',
      observedAt: '2026-09-28T00:10:00Z',
      effectiveAt: '2026-09-28T00:05:00Z',
      ingestedAt: '2026-09-28T00:10:30Z',
      value: 3,
      coordinates: [127.5, 37.5],
      supersedesObservationId: 'obs-t2',
    }),
    observation({
      id: 'obs-provider-b',
      providerId: 'provider-b',
      observedAt: '2026-09-28T00:07:00Z',
      effectiveAt: '2026-09-28T00:05:00Z',
      ingestedAt: '2026-09-28T00:07:30Z',
      value: 99,
      coordinates: [126.91, 37.5],
    }),
    observation({
      id: 'obs-unlinked-same-provider-id',
      providerId: 'provider-c',
      observedAt: '2026-09-28T00:04:00Z',
      ingestedAt: '2026-09-28T00:04:30Z',
      value: 77,
      coordinates: [126.906, 37.5],
      canonicalEntityId: null,
    }),
    observation({
      id: 'obs-asset-2',
      entityId: 'asset-2',
      canonicalEntityId: null,
      observedAt: '2026-09-28T00:04:00Z',
      ingestedAt: '2026-09-28T00:04:30Z',
      value: 8,
      coordinates: [126.905, 37.5],
    }),
  ]);

  return {
    repository,
    world: createWorldMemoryQueryEngine({
      repository,
      now: () => new Date('2026-09-28T00:20:00Z'),
    }),
  };
}

test('world.get reconstructs T1 T2 T3 without future-ingestion leakage', async () => {
  const { world } = await fixture();

  const t1 = await world.get(
    {
      entity_type: 'asset',
      entity_id: 'asset-1',
      provider_ids: ['provider-a'],
    },
    '2026-09-28T00:04:59Z',
  );
  assert.equal(t1.state.properties.value, 1);

  const t2 = await world.get(
    {
      entity_type: 'asset',
      entity_id: 'asset-1',
      provider_ids: ['provider-a'],
    },
    '2026-09-28T00:07:00Z',
  );
  assert.equal(t2.state.properties.value, 2);
  assert.equal(
    t2.evidence.observation_ids.includes('obs-t3-correction'),
    false,
  );

  const current = await world.get({
    entity_type: 'asset',
    entity_id: 'asset-1',
    provider_ids: ['provider-a'],
  });
  assert.equal(current.state.properties.value, 3);
  assert.deepEqual(current.evidence.supersessions, [
    {
      observation_id: 'obs-t3-correction',
      supersedes_observation_id: 'obs-t2',
    },
  ]);
});

test('world.history returns ordered evidence and preserves provenance', async () => {
  const { world } = await fixture();
  const history = await world.history(
    {
      entity_type: 'asset',
      entity_id: 'asset-1',
      provider_ids: ['provider-a'],
    },
    '2026-09-28T00:00:00Z',
    '2026-09-28T00:12:00Z',
  );

  assert.deepEqual(
    history.observations.map((item) => item.properties.value),
    [1, 2, 3],
  );
  assert.deepEqual(history.evidence.provider_ids, ['provider-a']);
  assert.deepEqual(history.evidence.observation_ids, [
    'obs-t1',
    'obs-t2',
    'obs-t3-correction',
  ]);
  assert.deepEqual(history.evidence.source_urls, [
    'https://example.test/provider-a/asset-1',
  ]);
  assert.equal(
    history.evidence.timestamps.ingested.max,
    '2026-09-28T00:10:30.000Z',
  );
});

test('provider-scoped identity never merges providers without canonical link', async () => {
  const { world } = await fixture();

  const providerA = await world.get({
    entity_type: 'asset',
    entity_id: 'asset-1',
    provider_ids: ['provider-a'],
  });
  assert.deepEqual(providerA.evidence.provider_ids, ['provider-a']);
  assert.equal(providerA.states.length, 1);

  const unlinked = await world.get({
    entity_type: 'asset',
    entity_id: 'asset-1',
    provider_ids: ['provider-c'],
  });
  assert.equal(unlinked.state.properties.value, 77);

  const canonical = await world.get(CANONICAL_ID, '2026-09-28T00:09:00Z');
  assert.deepEqual(canonical.states.map((item) => item.provider_id).sort(), [
    'provider-a',
    'provider-b',
  ]);
  assert.equal(canonical.evidence.conflict_count, 1);
  assert.equal(
    canonical.evidence.canonical_validity[0].valid_from != null,
    true,
  );
  assert.equal(canonical.evidence.canonical_validity[0].valid_to != null, true);
});

test('canonical validity bounds point-in-time reconstruction', async () => {
  const { world } = await fixture();
  const expired = await world.get(CANONICAL_ID, '2026-09-28T00:31:00Z');
  assert.equal(expired.found, false);
  assert.deepEqual(expired.states, []);
});

test('world.query combines temporal replay with spatial filtering', async () => {
  const { world } = await fixture();

  const t1Area = await world.query(
    [126.8, 37.4, 127.0, 37.6],
    '2026-09-28T00:04:59Z',
    'asset',
  );
  assert.deepEqual(
    t1Area.states.map((item) => item.properties.value).sort((a, b) => a - b),
    [1, 8, 77],
  );

  const t2Area = await world.query(
    [126.8, 37.4, 127.0, 37.6],
    '2026-09-28T00:09:00Z',
    'asset',
  );
  assert.deepEqual(
    t2Area.states.map((item) => item.properties.value).sort((a, b) => a - b),
    [8, 77, 99],
  );
  assert.equal(
    t2Area.evidence.observation_ids.includes('obs-t3-correction'),
    false,
  );
});

test('world.near combines radius and time and keeps evidence', async () => {
  const { world } = await fixture();

  const t1 = await world.near([126.9, 37.5], 2, '2026-09-28T00:04:59Z');
  assert.deepEqual(
    t1.results
      .map((item) => item.observation.properties.value)
      .sort((a, b) => a - b),
    [1, 8, 77],
  );

  const t2 = await world.near([126.9, 37.5], 2, '2026-09-28T00:09:00Z');
  assert.deepEqual(
    t2.results
      .map((item) => item.observation.properties.value)
      .sort((a, b) => a - b),
    [8, 77, 99],
  );
  assert.equal(t2.evidence.provider_ids.includes('provider-b'), true);
  assert.equal(t2.evidence.observation_ids.includes('obs-provider-b'), true);
});

test('ingested time is an explicit query basis', async () => {
  const { world } = await fixture();
  const history = await world.history(
    {
      entity_type: 'asset',
      entity_id: 'asset-1',
      provider_ids: ['provider-a'],
    },
    '2026-09-28T00:06:00Z',
    '2026-09-28T00:11:00Z',
    { time_basis: 'ingested' },
  );

  assert.deepEqual(
    history.observations.map((item) => item.properties.value),
    [2, 3],
  );
});

test('temporal and spatial boundary cases are explicit', async () => {
  const { world } = await fixture();

  const empty = await world.query({
    area: [10, 10, 11, 11],
    time: '2026-09-28T00:09:00Z',
    type: 'asset',
  });
  assert.equal(empty.count, 0);
  assert.deepEqual(empty.states, []);

  await assert.rejects(
    world.history(
      {
        entity_type: 'asset',
        entity_id: 'asset-1',
      },
      '2026-09-28T00:10:00Z',
      '2026-09-28T00:01:00Z',
    ),
    /start must not be after end/,
  );

  await assert.rejects(
    world.near({
      point: [126.9, 37.5],
      radius_km: -1,
      time: '2026-09-28T00:09:00Z',
    }),
    /radius_km/,
  );

  await assert.rejects(
    world.get('asset-1'),
    /canonical_entity_id must be a UUID/,
  );
});
