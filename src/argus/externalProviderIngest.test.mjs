import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createInMemoryWorldMemoryRepository } from './memory/repository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createUsgsEarthquakesAdapter } from './providers/usgsEarthquakes.js';

let id = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++id).padStart(12, '0')}`;

function response(payload, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => structuredClone(payload) };
}

function feed({ mag = 4.2, updated = 1_790_000_010_000 } = {}) {
  return {
    type: 'FeatureCollection',
    metadata: { generated: updated },
    features: [
      {
        type: 'Feature',
        id: 'us-test-1',
        geometry: { type: 'Point', coordinates: [127.1, 37.5, 12.3] },
        properties: {
          mag,
          place: 'ARGUS E2E fixture',
          time: 1_790_000_000_000,
          updated,
          status: 'reviewed',
          tsunami: 0,
          sig: 250,
          url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us-test-1',
        },
      },
    ],
  };
}

test('USGS ingest is idempotent, preserves revision history and query evidence', async () => {
  id = 0;
  let payload = feed();
  const clock = { value: new Date('2026-09-23T08:53:30.000Z') };
  const repository = createInMemoryWorldMemoryRepository({
    now: () => clock.value,
  });
  const adapter = createUsgsEarthquakesAdapter({
    fetchImpl: async () => response(payload),
    now: () => clock.value,
  });
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => clock.value,
    uuid,
    staleAfterSeconds: 3600,
  });

  const first = await ingestor.ingest(adapter);
  assert.equal(first.inserted, 1);
  assert.equal(first.duplicates, 0);

  clock.value = new Date('2026-09-23T08:54:00.000Z');
  const duplicate = await ingestor.ingest(adapter);
  assert.equal(duplicate.inserted, 0);
  assert.equal(duplicate.duplicates, 1);

  payload = feed({ mag: 4.7, updated: 1_790_000_020_000 });
  clock.value = new Date('2026-09-23T08:55:00.000Z');
  const revision = await ingestor.ingest(adapter);
  assert.equal(revision.inserted, 1);
  assert.equal(revision.revisions, 1);

  const world = createWorldMemoryQueryEngine({
    repository,
    now: () => clock.value,
  });
  const identity = {
    provider_ids: ['usgs-earthquakes-all-hour'],
    entity_type: 'earthquake',
    provider_entity_id: 'us-test-1',
  };

  const current = await world.get(identity, clock.value);
  assert.equal(current.state.properties.magnitude, 4.7);
  assert.equal(current.evidence.provider_ids[0], 'usgs-earthquakes-all-hour');
  assert.equal(current.evidence.supersessions.length, 1);

  const history = await world.history(identity, null, clock.value);
  assert.equal(history.count, 2);

  const spatial = await world.near([127.1, 37.5], 10, clock.value);
  assert.equal(spatial.count, 1);
  assert.equal(spatial.results[0].observation.entity_id, 'us-test-1');

  const temporalSpatial = await world.query({
    area: [126.9, 37.3, 127.3, 37.7],
    time: {
      start: '2026-09-23T08:50:00.000Z',
      end: clock.value.toISOString(),
    },
    type: 'earthquake',
  });
  assert.equal(temporalSpatial.count, 2);
});

test('provider outage degrades ingest without breaking stored World Memory', async () => {
  id = 0;
  const clock = new Date('2026-09-23T08:53:30.000Z');
  const repository = createInMemoryWorldMemoryRepository({ now: () => clock });
  const healthy = createUsgsEarthquakesAdapter({
    fetchImpl: async () => response(feed()),
    now: () => clock,
  });
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => clock,
    uuid,
  });
  await ingestor.ingest(healthy);

  const failing = createUsgsEarthquakesAdapter({
    fetchImpl: async () => response({}, { ok: false, status: 503 }),
    now: () => clock,
  });
  const degraded = await ingestor.ingest(failing);
  assert.equal(degraded.status, 'DEGRADED');

  const world = createWorldMemoryQueryEngine({ repository, now: () => clock });
  const stored = await world.get({
    provider_ids: ['usgs-earthquakes-all-hour'],
    entity_type: 'earthquake',
    provider_entity_id: 'us-test-1',
  });
  assert.equal(stored.found, true);
});

test('malformed USGS payload is degraded rather than silently accepted', async () => {
  id = 0;
  const clock = new Date('2026-09-23T08:53:30.000Z');
  const repository = createInMemoryWorldMemoryRepository({ now: () => clock });
  const adapter = createUsgsEarthquakesAdapter({
    fetchImpl: async () => response({ type: 'FeatureCollection', nope: [] }),
    now: () => clock,
  });
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => clock,
    uuid,
  });
  const result = await ingestor.ingest(adapter);
  assert.equal(result.status, 'DEGRADED');
  assert.match(result.error.message, /features/i);
});

test('DB write failure is surfaced after fetch/normalize', async () => {
  id = 0;
  const clock = new Date('2026-09-23T08:53:30.000Z');
  const base = createInMemoryWorldMemoryRepository({ now: () => clock });
  const repository = {
    ...base,
    appendObservations: async () => {
      throw new Error('simulated database write failure');
    },
  };
  const adapter = createUsgsEarthquakesAdapter({
    fetchImpl: async () => response(feed()),
    now: () => clock,
  });
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => clock,
    uuid,
  });
  await assert.rejects(() => ingestor.ingest(adapter), /database write failure/);
});
