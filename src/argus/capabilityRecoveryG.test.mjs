import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorldQueryEngine } from './worldQuery.js';
import { createInMemoryWorldMemoryRepository } from './memory/repository.js';
import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { createGevCctvCatalogAdapter } from './providers/gevCctvCatalog.js';
import { createGevTransitAdapter } from './providers/gevTransit.js';
import { createGevRadioDirectoryAdapter } from './providers/gevRadioDirectory.js';

const NOW = new Date('2026-10-02T02:00:00.000Z');
const AREA = [-72, 41, -70, 43];
const radioId = '00000000-0000-4000-8000-000000000123';
const response = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json', ...headers },
});

const cctv = {
  sources: [{
    id: 'camera-one', name: 'Public camera', city: 'Boston',
    provider: 'Open city data', lat: 42.35, lon: -71.05,
    license: 'public open data', sourceKind: 'configured', feedType: 'image',
  }],
};
const cameraHealth = { cameras: [{ id: 'camera-one', status: 'ready', updatedAt: NOW.getTime() }] };
const transit = {
  feedId: 'mbta', name: 'MBTA', fetchedAt: NOW.getTime(),
  feedTimestamp: NOW.getTime() / 1000, truncated: false,
  vehicles: [{
    id: 'bus-one', lat: 42.36, lon: -71.07,
    timestamp: NOW.getTime() / 1000, timestampSource: 'vehicle',
    routeId: '1', tripId: 'trip-one', speedMps: 6.4, bearing: 190,
  }],
};
const radio = {
  updatedAt: NOW.toISOString(), stale: false, degraded: false,
  stations: [{
    id: radioId, name: 'Public Radio', lat: 42.32, lon: -71.08,
    country: 'United States', countryCode: 'US', languages: ['English'],
    tags: ['news'], codec: 'MP3', streamUrl: 'https://stream.example.org/radio',
    metadataTrust: 'untrusted-community',
  }],
};

function adapters({
  cctvSnapshot = cctv, healthSnapshot = cameraHealth,
  transitSnapshot = transit, radioSnapshot = radio,
  radioStatus = 200,
} = {}) {
  const now = () => NOW;
  return [
    createGevCctvCatalogAdapter({
      now,
      fetchImpl: async (url) => response(
        url.includes('health') ? healthSnapshot : cctvSnapshot,
      ),
    }),
    createGevTransitAdapter({
      now, fetchImpl: async () => response(transitSnapshot),
    }),
    createGevRadioDirectoryAdapter({
      now, fetchImpl: async () => response(radioSnapshot, radioStatus),
    }),
  ];
}
function ids() {
  let id = 0;
  return () => `00000000-0000-4000-8000-${(++id).toString().padStart(12, '0')}`;
}

test('G adapters reuse inherited registry and preserve catalog vs live evidence', async () => {
  const queryEngine = createWorldQueryEngine({ adapters: adapters(), now: () => NOW });
  const result = await queryEngine.query({
    scope: { bbox: AREA }, filters: { feed_id: 'mbta' }, limit: 30,
  });
  assert.ok(result.providers.every((p) => p.ok));
  assert.deepEqual(
    new Set(result.observations.map((o) => o.entity_type)),
    new Set(['cctv-camera', 'transit-vehicle', 'radio-station']),
  );
  const camera = result.observations.find((o) => o.entity_type === 'cctv-camera');
  assert.equal(camera.properties.observation_basis, 'catalog-sample-not-live-frame');
  assert.equal(camera.properties.stream_verified, false);
  const bus = result.observations.find((o) => o.entity_type === 'transit-vehicle');
  assert.equal(bus.properties.route_id, '1');
  assert.equal(bus.entity_id, 'mbta:bus-one');
  const station = result.observations.find((o) => o.entity_type === 'radio-station');
  assert.equal(station.properties.stream_status, 'NOT_PROBED');
  assert.equal(station.properties.stream_url.startsWith('https://'), true);
  for (const entry of result.observations) {
    assert.ok(entry.source_url);
    assert.equal(entry.timestamp_received, NOW.toISOString());
    assert.ok(Number.isFinite(entry.freshness_seconds));
    assert.ok(Number.isFinite(entry.confidence));
  }
});

test('G adapters persist in World Memory and NEXUS reports failures separately from stored evidence', async () => {
  const repository = createInMemoryWorldMemoryRepository({ now: () => NOW });
  const ingestor = createExternalProviderIngestor({
    repository, now: () => NOW, uuid: ids(), maxAttempts: 1,
    staleAfterSeconds: 600,
  });
  for (const adapter of adapters()) {
    const saved = await ingestor.ingest(adapter, { filters: { feed_id: 'mbta' }, limit: 20 });
    assert.equal(saved.inserted, 1);
    const repeated = await ingestor.ingest(adapter, { filters: { feed_id: 'mbta' }, limit: 20 });
    assert.equal(repeated.duplicates, 1);
  }
  const failRadio = adapters({ radioStatus: 503 })[2];
  const failure = await ingestor.ingest(failRadio);
  assert.equal(failure.status, 'DEGRADED');
  assert.equal(failure.error.code, 'PROVIDER_FAILURE');

  const nexus = createNexusVerifiedQueryAdapter({
    world: createWorldMemoryQueryEngine({ repository, now: () => NOW }),
  });
  const result = await nexus.execute({
    operation: 'query', area: AREA,
    provider_ids: [
      'gev-public-cctv-catalog',
      'gev-public-gtfs-transit',
      'gev-radio-browser-directory',
    ],
  });
  assert.equal(result.verified, true);
  assert.equal(result.data.count, 3);
  assert.equal(result.health.degraded, true);
  assert.equal(result.health.partial_failure, true);
  assert.equal(result.health.requested_providers.find(
    (p) => p.provider_id === 'gev-radio-browser-directory',
  ).state, 'PROVIDER_FAILURE');
  assert.ok(result.evidence.source_urls.length >= 3);
});

test('G failure QA distinguishes no data, source down, access refused, malformed, bounds and query limits', async () => {
  const empty = adapters({ radioSnapshot: { updatedAt: NOW.toISOString(), stations: [] } })[2];
  assert.deepEqual(await empty.query(), []);
  const unavailable = adapters({ radioStatus: 503 })[2];
  await assert.rejects(() => unavailable.query(), (e) => e.code === 'PROVIDER_FAILURE');
  const rejected = createGevTransitAdapter({ fetchImpl: async () => response({}, 403) });
  await assert.rejects(() => rejected.query({ filters: { feed_id: 'mbta' } }),
    (e) => e.code === 'ACCESS_DENIED');
  await assert.rejects(() => rejected.query({ filters: { feed_id: 'unauthorized' } }),
    (e) => e.code === 'UNSUPPORTED_QUERY');
  const malformed = adapters({ cctvSnapshot: { sources: 'invalid' } })[0];
  await assert.rejects(() => malformed.query(), (e) => e.code === 'PROVIDER_FAILURE');
  const oversized = createGevCctvCatalogAdapter({
    maxRows: 1, fetchImpl: async (url) => response(url.includes('health')
      ? cameraHealth : { sources: [...cctv.sources, { ...cctv.sources[0], id: 'camera-two' }] }),
  });
  await assert.rejects(() => oversized.query(), (e) => e.code === 'OVERSIZED_RESPONSE');
  const badCoord = adapters({ cctvSnapshot: { sources: [{ ...cctv.sources[0], lat: null }] } })[0];
  assert.deepEqual(await badCoord.query(), []);
  const invalidTime = adapters({ transitSnapshot: {
    ...transit, vehicles: [{ ...transit.vehicles[0], timestamp: 'invalid' }],
    feedTimestamp: null,
  } })[1];
  const record = (await invalidTime.query({ filters: { feed_id: 'mbta' } }))[0];
  assert.equal(record.properties.timestamp_source, 'vehicle');
  const rateLimited = createGevRadioDirectoryAdapter({ fetchImpl: async () => response({}, 429) });
  await assert.rejects(() => rateLimited.query(), (e) => e.code === 'RATE_LIMIT');
  const badRadio = adapters({ radioSnapshot: {
    updatedAt: NOW.toISOString(), stations: [{ ...radio.stations[0], streamUrl: 'http://127.0.0.1/private' }],
  } })[2];
  assert.deepEqual(await badRadio.query(), []);
});
