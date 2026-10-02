import assert from 'node:assert/strict';
import test from 'node:test';
import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createPostgresWorldMemoryRepository } from './memory/postgresRepository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { createGevCctvCatalogAdapter } from './providers/gevCctvCatalog.js';
import { createGevTransitAdapter } from './providers/gevTransit.js';
import { createGevRadioDirectoryAdapter } from './providers/gevRadioDirectory.js';
import { TRANSIT_ENABLED_FEEDS } from '../data/transitFeeds.js';
import { buildTransitSnapshot } from '../data/transitProxy.js';
import { fetchTransitFeed } from '../sources/transitService.js';
import { readResponseBytesCapped } from '../sources/httpBody.js';
import { TRANSIT_PROXY_MAX_BODY_BYTES } from '../data/transitProxy.js';

const url = process.env.ARGUS_POSTGRES_TEST_URL;
if (!url) {
  test('ARGUS G PostGIS suite requires ARGUS_POSTGRES_TEST_URL', { skip: true }, () => {});
} else {
  const { Pool } = await import('pg');

  test('G CCTV transit radio fixture persists in canonical PostGIS and is NEXUS-consumable', async () => {
    const pool = new Pool({ connectionString: url });
    try {
      const now = () => new Date('2026-10-02T02:00:00Z');
      const cctv = createGevCctvCatalogAdapter({ now, fetchImpl: async (path) =>
        new Response(JSON.stringify(path.includes('health')
          ? { cameras: [] } : { sources: [{
            id: 'g-qa-camera', lat: 42.35, lon: -71.05,
            provider: 'test licensed source', sourceKind: 'configured',
            license: 'qa only', feedType: 'image',
          }] })) });
      const transit = createGevTransitAdapter({ now, fetchImpl: async () =>
        new Response(JSON.stringify({
          feedId: 'mbta', fetchedAt: now().getTime(),
          vehicles: [{ id: 'g-qa-bus', lat: 42.36, lon: -71.06,
            timestamp: now().getTime() / 1000, routeId: '1' }],
        })) });
      const radio = createGevRadioDirectoryAdapter({ now, fetchImpl: async () =>
        new Response(JSON.stringify({
          updatedAt: now().toISOString(),
          stations: [{
            id: '00000000-0000-4000-8000-000000000123',
            name: 'QA station', lat: 42.37, lon: -71.06,
            streamUrl: 'https://streams.example.org/qa',
          }],
        })) });
      const repository = createPostgresWorldMemoryRepository({ db: pool });
      const ingestor = createExternalProviderIngestor({
        repository, now, maxAttempts: 1, staleAfterSeconds: 1200,
      });
      for (const adapter of [cctv, transit, radio]) {
        const saved = await ingestor.ingest(adapter, {
          filters: { feed_id: 'mbta' }, limit: 10,
        });
        assert.equal(saved.inserted + saved.duplicates >= 1, true);
      }
      const nexus = createNexusVerifiedQueryAdapter({
        world: createWorldMemoryQueryEngine({ repository, now }),
      });
      const result = await nexus.execute({
        operation: 'query',
        area: [-72, 41, -70, 43],
        provider_ids: [
          'gev-public-cctv-catalog',
          'gev-public-gtfs-transit',
          'gev-radio-browser-directory',
        ],
      });
      assert.equal(result.verified, true);
      assert.ok(result.data.count >= 3);
      assert.equal(result.evidence.source_urls.length >= 3, true);
      for (const provider of result.health.requested_providers) {
        assert.ok(['OK', 'STALE'].includes(provider.state));
      }
    } finally {
      await pool.end();
    }
  });

  test('real public MBTA GTFS-Realtime → inherited decoder → ARGUS PostGIS → NEXUS', async () => {
    const pool = new Pool({ connectionString: url });
    try {
      const feed = TRANSIT_ENABLED_FEEDS.find((item) => item.id === 'mbta');
      assert.ok(feed, 'MBTA must remain explicitly enabled');
      const { response, finalUrl } = await fetchTransitFeed(
        feed, AbortSignal.timeout(25_000),
      );
      assert.equal(response.ok, true, `MBTA upstream HTTP ${response.status}`);
      assert.equal(new URL(finalUrl).origin, new URL(feed.url).origin);
      const bytes = await readResponseBytesCapped(
        response, TRANSIT_PROXY_MAX_BODY_BYTES,
      );
      const snapshot = buildTransitSnapshot(feed, bytes, Date.now());
      assert.ok(snapshot.vehicles.length > 0, 'live feed must contain actual vehicle positions');
      const adapter = createGevTransitAdapter({
        fetchImpl: async (path) => {
          assert.equal(path, '/api/transit/vehicles/mbta');
          return new Response(JSON.stringify(snapshot), {
            headers: { 'X-GEV-Cache': 'MISS' },
          });
        },
      });
      const repository = createPostgresWorldMemoryRepository({ db: pool });
      const ingestor = createExternalProviderIngestor({
        repository, maxAttempts: 1, staleAfterSeconds: 3600,
      });
      const saved = await ingestor.ingest(adapter, {
        filters: { feed_id: 'mbta' }, limit: 30,
      });
      assert.ok(saved.inserted + saved.duplicates > 0);
      const world = createWorldMemoryQueryEngine({ repository });
      const nexus = createNexusVerifiedQueryAdapter({ world });
      const sample = snapshot.vehicles.find(
        (v) => Number.isFinite(v.lat) && Number.isFinite(v.lon),
      );
      assert.ok(sample);
      const result = await nexus.execute({
        operation: 'near', point: [sample.lon, sample.lat],
        radius_km: 25,
        provider_ids: ['gev-public-gtfs-transit'],
        type: 'transit-vehicle',
      });
      assert.equal(result.verified, true);
      assert.ok(result.data.count > 0);
      assert.ok(result.evidence.source_urls.includes(feed.url));
      assert.notEqual(result.health.requested_providers[0].state, 'PROVIDER_FAILURE');
    } finally {
      await pool.end();
    }
  });
}
