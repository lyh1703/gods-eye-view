import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createPostgresWorldMemoryRepository } from './memory/postgresRepository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createUsgsEarthquakesAdapter } from './providers/usgsEarthquakes.js';

const url = process.env.ARGUS_POSTGRES_TEST_URL;

if (!url) {
  test(
    'real USGS -> PostGIS E2E requires ARGUS_POSTGRES_TEST_URL',
    { skip: true },
    () => {},
  );
} else {
  const { Pool } = await import('pg');

  test('real USGS feed persists into PostGIS and remains queryable', async () => {
    const pool = new Pool({ connectionString: url });
    try {
      const repository = createPostgresWorldMemoryRepository({ db: pool });
      const adapter = createUsgsEarthquakesAdapter();
      const ingestor = createExternalProviderIngestor({
        repository,
        staleAfterSeconds: 7200,
      });

      const result = await ingestor.ingest(adapter, { limit: 10 });
      assert.notEqual(result.status, 'DEGRADED');
      assert.ok(result.inserted + result.duplicates > 0);

      const observations = await repository.queryObservations({
        provider_ids: ['usgs-earthquakes-all-hour'],
        entity_type: 'earthquake',
        limit: 10,
      });
      assert.ok(observations.length > 0);

      const sample = observations[0];
      assert.ok(sample.entity_id);
      assert.ok(sample.geometry);
      assert.ok(sample.source_url);
      assert.ok(sample.content_hash);
      assert.ok(sample.ingestion_run_id);

      const world = createWorldMemoryQueryEngine({ repository });
      const identity = {
        provider_ids: ['usgs-earthquakes-all-hour'],
        entity_type: 'earthquake',
        provider_entity_id: sample.entity_id,
      };

      const current = await world.get(identity);
      assert.equal(current.found, true);
      assert.ok(current.evidence.source_urls.length > 0);
      assert.ok(current.evidence.ingestion_run_ids.length > 0);

      const history = await world.history(identity, null, new Date());
      assert.ok(history.count >= 1);

      const [longitude, latitude] = sample.geometry.coordinates;
      const nearby = await world.near([longitude, latitude], 25);
      assert.ok(
        nearby.results.some(
          (item) => item.observation.entity_id === sample.entity_id,
        ),
      );

      const combined = await world.query({
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
        combined.observations.some(
          (item) => item.entity_id === sample.entity_id,
        ),
      );

      const second = await ingestor.ingest(adapter, { limit: 10 });
      assert.notEqual(second.status, 'DEGRADED');
      assert.ok(second.duplicates >= 1);
    } finally {
      await pool.end();
    }
  });
}
