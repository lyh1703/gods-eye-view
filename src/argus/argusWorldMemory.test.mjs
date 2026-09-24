import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createInMemoryWorldMemory,
  createObservationEnvelope,
  createWorldQueryEngine,
  validateWorldMemoryRepository,
} from './index.js';

function observation({
  providerId = 'provider-a',
  entityId = 'asset-1',
  observedAt,
  value,
}) {
  return createObservationEnvelope({
    provider_id: providerId,
    entity_type: 'asset',
    entity_id: entityId,
    observation_type: 'state',
    timestamp_observed: observedAt,
    timestamp_received: observedAt,
    geometry: {
      type: 'Point',
      coordinates: [126.9, 37.5],
    },
    properties: { value },
    source_url: `https://example.test/${providerId}/${entityId}`,
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: false,
    retention_policy: 'test-only',
    rate_limit_class: 'test',
    ingestion_run_id: 'memory-test',
    raw_reference: `${providerId}-${entityId}-${observedAt}`,
  });
}

test('World Memory repository contract rejects incomplete repositories', () => {
  assert.throws(
    () => validateWorldMemoryRepository({ history() {} }),
    /appendObservations/,
  );
});

test('in-memory World Memory preserves append-first entity history', async () => {
  const memory = createInMemoryWorldMemory({
    now: () => new Date('2026-09-24T00:03:00Z'),
  });

  const write = await memory.appendObservations([
    observation({
      observedAt: '2026-09-24T00:00:00Z',
      value: 1,
    }),
    observation({
      providerId: 'provider-b',
      observedAt: '2026-09-24T00:01:00Z',
      value: 2,
    }),
    observation({
      observedAt: '2026-09-24T00:02:00Z',
      value: 3,
    }),
    observation({
      entityId: 'asset-2',
      observedAt: '2026-09-24T00:02:30Z',
      value: 99,
    }),
  ]);

  assert.equal(write.inserted, 4);
  assert.equal(memory.size(), 4);

  const history = await memory.history({
    entity_type: 'asset',
    entity_id: 'asset-1',
    provider_ids: ['provider-a'],
    from: '2026-09-24T00:00:30Z',
    to: '2026-09-24T00:03:00Z',
  });

  assert.deepEqual(
    history.map((item) => item.properties.value),
    [3],
  );
});

test('world.history reads configured memory and degrades when absent', async () => {
  const memory = createInMemoryWorldMemory();
  await memory.appendObservations([
    observation({
      observedAt: '2026-09-24T00:00:00Z',
      value: 1,
    }),
    observation({
      observedAt: '2026-09-24T00:02:00Z',
      value: 2,
    }),
  ]);

  const configured = createWorldQueryEngine({
    worldMemory: validateWorldMemoryRepository(memory),
    now: () => new Date('2026-09-24T00:03:00Z'),
  });
  const result = await configured.history({
    entity_type: 'asset',
    entity_id: 'asset-1',
  });

  assert.equal(result.memory.ok, true);
  assert.equal(result.memory.backend, 'in-memory');
  assert.deepEqual(
    result.observations.map((item) => item.properties.value),
    [2, 1],
  );

  const unconfigured = createWorldQueryEngine({
    now: () => new Date('2026-09-24T00:03:00Z'),
  });
  const degraded = await unconfigured.history({
    entity_type: 'asset',
    entity_id: 'asset-1',
  });

  assert.equal(degraded.memory.ok, false);
  assert.equal(degraded.memory.error, 'world-memory-not-configured');
  assert.deepEqual(degraded.observations, []);
});
