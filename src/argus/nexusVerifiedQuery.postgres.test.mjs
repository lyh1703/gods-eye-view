import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createPostgresWorldMemoryRepository } from './memory/postgresRepository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import {
  ARGUS_NEXUS_QUERY_CONTRACT_ID,
  createNexusVerifiedQueryAdapter,
} from './nexusVerifiedQuery.js';
import { createUsgsEarthquakesAdapter } from './providers/usgsEarthquakes.js';

const url = process.env.ARGUS_POSTGRES_TEST_URL;

if (!url) {
  test(
    'ARGUS -> NEXUS live query gate requires ARGUS_POSTGRES_TEST_URL',
    { skip: true },
    () => {},
  );
} else {
  const { Pool } = await import('pg');

  test('real USGS World Memory crosses the NEXUS verified-query contract', async () => {
    const pool = new Pool({ connectionString: url });
    try {
      const repository = createPostgresWorldMemoryRepository({ db: pool });
      const provider = createUsgsEarthquakesAdapter();
      const ingestor = createExternalProviderIngestor({
        repository,
        staleAfterSeconds: 7200,
      });
      const ingest = await ingestor.ingest(provider, { limit: 10 });
      assert.notEqual(ingest.status, 'DEGRADED');
      assert.ok(ingest.inserted + ingest.duplicates > 0);

      const stored = await repository.queryObservations({
        provider_ids: ['usgs-earthquakes-all-hour'],
        entity_type: 'earthquake',
        limit: 10,
      });
      assert.ok(stored.length > 0);
      const sample = stored[0];

      const world = createWorldMemoryQueryEngine({ repository });
      const nexus = createNexusVerifiedQueryAdapter({ world });
      const identity = {
        provider_ids: ['usgs-earthquakes-all-hour'],
        entity_type: 'earthquake',
        provider_entity_id: sample.entity_id,
      };

      const current = await nexus.execute({
        operation: 'current',
        identity,
      });
      assert.equal(current.contract_id, ARGUS_NEXUS_QUERY_CONTRACT_ID);
      assert.equal(current.verified, true);
      assert.equal(current.data.found, true);
      assert.ok(current.evidence.provider_ids.includes('usgs-earthquakes-all-hour'));
      assert.ok(current.evidence.observation_ids.length > 0);
      assert.ok(current.evidence.ingestion_run_ids.length > 0);
      assert.ok(current.evidence.source_urls.length > 0);
      assert.equal(current.health.degraded, false);

      const history = await nexus.execute({
        operation: 'history',
        identity,
        end: new Date(),
      });
      assert.ok(history.data.count >= 1);

      const [longitude, latitude] = sample.geometry.coordinates;
      const nearby = await nexus.execute({
        operation: 'near',
        point: [longitude, latitude],
        radius_km: 25,
        provider_ids: ['usgs-earthquakes-all-hour'],
        type: 'earthquake',
      });
      assert.ok(
        nearby.data.results.some(
          (item) => item.observation.entity_id === sample.entity_id,
        ),
      );

      const temporalSpatial = await nexus.execute({
        operation: 'query',
        area: [
          Math.max(-180, longitude - 1),
          Math.max(-90, latitude - 1),
          Math.min(180, longitude + 1),
          Math.min(90, latitude + 1),
        ],
        time: {
          start: new Date(Date.parse(sample.timestamp_observed) - 60_000),
          end: new Date(),
        },
        type: 'earthquake',
        provider_ids: ['usgs-earthquakes-all-hour'],
        limit: 100,
      });
      assert.ok(
        temporalSpatial.data.observations.some(
          (item) => item.entity_id === sample.entity_id,
        ),
      );
    } finally {
      await pool.end();
    }
  });
}
