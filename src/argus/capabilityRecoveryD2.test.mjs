import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createInMemoryWorldMemoryRepository } from './memory/repository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { createGevAisVesselsAdapter } from './providers/gevAisVessels.js';
import { createGevFirmsFireAdapter } from './providers/gevFirmsFire.js';
import { createGevCelestrakSatellitesAdapter } from './providers/gevCelestrakSatellites.js';

const CLOCK_MS = Date.parse('2026-10-01T03:00:00.000Z');
const GLOBAL_BBOX = [-180, -90, 180, 90];
const ISS_TLE = `ISS (ZARYA)
1 25544U 98067A   26274.10000000  .00016717  00000+0  30174-3 0  9998
2 25544  51.6390 180.1234 0005000 200.0000 160.0000 15.50000000412345
`;

function uuidSequence() {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
  };
}

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return structuredClone(payload);
    },
  };
}

function textResponse(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return String(text);
    },
  };
}

function aisPayload({ timestampMs = CLOCK_MS - 30_000, lat = 37.45, lon = 126.62 } = {}) {
  return {
    rows: [
      {
        mmsi: '440123456',
        lat,
        lon,
        type: 'Cargo',
        speed: 12.5,
        course: 274.2,
        heading: 276,
        last_position_epoch: timestampMs / 1000,
        last_position_UTC: new Date(timestampMs).toISOString(),
      },
    ],
    source: 'AISStream',
    status: 'live',
    refreshing: false,
    newestPositionAt: new Date(timestampMs).toISOString(),
    lastMessageAt: timestampMs,
  };
}

function firmsPayload({ fires = null, stale = false, partial = false } = {}) {
  return {
    fetchedAt: CLOCK_MS - 60_000,
    stale,
    sources: [
      { source: 'VIIRS_NOAA20_NRT', count: 1, ok: true },
      ...(partial
        ? [{ source: 'VIIRS_NOAA21_NRT', count: 0, ok: false }]
        : []),
    ],
    fires:
      fires ??
      [
        {
          lat: 37.51,
          lon: 127.04,
          frp: 8.2,
          confidence: 'n',
          brightness: 324.1,
          daynight: 'D',
          acqDate: '2026-10-01',
          acqTime: '0255',
          satellite: 'N20',
          instrument: 'VIIRS',
        },
      ],
  };
}

function aisAdapter(now = () => new Date(CLOCK_MS), payload = aisPayload()) {
  return createGevAisVesselsAdapter({
    now,
    fetchImpl: async () => jsonResponse(payload),
  });
}

function firmsAdapter(now = () => new Date(CLOCK_MS), payload = firmsPayload()) {
  return createGevFirmsFireAdapter({
    now,
    fetchImpl: async () => jsonResponse(payload),
  });
}

function spaceAdapter(now = () => new Date(CLOCK_MS)) {
  return createGevCelestrakSatellitesAdapter({
    now,
    fetchImpl: async () => textResponse(ISS_TLE),
  });
}

test('AIS recovery normalizes bounded vessel evidence without extra identity fields', async () => {
  const observations = await aisAdapter().query({
    scope: { bbox: [126, 37, 128, 38] },
    limit: 10,
    ingestionRunId: 'run-ais',
  });
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.equal(observation.entity_type, 'vessel');
  assert.equal(observation.entity_id, '440123456');
  assert.equal(observation.observation_type, 'vessel-position');
  assert.deepEqual(observation.geometry.coordinates, [126.62, 37.45]);
  assert.equal(observation.properties.vessel_type, 'Cargo');
  assert.equal(observation.properties.speed_mps > 0, true);
  assert.equal('name' in observation.properties, false);
  assert.equal('destination' in observation.properties, false);
  assert.equal('imo' in observation.properties, false);
});

test('FIRMS keeps source-native confidence separate from ARGUS confidence', async () => {
  const observations = await firmsAdapter(
    () => new Date(CLOCK_MS),
    firmsPayload({ partial: true }),
  ).query({ scope: { bbox: [126, 37, 128, 38] }, ingestionRunId: 'run-fire' });
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.equal(observation.entity_type, 'fire-detection');
  assert.equal(observation.properties.source_native_confidence, 'n');
  assert.equal(observation.properties.source_quality_normalized, 0.6);
  assert.equal(observation.properties.source_batch_partial, true);
  assert.equal(observation.confidence, 0.75);
  assert.equal(observation.properties.frp_mw, 8.2);
});

test('CelesTrak recovery maps TLE to propagated satellite state', async () => {
  const observations = await spaceAdapter().query({
    filters: { group: 'stations', entity_id: '25544' },
    limit: 10,
    ingestionRunId: 'run-space',
  });
  assert.equal(observations.length, 1);
  const observation = observations[0];
  assert.equal(observation.entity_type, 'satellite');
  assert.equal(observation.entity_id, '25544');
  assert.equal(observation.properties.propagation_model, 'SGP4');
  assert.equal(Number.isFinite(observation.properties.altitude_m), true);
  assert.equal(Number.isFinite(observation.properties.speed_mps), true);
  assert.equal(observation.source_url.includes('GROUP=stations'), true);
});

test('World Memory deduplicates repeat AIS and keeps newer state over out-of-order revision', async () => {
  let nowMs = CLOCK_MS;
  const now = () => new Date(nowMs);
  const repository = createInMemoryWorldMemoryRepository({ now });
  const ingestor = createExternalProviderIngestor({
    repository,
    now,
    uuid: uuidSequence(),
    staleAfterSeconds: 900,
    maxAttempts: 1,
  });

  const currentAdapter = aisAdapter(now, aisPayload({ timestampMs: CLOCK_MS - 20_000 }));
  const first = await ingestor.ingest(currentAdapter, { limit: 10 });
  assert.equal(first.inserted, 1);
  const duplicate = await ingestor.ingest(currentAdapter, { limit: 10 });
  assert.equal(duplicate.duplicates, 1);

  nowMs += 60_000;
  const olderAdapter = aisAdapter(
    now,
    aisPayload({
      timestampMs: CLOCK_MS - 120_000,
      lat: 37.4,
      lon: 126.6,
    }),
  );
  const revision = await ingestor.ingest(olderAdapter, { limit: 10 });
  assert.equal(revision.revisions, 1);

  const world = createWorldMemoryQueryEngine({ repository, now });
  const current = await world.get({
    provider_ids: ['gev-aisstream-vessels'],
    entity_type: 'vessel',
    provider_entity_id: '440123456',
  });
  assert.equal(current.found, true);
  assert.equal(current.state.timestamp_observed, new Date(CLOCK_MS - 20_000).toISOString());

  const history = await world.history(
    {
      provider_ids: ['gev-aisstream-vessels'],
      entity_type: 'vessel',
      provider_entity_id: '440123456',
    },
    new Date(CLOCK_MS - 180_000),
    new Date(nowMs + 1000),
  );
  assert.equal(history.count, 2);
});

test('credential gates, malformed data, rate limits, oversized data and unsupported query stay distinct', async () => {
  const missingAis = createGevAisVesselsAdapter({
    fetchImpl: async () => jsonResponse({ status: 'missing-key', rows: [] }, 503),
  });
  await assert.rejects(
    () => missingAis.query(),
    (error) => error.code === 'CREDENTIAL_MISSING' && error.retryable === false,
  );

  const missingFirms = createGevFirmsFireAdapter({
    fetchImpl: async () => jsonResponse({ error: 'no_key' }, 503),
  });
  await assert.rejects(
    () => missingFirms.query(),
    (error) => error.code === 'CREDENTIAL_MISSING',
  );

  const rateLimitedFirms = createGevFirmsFireAdapter({
    fetchImpl: async () => jsonResponse({ error: 'limited' }, 429),
  });
  await assert.rejects(
    () => rateLimitedFirms.query(),
    (error) => error.code === 'RATE_LIMIT' && error.retryable === true,
  );

  const malformedFirms = createGevFirmsFireAdapter({
    fetchImpl: async () => jsonResponse({ fires: 'not-an-array' }),
  });
  await assert.rejects(
    () => malformedFirms.query(),
    (error) => error.code === 'MALFORMED_PAYLOAD',
  );

  const missingCoordinates = firmsAdapter(
    () => new Date(CLOCK_MS),
    firmsPayload({
      fires: [
        {
          lat: null,
          lon: null,
          acqDate: '2026-10-01',
          acqTime: '0255',
        },
      ],
    }),
  );
  await assert.rejects(
    () => missingCoordinates.query(),
    (error) => error.code === 'MISSING_COORDINATES',
  );

  const invalidTimestamp = firmsAdapter(
    () => new Date(CLOCK_MS),
    firmsPayload({
      fires: [
        {
          lat: 37.5,
          lon: 127,
          acqDate: 'bad-date',
          acqTime: '9999',
        },
      ],
    }),
  );
  await assert.rejects(
    () => invalidTimestamp.query(),
    (error) => error.code === 'INVALID_TIMESTAMP',
  );

  const oversized = createGevFirmsFireAdapter({
    maxResponseRecords: 1,
    fetchImpl: async () =>
      jsonResponse(
        firmsPayload({
          fires: [
            ...firmsPayload().fires,
            { ...firmsPayload().fires[0], lon: 127.05 },
          ],
        }),
      ),
  });
  await assert.rejects(
    () => oversized.query(),
    (error) => error.code === 'OVERSIZED_RESPONSE',
  );

  await assert.rejects(
    () => spaceAdapter().query({ filters: { group: 'not-a-real-group' } }),
    (error) => error.code === 'UNSUPPORTED_QUERY',
  );
});

test('timeout and stale observations are explicit instead of no-data', async () => {
  const timeoutAdapter = createGevAisVesselsAdapter({
    timeoutMs: 5,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          'abort',
          () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          },
          { once: true },
        );
      }),
  });
  await assert.rejects(
    () => timeoutAdapter.query(),
    (error) => error.name === 'TimeoutError' && error.code === 'TIMEOUT',
  );

  const repository = createInMemoryWorldMemoryRepository({
    now: () => new Date(CLOCK_MS),
  });
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => new Date(CLOCK_MS),
    uuid: uuidSequence(),
    staleAfterSeconds: 300,
    maxAttempts: 1,
  });
  const stale = await ingestor.ingest(
    aisAdapter(
      () => new Date(CLOCK_MS),
      aisPayload({ timestampMs: CLOCK_MS - 3600_000 }),
    ),
  );
  assert.equal(stale.status, 'STALE');
  assert.equal(stale.stale_count, 1);
});

test('NEXUS composite query preserves stored evidence while surfacing latest provider failure', async () => {
  let nowMs = CLOCK_MS;
  const now = () => new Date(nowMs);
  const repository = createInMemoryWorldMemoryRepository({ now });
  const ingestor = createExternalProviderIngestor({
    repository,
    now,
    uuid: uuidSequence(),
    staleAfterSeconds: 7 * 24 * 3600,
    maxAttempts: 1,
  });

  for (const adapter of [aisAdapter(now), firmsAdapter(now), spaceAdapter(now)]) {
    const result = await ingestor.ingest(adapter, {
      scope: { bbox: GLOBAL_BBOX },
      limit: 100,
    });
    assert.notEqual(result.status, 'DEGRADED');
    assert.ok(result.inserted >= 1);
  }

  nowMs += 60_000;
  const failedAis = createGevAisVesselsAdapter({
    now,
    fetchImpl: async () => jsonResponse({ status: 'missing-key', rows: [] }, 503),
  });
  const failed = await ingestor.ingest(failedAis, { limit: 10 });
  assert.equal(failed.status, 'DEGRADED');
  assert.equal(failed.error.code, 'CREDENTIAL_MISSING');

  const world = createWorldMemoryQueryEngine({ repository, now });
  const nexus = createNexusVerifiedQueryAdapter({ world });
  const result = await nexus.execute({
    operation: 'query',
    area: GLOBAL_BBOX,
    time: {
      start: new Date(CLOCK_MS - 10 * 60_000),
      end: new Date(nowMs + 1000),
    },
    provider_ids: [
      'gev-aisstream-vessels',
      'gev-nasa-firms-fire',
      'gev-celestrak-satellites',
    ],
    limit: 100,
  });

  assert.equal(result.verified, true);
  assert.equal(result.data.count >= 3, true);
  assert.deepEqual(
    new Set(result.evidence.provider_ids),
    new Set([
      'gev-aisstream-vessels',
      'gev-nasa-firms-fire',
      'gev-celestrak-satellites',
    ]),
  );
  assert.equal(result.health.degraded, true);
  assert.equal(result.health.partial_failure, true);

  const aisHealth = result.health.requested_providers.find(
    (provider) => provider.provider_id === 'gev-aisstream-vessels',
  );
  assert.equal(aisHealth.state, 'PROVIDER_FAILURE');

  const storedAis = result.data.observations.find(
    (observation) => observation.provider_id === 'gev-aisstream-vessels',
  );
  assert.ok(storedAis, 'stored AIS observation must survive provider failure');
});

test('NEXUS distinguishes a successful empty provider run as NO_DATA', async () => {
  const now = () => new Date(CLOCK_MS);
  const repository = createInMemoryWorldMemoryRepository({ now });
  const ingestor = createExternalProviderIngestor({
    repository,
    now,
    uuid: uuidSequence(),
    maxAttempts: 1,
  });
  const empty = await ingestor.ingest(
    firmsAdapter(now, firmsPayload({ fires: [] })),
    { limit: 10 },
  );
  assert.equal(empty.status, 'OK');
  assert.equal(empty.inserted, 0);

  const nexus = createNexusVerifiedQueryAdapter({
    world: createWorldMemoryQueryEngine({ repository, now }),
  });
  const result = await nexus.execute({
    operation: 'query',
    area: GLOBAL_BBOX,
    provider_ids: ['gev-nasa-firms-fire'],
  });
  assert.equal(result.data.count, 0);
  assert.equal(result.health.requested_providers[0].state, 'NO_DATA');
  assert.notEqual(result.health.requested_providers[0].state, 'PROVIDER_FAILURE');
});
