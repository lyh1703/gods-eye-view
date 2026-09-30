import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createInMemoryWorldMemoryRepository } from './memory/repository.js';
import { createWorldMemoryQueryEngine } from './memory/worldMemoryQuery.js';
import { createNexusVerifiedQueryAdapter } from './nexusVerifiedQuery.js';
import { createWorldQueryEngine } from './worldQuery.js';
import { createGevOpenSkyAdapter } from './providers/gevAviation.js';
import { createGevRegionalWeatherAdapter } from './providers/gevRegionalWeather.js';
import { createGevTrafficAdapter } from './providers/gevTraffic.js';
import { createUsgsEarthquakesAdapter } from './providers/usgsEarthquakes.js';

const CLOCK = new Date('2026-09-30T06:00:00.000Z');
const ROUTE_BBOX = [126.8, 37.3, 127.3, 37.8];

function response(payload, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] ?? null;
      },
    },
    async json() {
      return structuredClone(payload);
    },
  };
}

function aviationAdapter() {
  const epoch = CLOCK.getTime() / 1000;
  return createGevOpenSkyAdapter({
    now: () => CLOCK,
    fetchImpl: async () =>
      response(
        {
          time: epoch,
          states: [
            [
              'abc123',
              'ARGUS1',
              'Republic of Korea',
              epoch - 3,
              epoch - 1,
              127.02,
              37.56,
              1800,
              false,
              140,
              92,
              0,
              null,
              1850,
              null,
              false,
              0,
              3,
            ],
          ],
        },
        {
          headers: {
            'x-flight-source': 'OpenSky Network',
            'x-flight-coverage': 'worldwide upstream snapshot',
          },
        },
      ),
  });
}

function weatherAdapter() {
  return createGevRegionalWeatherAdapter({
    now: () => CLOCK,
    fetchImpl: async () =>
      response({
        status: 'ready',
        retrievedAt: CLOCK.toISOString(),
        coordinates: { latitude: 37.55, longitude: 126.98 },
        weatherStatus: 'ready',
        place: { label: 'Seoul' },
        weather: {
          observedAt: CLOCK.toISOString(),
          temperatureC: 21.5,
          apparentTemperatureC: 21.1,
          precipitationMm: 0,
          cloudCoverPct: 25,
          windKph: 12,
          windDirectionDeg: 260,
          visibilityM: 10000,
          weatherCode: 1,
        },
      }),
  });
}

function trafficAdapter() {
  return createGevTrafficAdapter({
    now: () => CLOCK,
    flowSource: {
      async fetchFlowForBounds() {
        return [
          {
            coords: [
              [126.97, 37.55],
              [127.05, 37.57],
            ],
            trafficLevel: 0.42,
            roadType: 'primary',
            closure: false,
          },
        ];
      },
    },
  });
}

function usgsAdapter() {
  return createUsgsEarthquakesAdapter({
    now: () => CLOCK,
    fetchImpl: async () =>
      response({
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            id: 'route-quake-1',
            geometry: {
              type: 'Point',
              coordinates: [127.1, 37.6, 8],
            },
            properties: {
              mag: 3.1,
              place: 'route acceptance fixture',
              time: CLOCK.getTime() - 30_000,
              status: 'reviewed',
              tsunami: 0,
              sig: 150,
              url: 'https://earthquake.usgs.gov/example/route-quake-1',
            },
          },
        ],
      }),
  });
}

function uuidSequence() {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
  };
}

test('aviation weather and traffic inherited providers are callable through ARGUS World Query', async () => {
  const world = createWorldQueryEngine({
    adapters: [aviationAdapter(), weatherAdapter(), trafficAdapter()],
    now: () => CLOCK,
  });

  const result = await world.query({
    scope: { bbox: ROUTE_BBOX },
    limit: 20,
  });

  assert.equal(result.providers.length, 3);
  assert.equal(result.providers.every(({ ok }) => ok), true);
  assert.deepEqual(
    new Set(result.observations.map(({ entity_type }) => entity_type)),
    new Set(['aircraft', 'weather-location', 'road-segment']),
  );

  for (const observation of result.observations) {
    assert.ok(observation.source_url);
    assert.ok(Number.isFinite(observation.freshness_seconds));
    assert.ok(Number.isFinite(observation.confidence));
  }
});

test('family-route safety acceptance reaches NEXUS verified query with inherited capabilities', async () => {
  const repository = createInMemoryWorldMemoryRepository({ now: () => CLOCK });
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => CLOCK,
    uuid: uuidSequence(),
    maxAttempts: 1,
  });

  for (const adapter of [
    aviationAdapter(),
    weatherAdapter(),
    trafficAdapter(),
    usgsAdapter(),
  ]) {
    const result = await ingestor.ingest(adapter, {
      scope: { bbox: ROUTE_BBOX },
      limit: 20,
    });
    assert.equal(result.status, 'OK');
    assert.ok(result.inserted >= 1);
  }

  const world = createWorldMemoryQueryEngine({
    repository,
    now: () => CLOCK,
  });
  const nexus = createNexusVerifiedQueryAdapter({ world });
  const result = await nexus.execute({
    operation: 'query',
    area: ROUTE_BBOX,
    time: {
      start: new Date(CLOCK.getTime() - 120_000),
      end: new Date(CLOCK.getTime() + 1_000),
    },
    limit: 100,
  });

  assert.equal(result.verified, true);
  assert.equal(result.health.degraded, false);
  assert.deepEqual(
    new Set(result.data.observations.map(({ entity_type }) => entity_type)),
    new Set(['aircraft', 'weather-location', 'road-segment', 'earthquake']),
  );
  assert.deepEqual(
    new Set(result.evidence.provider_ids),
    new Set([
      'gev-opensky-aircraft',
      'gev-regional-weather',
      'gev-tomtom-traffic-flow',
      'usgs-earthquakes-all-hour',
    ]),
  );
  assert.ok(result.evidence.source_urls.length >= 4);

  for (const observation of result.data.observations) {
    assert.ok(observation.source_url);
    assert.ok(Number.isFinite(observation.freshness_seconds));
    assert.ok(Number.isFinite(observation.confidence));
  }
});
