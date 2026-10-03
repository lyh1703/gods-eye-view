import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createInMemoryWorldMemoryRepository } from './memory/repository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createObservationEnvelope } from './observationEnvelope.js';
import { USGS_EARTHQUAKES_PROVIDER } from './providers/usgsEarthquakes.js';

const clock = new Date('2026-10-03T00:00:00.000Z');
function sample(magnitude = 3) {
  return createObservationEnvelope({
    provider_id: USGS_EARTHQUAKES_PROVIDER.provider_id,
    entity_type: 'earthquake',
    entity_id: 'g4-reused-source-id',
    observation_type: 'earthquake-event',
    timestamp_observed: '2026-10-02T23:59:50.000Z',
    timestamp_received: clock,
    geometry: { type: 'Point', coordinates: [126.8, 37.3] },
    properties: { magnitude, origin: 'USGS' },
    source_url:
      'https://earthquake.usgs.gov/earthquakes/eventpage/g4-reused-source-id',
    license_class: 'us-government-public-domain',
    retention_policy: 'fixture-evidence-only',
    rate_limit_class: 'public-feed',
    ingestion_run_id: 'source-provided-id-replaced-by-ingestor',
  });
}

function fixtureRepository() {
  const repository = createInMemoryWorldMemoryRepository({
    now: () => clock,
  });
  let sequence = 0;
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => clock,
    uuid: () =>
      `00000000-0000-4000-8000-${(++sequence)
        .toString(16)
        .padStart(12, '0')}`,
  });
  return { repository, ingestor };
}

function adapter(rows) {
  return {
    metadata: USGS_EARTHQUAKES_PROVIDER,
    async query() {
      return structuredClone(rows);
    },
  };
}

test('G4: duplicate source observations inside one snapshot persist once and retries remain idempotent', async () => {
  const { repository, ingestor } = fixtureRepository();
  const observation = sample();
  const response = adapter([observation, structuredClone(observation)]);
  const first = await ingestor.ingest(response);
  assert.equal(first.inserted, 1);
  assert.equal(first.duplicates, 1);
  assert.equal(first.revisions, 0);
  assert.equal(repository.observationCount(), 1);
  const run = await repository.getIngestionRun(first.ingestion_run_id);
  assert.equal(run.records_seen, 2);
  assert.equal(run.records_accepted, 1);
  assert.equal(run.metadata.duplicates, 1);

  const retry = await ingestor.ingest(response);
  assert.equal(retry.inserted, 0);
  assert.equal(retry.duplicates, 2);
  assert.equal(repository.observationCount(), 1);
});

test('G4: multiple valid source revisions in one batch form ordered supersession chain', async () => {
  const { repository, ingestor } = fixtureRepository();
  const result = await ingestor.ingest(adapter([
    sample(3), sample(4), sample(4), sample(5),
  ]));
  assert.equal(result.inserted, 3);
  assert.equal(result.duplicates, 1);
  assert.equal(result.revisions, 2);
  const rows = await repository.getEntityHistory({
    provider_ids: [USGS_EARTHQUAKES_PROVIDER.provider_id],
    entity_type: 'earthquake',
    provider_entity_id: 'g4-reused-source-id',
    order: 'asc',
    time_basis: 'ingested',
    limit: 10,
  });
  assert.equal(rows.length, 3);
  const byMagnitude = new Map(
    rows.map((row) => [row.properties.magnitude, row]),
  );
  assert.equal(
    byMagnitude.get(4).supersedes_observation_id,
    byMagnitude.get(3).observation_id,
  );
  assert.equal(
    byMagnitude.get(5).supersedes_observation_id,
    byMagnitude.get(4).observation_id,
  );
  const world = createWorldMemoryQueryEngine({
    repository,
    now: () => clock,
  });
  const current = await world.get({
    provider_ids: [USGS_EARTHQUAKES_PROVIDER.provider_id],
    entity_type: 'earthquake',
    provider_entity_id: 'g4-reused-source-id',
  });
  assert.equal(current.found, true);
  assert.equal(current.state.properties.magnitude, 5);
});

test('G4: spoofed provider_id fails before any observation persistence, run is FAILED', async () => {
  const { repository, ingestor } = fixtureRepository();
  const invalid = { ...sample(), provider_id: 'spoofed-unregistered-upstream' };
  const result = await ingestor.ingest(adapter([sample(), invalid]));
  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.inserted, 0);
  assert.equal(result.error.code, 'INVALID_OBSERVATION_EVIDENCE');
  assert.equal(repository.observationCount(), 0);
  const run = await repository.getIngestionRun(result.ingestion_run_id);
  assert.equal(run.status, 'FAILED');
  assert.equal(run.records_seen, 2);
  assert.equal(run.records_accepted, 0);
  assert.equal(run.records_rejected, 2);
  assert.equal(run.metadata.phase, 'evidence-validation');
});

test('G4: missing observed timestamp and empty provider attribution are rejected without creating facts', async () => {
  for (const invalid of [
    { ...sample(), timestamp_observed: null },
    { ...sample(), source_url: '' },
    { ...sample(), provider_id: null },
  ]) {
    const { repository, ingestor } = fixtureRepository();
    const result = await ingestor.ingest(adapter([invalid]));
    assert.equal(result.status, 'DEGRADED');
    assert.equal(result.error.code, 'INVALID_OBSERVATION_EVIDENCE');
    assert.equal(repository.observationCount(), 0);
    assert.equal(
      (await repository.getIngestionRun(result.ingestion_run_id)).status,
      'FAILED',
    );
  }
});

test('G4: empty valid snapshot is NO_DATA, not fabricated success evidence', async () => {
  const { repository, ingestor } = fixtureRepository();
  const result = await ingestor.ingest(adapter([]));
  assert.equal(result.inserted, 0);
  assert.equal(result.duplicates, 0);
  const run = await repository.getIngestionRun(result.ingestion_run_id);
  assert.equal(run.records_seen, 0);
  assert.equal(run.records_accepted, 0);
  assert.equal(repository.observationCount(), 0);
});
