import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createPostgresWorldMemoryRepository } from './memory/postgresRepository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { createGevCelestrakSatellitesAdapter } from './providers/gevCelestrakSatellites.js';
import {
  createCelestrakClient,
  celestrakResponse,
} from '../../server/providers/space/celestrak-client.js';

const url = process.env.ARGUS_POSTGRES_TEST_URL;

if (!url) {
  test(
    'public CelesTrak -> PostGIS -> NEXUS E2E requires ARGUS_POSTGRES_TEST_URL',
    { skip: true },
    () => {},
  );
} else {
  const { Pool } = await import('pg');

  test('public CelesTrak stations feed persists into World Memory and crosses NEXUS', async () => {
    const pool = new Pool({ connectionString: url });
    try {
      const repository = createPostgresWorldMemoryRepository({ db: pool });
      const client = createCelestrakClient({
        ...(process.env.ARGUS_CELESTRAK_CACHE_DIR
          ? { cacheDir: process.env.ARGUS_CELESTRAK_CACHE_DIR }
          : {}),
      });
      let evidence;
      const adapter = createGevCelestrakSatellitesAdapter({
        fetchImpl: async (input) => {
          assert.equal(String(input), '/api/celestrak/stations');
          evidence = await client.readGroup('stations');
          // The real-provider gate must fail on a stale fallback or unavailable
          // feed. No fixtures, alternate hosts, or second download on failure.
          return celestrakResponse(evidence);
        },
      });

      const ingestor = createExternalProviderIngestor({
        repository,
        staleAfterSeconds: 24 * 3600,
        maxAttempts: 2,
      });
      const ingest = await ingestor.ingest(adapter, {
        filters: { group: 'stations' },
        limit: 100,
      });
      assert.notEqual(
        ingest.status,
        'DEGRADED',
        JSON.stringify({
          error: ingest.error,
          cache: evidence?.cache,
          diagnostic: evidence?.diagnostic,
        }),
      );
      assert.ok(['MISS', 'HIT'].includes(evidence.cache));
      assert.equal(evidence.diagnostic, null);
      console.info(
        'CelesTrak public evidence',
        JSON.stringify({
          transport:
            evidence.cache === 'MISS'
              ? 'UPSTREAM_RECEIVED'
              : 'VERIFIED_FRESH_CACHE',
          fetched_at: new Date(evidence.entry.at).toISOString(),
          source_url: evidence.entry.source_url,
          sha256: evidence.entry.sha256,
          runtime: process.versions.node,
        }),
      );
      assert.ok(ingest.inserted + ingest.duplicates > 0);

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
      assert.ok(sample, 'public gate must read back this real ingestion run');
      assert.ok(sample.entity_id);
      assert.ok(sample.geometry);
      assert.ok(sample.source_url.includes('celestrak.org'));
      assert.ok(sample.ingestion_run_id);
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
