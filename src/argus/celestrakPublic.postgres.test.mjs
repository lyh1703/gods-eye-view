import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createPostgresWorldMemoryRepository } from './memory/postgresRepository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { createGevCelestrakSatellitesAdapter } from './providers/gevCelestrakSatellites.js';
import { celestrakTleUrl } from '../data/spaceProviderRequests.js';

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
      const adapter = createGevCelestrakSatellitesAdapter({
        fetchImpl: async (input, init = {}) => {
          const path = String(input);
          const prefix = '/api/celestrak/';
          if (!path.startsWith(prefix)) {
            throw new Error(`unexpected CelesTrak test URL: ${path}`);
          }
          const group = path.slice(prefix.length).split('?')[0];
          const upstream = celestrakTleUrl(group);
          const signals = [AbortSignal.timeout(20_000)];
          if (init.signal) signals.push(init.signal);
          return fetch(upstream, {
            ...init,
            signal: AbortSignal.any(signals),
            headers: {
              'User-Agent':
                'argus-capability-recovery-e2e/1.0 (+https://github.com/lyh1703/gods-eye-view)',
            },
          });
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
      assert.notEqual(ingest.status, 'DEGRADED');
      assert.ok(ingest.inserted + ingest.duplicates > 0);

      const observations = await repository.queryObservations({
        provider_ids: ['gev-celestrak-satellites'],
        entity_type: 'satellite',
        observation_type: 'satellite-propagated-position',
        limit: 100,
      });
      assert.ok(observations.length > 0);
      const sample = observations[0];
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
      assert.equal(nearby.health.requested_providers[0].state === 'OK' || nearby.health.requested_providers[0].state === 'STALE', true);
      assert.notEqual(nearby.health.requested_providers[0].state, 'PROVIDER_FAILURE');
    } finally {
      await pool.end();
    }
  });
}
