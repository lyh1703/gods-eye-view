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
  coordinates = [126.9, 37.5],
  value,
  canonicalEntityId = CANONICAL_ID,
}) {
  return createObservationEnvelope({
    observation_id: id,
    provider_id: providerId,
    entity_type: 'asset',
    entity_id: entityId,
    canonical_entity_id: canonicalEntityId,
    observation_type: 'state',
    timestamp_observed: observedAt,
    effective_at: effectiveAt,
    timestamp_received: observedAt,
    geometry: coordinates ? { type: 'Point', coordinates } : null,
    properties: { value },
    source_url: 'https://example.test/' + providerId + '/' + entityId,
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: false,
    retention_policy: 'test-only',
    rate_limit_class: 'test',
    ingestion_run_id: 'memory-query-test',
  });
}

async function fixture() {
  const repository = createInMemoryWorldMemoryRepository({
    now: () => new Date('2026-09-28T00:20:00Z'),
  });
  await repository.appendObservations([
    observation({
      id: 'obs-1',
      observedAt: '2026-09-28T00:00:00Z',
      value: 1,
      coordinates: [126.9005, 37.5],
    }),
    observation({
      id: 'obs-2',
      observedAt: '2026-09-28T00:10:00Z',
      effectiveAt: '2026-09-28T00:05:00Z',
      value: 2,
      coordinates: [127.5, 37.5],
    }),
    observation({
      id: 'obs-3',
      providerId: 'provider-b',
      observedAt: '2026-09-28T00:09:00Z',
      value: 99,
      coordinates: [126.91, 37.5],
    }),
    observation({
      id: 'obs-4',
      entityId: 'asset-2',
      canonicalEntityId: null,
      observedAt: '2026-09-28T00:04:00Z',
      value: 8,
      coordinates: [126.905, 37.5],
    }),
  ]);

  return createWorldMemoryQueryEngine({
    repository,
    now: () => new Date('2026-09-28T00:20:00Z'),
  });
}

test('world.get reconstructs canonical point-in-time state using effective time', async () => {
  const world = await fixture();

  const beforeRevision = await world.get(CANONICAL_ID, '2026-09-28T00:04:59Z');
  assert.equal(beforeRevision.states.length, 1);
  assert.equal(beforeRevision.state.properties.value, 1);

  const afterRevision = await world.get(CANONICAL_ID, '2026-09-28T00:09:30Z');
  assert.equal(afterRevision.states.length, 2);
  assert.deepEqual(
    afterRevision.states.map((item) => item.properties.value),
    [99, 2],
  );
  assert.equal(afterRevision.evidence.conflict_count, 1);
});

test('world.history returns provider-scoped temporal evidence in requested range', async () => {
  const world = await fixture();
  const history = await world.history(
    {
      entity_type: 'asset',
      entity_id: 'asset-1',
      provider_ids: ['provider-a'],
    },
    '2026-09-28T00:00:00Z',
    '2026-09-28T00:06:00Z',
  );

  assert.deepEqual(
    history.observations.map((item) => item.properties.value),
    [1, 2],
  );
});

test('world.query distinguishes snapshot state from range history', async () => {
  const world = await fixture();

  const snapshot = await world.query(
    [126.8, 37.4, 128.0, 37.6],
    '2026-09-28T00:06:00Z',
    'asset',
  );
  assert.equal(snapshot.mode, 'snapshot');
  assert.deepEqual(
    snapshot.states.map((item) => item.properties.value),
    [2, 8],
  );

  const history = await world.query({
    area: [126.8, 37.4, 128.0, 37.6],
    type: 'asset',
    time: {
      start: '2026-09-28T00:00:00Z',
      end: '2026-09-28T00:06:00Z',
    },
    order: 'asc',
  });
  assert.equal(history.mode, 'history');
  assert.deepEqual(
    history.observations.map((item) => item.properties.value),
    [1, 8, 2],
  );
});

test('world.near uses the latest state at the requested point in time', async () => {
  const world = await fixture();

  const beforeMove = await world.near([126.9, 37.5], 2, '2026-09-28T00:04:59Z');
  assert.deepEqual(
    beforeMove.results.map((item) => item.observation.properties.value),
    [1, 8],
  );

  const afterMove = await world.near([126.9, 37.5], 2, '2026-09-28T00:06:00Z');
  assert.deepEqual(
    afterMove.results.map((item) => item.observation.properties.value),
    [8],
  );
});

test('world.get rejects ambiguous non-canonical shorthand IDs', async () => {
  const world = await fixture();
  await assert.rejects(
    world.get('asset-1'),
    /canonical_entity_id must be a UUID/,
  );
});
