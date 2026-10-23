import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createPostgresWorldMemoryRepository } from './memory/postgresRepository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { createGevCelestrakSatellitesAdapter } from './providers/gevCelestrakSatellites.js';

const url = process.env.ARGUS_POSTGRES_TEST_URL;

if (!url) {
  test(
    'offline CelesTrak fixture -> PostGIS -> NEXUS requires ARGUS_POSTGRES_TEST_URL',
    { skip: true },
    () => {},
  );
} else {
  const { Pool } = await import('pg');

  test('offline satellite fixture persists through PostGIS reconnection and crosses NEXUS', async () => {
    let pool = new Pool({ connectionString: url });
    try {
      let repository = createPostgresWorldMemoryRepository({ db: pool });
      const fixtureTime = new Date('2026-10-01T03:00:00Z');
      const adapter = createGevCelestrakSatellitesAdapter({
        now: () => fixtureTime,
        fetchImpl: async (input) => {
          assert.equal(String(input), '/api/celestrak/stations');
          return new Response(`OFFLINE ISS FIXTURE
1 25544U 98067A   26274.10000000  .00016717  00000+0  30174-3 0  9998
2 25544  51.6390 180.1234 0005000 200.0000 160.0000 15.50000000412345
`);
        },
      });

      const ingestor = createExternalProviderIngestor({
        repository,
        now: () => fixtureTime,
        staleAfterSeconds: 24 * 3600,
        maxAttempts: 2,
      });
      const ingest = await ingestor.ingest(adapter, {
        filters: { group: 'stations' },
        limit: 100,
      });
      assert.notEqual(ingest.status, 'DEGRADED', JSON.stringify(ingest.error));
      assert.ok(ingest.inserted + ingest.duplicates > 0);

      await pool.end();
      pool = new Pool({ connectionString: url });
      repository = createPostgresWorldMemoryRepository({ db: pool });
      const observations = await repository.queryObservations({
        provider_ids: ['gev-celestrak-satellites'],
        entity_type: 'satellite',
        observation_type: 'satellite-propagated-position',
        limit: 100,
      });
      assert.ok(observations.length > 0);
      const sample = observations.find(
        (item) => item.ingestion_run_id === ingest.ingestion_run_id,
      );
      assert.ok(sample);
      assert.ok(sample.entity_id);
      assert.ok(sample.geometry);
      assert.ok(sample.source_url.includes('celestrak.org'));
      assert.ok(sample.ingestion_run_id);
      assert.equal(sample.properties.name, 'OFFLINE ISS FIXTURE');
      assert.equal(sample.properties.propagation_model, 'SGP4');

      const world = createWorldMemoryQueryEngine({ repository });
      const nexus = createNexusVerifiedQueryAdapter({ world });
      const [longitude, latitude] = sample.geometry.coordinates;

      const current = await nexus.execute({
        operation: 'current',
        identity: {
          provider_ids: ['gev-celestrak-satellites'],
          entity_type: 'satellite',
          provider_entity_id: sample.entity_id,
        },
      });
      assert.equal(current.verified, true);
      assert.equal(current.data.found, true);

      const nearby = await nexus.execute({
        operation: 'near',
        point: [longitude, latitude],
        radius_km: 50,
        provider_ids: ['gev-celestrak-satellites'],
        type: 'satellite',
        limit: 100,
      });
      assert.ok(
        nearby.data.results.some(
          (entry) => entry.observation.entity_id === sample.entity_id,
        ),
      );
      assert.equal(
        nearby.health.requested_providers[0].state === 'OK' ||
          nearby.health.requested_providers[0].state === 'STALE',
        true,
      );
      assert.notEqual(
        nearby.health.requested_providers[0].state,
        'PROVIDER_FAILURE',
      );
    } finally {
      await pool.end();
    }
  });
}
