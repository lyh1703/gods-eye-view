import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createPostgresWorldMemoryRepository } from './memory/postgresRepository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { createObservationEnvelope } from './observationEnvelope.js';
import { createUsgsEarthquakesAdapter } from './providers/usgsEarthquakes.js';
import { createGevTransitAdapter } from './providers/gevTransit.js';
import { TRANSIT_ENABLED_FEEDS } from '../data/transitFeeds.js';
import { buildTransitSnapshot, TRANSIT_PROXY_MAX_BODY_BYTES } from '../data/transitProxy.js';
import { fetchTransitFeed } from '../sources/transitService.js';
import { readResponseBytesCapped } from '../sources/httpBody.js';

const connection = process.env.ARGUS_POSTGRES_TEST_URL;
if (!connection) {
  test('ARGUS fusion PostGIS integration needs ARGUS_POSTGRES_TEST_URL', {
    skip: true,
  }, () => {});
} else {
  const { Pool } = await import('pg');

  test('PostGIS time/area split over date line retains two providers as proximity-only', async () => {
    const pool = new Pool({ connectionString: connection });
    try {
      const repository = createPostgresWorldMemoryRepository({ db: pool });
      const now = new Date();
      let id = 0;
      const ingestor = createExternalProviderIngestor({
        repository, now: () => now, maxAttempts: 1,
        uuid: () => `00000000-0000-4000-8000-${(++id).toString(16).padStart(12, '0')}`,
      });
      for (const [provider, lon] of [
        ['fusion-date-line-a', 179.99],
        ['fusion-date-line-b', -179.99],
      ]) {
        const observation = createObservationEnvelope({
          provider_id: provider, entity_id: provider,
          entity_type: 'earthquake', observation_type: 'earthquake-event',
          timestamp_observed: new Date(now.getTime() - 10_000),
          timestamp_received: now, geometry: {
            type: 'Point', coordinates: [lon, 0],
          },
          properties: {
            location_accuracy_m: 200, original_source_id: provider,
          },
          source_url: `https://${provider}.example.org/`,
          license_class: 'test', retention_policy: 'test',
          rate_limit_class: 'test', ingestion_run_id: provider,
        });
        const adapter = {
          metadata: {
            provider_id: provider, category: 'natural-hazards',
            geography: 'dateline QA', auth_mode: 'fixture',
            cost_class: 'free', update_frequency: 'test',
            latency: 'test', coverage: 'test',
            license_class: 'test', retention_policy: 'test',
            reliability: 'fixture-only', adapter_status: 'fixture',
            source_url: observation.source_url,
          },
          async query() { return [observation]; },
        };
        const result = await ingestor.ingest(adapter);
        assert.equal(result.inserted, 1);
      }
      const nexus = createNexusVerifiedQueryAdapter({
        world: createWorldMemoryQueryEngine({ repository, now: () => now }),
        now: () => now,
      });
      const result = await nexus.execute({
        operation: 'fusion',
        provider_ids: ['fusion-date-line-a', 'fusion-date-line-b'],
        area: [179.9, -1, -179.9, 1],
        time: {
          start: new Date(now.getTime() - 60_000).toISOString(),
          end: now.toISOString(),
        },
      });
      assert.equal(result.verified, true);
      assert.equal(result.data.count, 2);
      assert.equal(result.fusion.summary.comparison_count, 1);
      assert.equal(result.fusion.comparisons[0].status, 'PROXIMITY_ONLY');
      assert.ok(result.fusion.comparisons[0].distance_km < 5);
      assert.deepEqual(result.evidence.provider_ids.sort(), [
        'fusion-date-line-a', 'fusion-date-line-b',
      ]);
    } finally {
      await pool.end();
    }
  });

  test('real USGS + public MBTA through existing providers → PostGIS → NEXUS fusion', async () => {
    const pool = new Pool({ connectionString: connection });
    try {
      const repository = createPostgresWorldMemoryRepository({ db: pool });
      const feed = TRANSIT_ENABLED_FEEDS.find((entry) => entry.id === 'mbta');
      assert.ok(feed);
      const { response } = await fetchTransitFeed(
        feed, AbortSignal.timeout(25_000),
      );
      assert.equal(response.ok, true);
      const bytes = await readResponseBytesCapped(
        response, TRANSIT_PROXY_MAX_BODY_BYTES,
      );
      const snapshot = buildTransitSnapshot(feed, bytes, Date.now());
      assert.ok(snapshot.vehicles.length > 0);
      const transit = createGevTransitAdapter({
        fetchImpl: async () => new Response(JSON.stringify(snapshot), {
          headers: { 'X-GEV-Cache': 'MISS' },
        }),
      });
      const ingest = createExternalProviderIngestor({
        repository, maxAttempts: 1, staleAfterSeconds: 7200,
      });
      const earthquakeRun = await ingest.ingest(
        createUsgsEarthquakesAdapter(), { limit: 8 },
      );
      const transitRun = await ingest.ingest(transit, {
        filters: { feed_id: 'mbta' }, limit: 12,
      });
      assert.ok(earthquakeRun.inserted + earthquakeRun.duplicates > 0);
      assert.ok(transitRun.inserted + transitRun.duplicates > 0);
      const now = new Date();
      const nexus = createNexusVerifiedQueryAdapter({
        world: createWorldMemoryQueryEngine({ repository }),
      });
      const result = await nexus.execute({
        operation: 'fusion',
        area: [-180, -90, 180, 90],
        provider_ids: [
          'usgs-earthquakes-all-hour',
          'gev-public-gtfs-transit',
        ],
        time: {
          start: new Date(now.getTime() - 6 * 3600_000).toISOString(),
          end: new Date(now.getTime() + 60_000).toISOString(),
        },
        limit: 100,
      });
      assert.ok(result.data.count >= 2);
      assert.ok(result.evidence.source_urls.includes(feed.url));
      assert.ok(result.fusion.summary.accepted_count >= 2);
      assert.equal(result.fusion.status, 'INSUFFICIENT_EVIDENCE');
      assert.equal(result.fusion.event_identity_verified, false);
      assert.ok(result.fusion.observations.some((entry) =>
        entry.provider_id === 'usgs-earthquakes-all-hour'));
      assert.ok(result.fusion.observations.some((entry) =>
        entry.provider_id === 'gev-public-gtfs-transit'));
      assert.equal(result.health.requested_providers.length, 2);
    } finally {
      await pool.end();
    }
  });
}
