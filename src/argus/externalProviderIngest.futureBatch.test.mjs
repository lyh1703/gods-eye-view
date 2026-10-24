import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createInMemoryWorldMemoryRepository } from './memory/repository.js';
import { createUsgsEarthquakesAdapter } from './providers/usgsEarthquakes.js';

const CLOCK = new Date('2026-10-17T12:00:00.000Z');
const OBSERVED = new Date(CLOCK.getTime() - 10_000).getTime();
const FUTURE = new Date(CLOCK.getTime() + 15_000).getTime();

function feature(id, observed = OBSERVED) {
  return {
    type: 'Feature',
    id,
    geometry: { type: 'Point', coordinates: [127.1, 37.5, 10] },
    properties: {
      time: observed,
      mag: 3.2,
      place: 'ARGUS mixed-snapshot regression fixture',
      status: 'reviewed',
      url: 'https://earthquake.usgs.gov/earthquakes/eventpage/' + id,
    },
  };
}

function feed(...features) {
  return { type: 'FeatureCollection', features };
}

function fixture() {
  const repository = createInMemoryWorldMemoryRepository({ now: () => CLOCK });
  let seq = 0;
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => CLOCK,
    uuid: () => '00000000-0000-4000-8000-' + String(++seq).padStart(12, '0'),
  });
  return { repository, ingestor };
}

test('mixed USGS snapshot fails atomically and retains earlier trustworthy history', async () => {
  const { repository, ingestor } = fixture();
  let payload = feed(feature('original-ok'));
  const adapter = createUsgsEarthquakesAdapter({
    now: () => CLOCK,
    fetchImpl: async () => ({
      ok: true,
      json: async () => structuredClone(payload),
    }),
  });

  const first = await ingestor.ingest(adapter);
  assert.equal(first.inserted, 1);
  assert.equal(repository.observationCount(), 1);

  // First row would be valid and new, but the later row is future-dated.
  payload = feed(feature('new-valid'), feature('new-future', FUTURE));
  const rejected = await ingestor.ingest(adapter);
  assert.equal(rejected.status, 'DEGRADED');
  assert.match(rejected.error.message, /timestamp_observed must be at or before timestamp_received/);
  assert.equal(repository.observationCount(), 1);
  const rejectedRun = await repository.getIngestionRun(rejected.ingestion_run_id);
  assert.equal(rejectedRun.status, 'FAILED');
  assert.equal(rejectedRun.metadata.phase, 'fetch-normalize');

  const validHistory = await repository.getEntityHistory({
    provider_ids: ['usgs-earthquakes-all-hour'],
    entity_type: 'earthquake',
    provider_entity_id: 'original-ok',
  });
  const uncommittedHistory = await repository.getEntityHistory({
    provider_ids: ['usgs-earthquakes-all-hour'],
    entity_type: 'earthquake',
    provider_entity_id: 'new-valid',
  });
  assert.equal(validHistory.length, 1);
  assert.equal(uncommittedHistory.length, 0);

  payload = feed(feature('new-valid'));
  const recovered = await ingestor.ingest(adapter);
  assert.equal(recovered.inserted, 1);
  assert.equal(repository.observationCount(), 2);
});

test('directly supplied mixed envelopes fail at ingest evidence-validation gate before writes', async () => {
  const { repository, ingestor } = fixture();
  const adapter = createUsgsEarthquakesAdapter({
    now: () => CLOCK,
    fetchImpl: async () => ({
      ok: true,
      json: async () => feed(feature('safe-input')),
    }),
  });
  const [safe] = await adapter.query({ ingestionRunId: 'preflight' });
  const future = {
    ...safe,
    entity_id: 'future-input',
    timestamp_observed: new Date(FUTURE).toISOString(),
    freshness_seconds: 0, // forged zero-age value must never bypass the timestamp contract
  };
  const result = await ingestor.ingest({
    metadata: adapter.metadata,
    query: async () => [safe, future],
  });
  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.error.code, 'INVALID_OBSERVATION_EVIDENCE');
  assert.equal(repository.observationCount(), 0);
  const run = await repository.getIngestionRun(result.ingestion_run_id);
  assert.equal(run.status, 'FAILED');
  assert.equal(run.records_accepted, 0);
  assert.equal(run.metadata.phase, 'evidence-validation');
});
