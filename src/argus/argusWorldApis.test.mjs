import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createObservationEnvelope, createWorldQueryEngine } from './index.js';

function providerMetadata(providerId) {
  return {
    provider_id: providerId,
    category: 'test',
    geography: 'global',
    auth_mode: 'keyless',
    cost_class: 'free',
    update_frequency: 'test',
    latency: 'test',
    coverage: 'test',
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: false,
    retention_policy: 'test-only',
    reliability: 'test',
    adapter_status: 'test',
    source_url: `https://example.test/${providerId}`,
  };
}

function observation({
  providerId = 'provider-a',
  entityType = 'vehicle',
  entityId,
  observedAt,
  coordinates,
  value,
}) {
  return createObservationEnvelope({
    provider_id: providerId,
    entity_type: entityType,
    entity_id: entityId,
    observation_type: 'state',
    timestamp_observed: observedAt,
    timestamp_received: observedAt,
    geometry: coordinates ? { type: 'Point', coordinates } : null,
    properties: { value },
    source_url: `https://example.test/${providerId}/${entityId}`,
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: false,
    retention_policy: 'test-only',
    rate_limit_class: 'test',
    ingestion_run_id: 'world-api-test',
  });
}

function createFixtureAdapter(providerId, observationsByMarker) {
  return {
    metadata: providerMetadata(providerId),
    async query({ filters = {} } = {}) {
      const source =
        observationsByMarker[filters.marker ?? 'default'] ??
        observationsByMarker.default ??
        [];
      return source.filter((item) => {
        if (filters.entity_type && item.entity_type !== filters.entity_type) {
          return false;
        }
        if (filters.entity_id && item.entity_id !== filters.entity_id) {
          return false;
        }
        return true;
      });
    },
  };
}

test('world.entity returns matching observations newest first', async () => {
  const adapter = createFixtureAdapter('provider-a', {
    default: [
      observation({
        entityId: 'veh-1',
        observedAt: '2026-09-24T00:00:00Z',
        coordinates: [126.9, 37.5],
        value: 1,
      }),
      observation({
        entityId: 'veh-2',
        observedAt: '2026-09-24T00:01:00Z',
        coordinates: [126.91, 37.5],
        value: 9,
      }),
      observation({
        entityId: 'veh-1',
        observedAt: '2026-09-24T00:02:00Z',
        coordinates: [126.92, 37.5],
        value: 2,
      }),
    ],
  });
  const world = createWorldQueryEngine({
    adapters: [adapter],
    now: () => new Date('2026-09-24T00:03:00Z'),
  });

  const result = await world.entity({
    entity_type: 'vehicle',
    entity_id: 'veh-1',
  });

  assert.equal(result.found, true);
  assert.equal(result.observations.length, 2);
  assert.equal(result.latest_observation.properties.value, 2);
  assert.equal(result.providers[0].count, 2);
});

test('world.nearby returns point observations ordered by distance', async () => {
  const adapter = createFixtureAdapter('provider-a', {
    default: [
      observation({
        entityId: 'near',
        observedAt: '2026-09-24T00:00:00Z',
        coordinates: [126.9005, 37.5],
        value: 1,
      }),
      observation({
        entityId: 'farther',
        observedAt: '2026-09-24T00:00:00Z',
        coordinates: [126.91, 37.5],
        value: 2,
      }),
      observation({
        entityId: 'outside',
        observedAt: '2026-09-24T00:00:00Z',
        coordinates: [127.5, 37.5],
        value: 3,
      }),
    ],
  });
  const world = createWorldQueryEngine({ adapters: [adapter] });

  const result = await world.nearby({
    center: [126.9, 37.5],
    radius_km: 2,
  });

  assert.deepEqual(
    result.results.map(({ observation: item }) => item.entity_id),
    ['near', 'farther'],
  );
  assert.equal(
    result.results[0].distance_km < result.results[1].distance_km,
    true,
  );
  assert.equal(result.providers[0].count, 2);
});

test('world.compare reports provider-scoped entity changes', async () => {
  const unchangedLeft = observation({
    entityId: 'same',
    observedAt: '2026-09-24T00:00:00Z',
    coordinates: [126.9, 37.5],
    value: 1,
  });
  const unchangedRight = structuredClone(unchangedLeft);

  const adapter = createFixtureAdapter('provider-a', {
    left: [
      unchangedLeft,
      observation({
        entityId: 'changed',
        observedAt: '2026-09-24T00:00:00Z',
        coordinates: [126.9, 37.5],
        value: 1,
      }),
      observation({
        entityId: 'removed',
        observedAt: '2026-09-24T00:00:00Z',
        coordinates: [126.9, 37.5],
        value: 1,
      }),
    ],
    right: [
      unchangedRight,
      observation({
        entityId: 'changed',
        observedAt: '2026-09-24T00:01:00Z',
        coordinates: [126.9, 37.5],
        value: 2,
      }),
      observation({
        entityId: 'added',
        observedAt: '2026-09-24T00:01:00Z',
        coordinates: [126.9, 37.5],
        value: 1,
      }),
    ],
  });
  const world = createWorldQueryEngine({ adapters: [adapter] });

  const result = await world.compare({
    left: { filters: { marker: 'left' } },
    right: { filters: { marker: 'right' } },
  });

  assert.deepEqual(result.summary, {
    added: 1,
    removed: 1,
    changed: 1,
    unchanged: 1,
  });
  assert.equal(result.identity, 'provider-scoped-entity');
  assert.match(result.changed[0].key, /provider-a:vehicle:changed/);
});
