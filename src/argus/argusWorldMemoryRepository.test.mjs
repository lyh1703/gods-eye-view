import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInMemoryWorldMemoryRepository,
  createObservationEnvelope,
  validateWorldMemoryRepository,
} from './index.js';

function observation({
  providerId = 'provider-a',
  entityId = 'asset-1',
  entityType = 'asset',
  observationType = 'position',
  observedAt,
  coordinates = [126.9, 37.5],
  value,
}) {
  return createObservationEnvelope({
    provider_id: providerId,
    entity_type: entityType,
    entity_id: entityId,
    observation_type: observationType,
    timestamp_observed: observedAt,
    timestamp_received: observedAt,
    geometry: coordinates
      ? { type: 'Point', coordinates }
      : null,
    properties: { value },
    source_url:
      'https://example.test/' + providerId + '/' + entityId,
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: false,
    retention_policy: 'test-only',
    rate_limit_class: 'test',
    ingestion_run_id: 'memory-test',
  });
}

test('World Memory repository contract rejects missing methods', () => {
  assert.throws(
    () =>
      validateWorldMemoryRepository({
        appendObservations() {},
      }),
    /queryObservations/,
  );
});

test('in-memory repository appends atomically and isolates stored values', async () => {
  const memory = createInMemoryWorldMemoryRepository({
    now: () => new Date('2026-09-25T00:03:00Z'),
  });

  const first = observation({
    observedAt: '2026-09-25T00:00:00Z',
    value: 1,
  });
  const second = observation({
    observedAt: '2026-09-25T00:01:00Z',
    value: 2,
  });

  const write = await memory.appendObservations([first, second]);
  assert.equal(write.inserted, 2);
  assert.equal(memory.observationCount(), 2);

  first.properties.value = 999;
  const stored = await memory.queryObservations({ order: 'asc' });
  assert.deepEqual(
    stored.map((item) => item.properties.value),
    [1, 2],
  );

  stored[0].properties.value = 777;
  const reread = await memory.queryObservations({ order: 'asc' });
  assert.equal(reread[0].properties.value, 1);

  const invalid = { ...second, provider_id: '' };
  await assert.rejects(
    memory.appendObservations([second, invalid]),
    /invalid observation/,
  );
  assert.equal(memory.observationCount(), 2);
});

test('entity history preserves provider-scoped identity and time filters', async () => {
  const memory = createInMemoryWorldMemoryRepository();

  await memory.appendObservations([
    observation({
      providerId: 'provider-a',
      observedAt: '2026-09-25T00:00:00Z',
      value: 1,
    }),
    observation({
      providerId: 'provider-b',
      observedAt: '2026-09-25T00:01:00Z',
      value: 2,
    }),
    observation({
      providerId: 'provider-a',
      observedAt: '2026-09-25T00:02:00Z',
      value: 3,
    }),
    observation({
      entityId: 'asset-2',
      observedAt: '2026-09-25T00:02:30Z',
      value: 99,
    }),
  ]);

  const history = await memory.getEntityHistory({
    entity_type: 'asset',
    provider_entity_id: 'asset-1',
    provider_ids: ['provider-a'],
    from: '2026-09-25T00:00:30Z',
    to: '2026-09-25T00:03:00Z',
  });

  assert.deepEqual(
    history.map((item) => item.properties.value),
    [3],
  );
});

test('queryObservations supports bbox and observation type filters', async () => {
  const memory = createInMemoryWorldMemoryRepository();

  await memory.appendObservations([
    observation({
      entityId: 'inside',
      observationType: 'position',
      observedAt: '2026-09-25T00:00:00Z',
      coordinates: [126.9, 37.5],
      value: 1,
    }),
    observation({
      entityId: 'outside',
      observationType: 'position',
      observedAt: '2026-09-25T00:01:00Z',
      coordinates: [128.0, 37.5],
      value: 2,
    }),
    observation({
      entityId: 'inside-state',
      observationType: 'state',
      observedAt: '2026-09-25T00:02:00Z',
      coordinates: [126.91, 37.51],
      value: 3,
    }),
  ]);

  const result = await memory.queryObservations({
    observation_type: 'position',
    bbox: [126.8, 37.4, 127.0, 37.6],
  });

  assert.deepEqual(
    result.map((item) => item.entity_id),
    ['inside'],
  );
});

test('queryNearby returns exact point results ordered by distance', async () => {
  const memory = createInMemoryWorldMemoryRepository();

  await memory.appendObservations([
    observation({
      entityId: 'near',
      observedAt: '2026-09-25T00:00:00Z',
      coordinates: [126.9005, 37.5],
      value: 1,
    }),
    observation({
      entityId: 'farther',
      observedAt: '2026-09-25T00:01:00Z',
      coordinates: [126.91, 37.5],
      value: 2,
    }),
    observation({
      entityId: 'outside',
      observedAt: '2026-09-25T00:02:00Z',
      coordinates: [127.5, 37.5],
      value: 3,
    }),
    observation({
      entityId: 'no-point',
      observedAt: '2026-09-25T00:03:00Z',
      coordinates: null,
      value: 4,
    }),
  ]);

  const result = await memory.queryNearby({
    center: [126.9, 37.5],
    radius_km: 2,
  });

  assert.deepEqual(
    result.map((item) => item.observation.entity_id),
    ['near', 'farther'],
  );
  assert.equal(
    result[0].distance_km < result[1].distance_km,
    true,
  );
});

test('ingestion run state round-trips without exposing mutable storage', async () => {
  const memory = createInMemoryWorldMemoryRepository();

  const saved = await memory.saveIngestionRun({
    ingestion_run_id: 'run-1',
    provider_id: 'provider-a',
    started_at: '2026-09-25T00:00:00Z',
    completed_at: null,
    status: 'RUNNING',
    metadata: { attempt: 1 },
  });

  saved.metadata.attempt = 99;
  const reread = await memory.getIngestionRun('run-1');
  assert.equal(reread.metadata.attempt, 1);

  await memory.saveIngestionRun({
    ...reread,
    completed_at: '2026-09-25T00:01:00Z',
    status: 'SUCCEEDED',
  });

  const completed = await memory.getIngestionRun('run-1');
  assert.equal(completed.status, 'SUCCEEDED');
  assert.equal(
    completed.completed_at,
    '2026-09-25T00:01:00.000Z',
  );
  assert.equal(memory.ingestionRunCount(), 1);
});
