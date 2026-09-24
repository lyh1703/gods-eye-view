import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createObservationEnvelope,
  createProviderRegistry,
  createUsgsEarthquakesAdapter,
  createWorldQueryEngine,
  validateObservationEnvelope,
} from './index.js';

test('ARGUS observation envelope preserves observed and received time', () => {
  const observation = createObservationEnvelope({
    provider_id: 'test',
    entity_type: 'event',
    entity_id: 'evt-1',
    observation_type: 'test-event',
    timestamp_observed: '2026-09-24T00:00:00Z',
    timestamp_received: '2026-09-24T00:00:10Z',
    geometry: { type: 'Point', coordinates: [126, 37] },
    properties: { value: 1 },
    source_url: 'https://example.test/event/1',
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: true,
    retention_policy: 'test-only',
    rate_limit_class: 'test',
    ingestion_run_id: 'run-1',
  });

  assert.equal(observation.freshness_seconds, 10);
  assert.equal(validateObservationEnvelope(observation).ok, true);
});

test('provider registry blocks accidental duplicate providers', () => {
  const registry = createProviderRegistry();
  const provider = {
    provider_id: 'provider-1',
    category: 'test',
    geography: 'global',
    auth_mode: 'keyless',
    cost_class: 'free',
    update_frequency: 'test',
    latency: 'test',
    coverage: 'test',
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: true,
    retention_policy: 'test-only',
    reliability: 'test',
    adapter_status: 'test',
    source_url: 'https://example.test',
  };

  registry.register(provider);
  assert.throws(() => registry.register(provider), /already registered/);
});

test('USGS adapter normalizes a GeoJSON feature', async () => {
  const adapter = createUsgsEarthquakesAdapter({
    now: () => new Date('2026-09-24T00:01:00Z'),
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return {
          features: [
            {
              id: 'quake-1',
              geometry: {
                type: 'Point',
                coordinates: [127.1, 37.5, 12.3],
              },
              properties: {
                time: Date.parse('2026-09-24T00:00:00Z'),
                mag: 4.2,
                place: 'test location',
                status: 'reviewed',
                tsunami: 0,
                sig: 271,
                url: 'https://earthquake.usgs.gov/example',
              },
            },
          ],
        };
      },
    }),
  });

  const observations = await adapter.query({
    filters: { min_magnitude: 4 },
    ingestionRunId: 'run-usgs-1',
  });

  assert.equal(observations.length, 1);
  assert.equal(observations[0].provider_id, 'usgs-earthquakes-all-hour');
  assert.equal(observations[0].properties.magnitude, 4.2);
  assert.equal(observations[0].freshness_seconds, 60);
});

test('world.query aggregates providers without hiding provider failures', async () => {
  const good = {
    metadata: {
      provider_id: 'good',
      category: 'test',
      geography: 'global',
      auth_mode: 'keyless',
      cost_class: 'free',
      update_frequency: 'test',
      latency: 'test',
      coverage: 'test',
      license_class: 'test',
      commercial_allowed: false,
      attribution_required: false,
      retention_policy: 'test-only',
      reliability: 'test',
      adapter_status: 'test',
      source_url: 'https://example.test/good',
    },
    async query() {
      return [];
    },
  };

  const bad = {
    metadata: {
      ...good.metadata,
      provider_id: 'bad',
      source_url: 'https://example.test/bad',
    },
    async query() {
      throw new Error('provider unavailable');
    },
  };

  const engine = createWorldQueryEngine({
    adapters: [good, bad],
    now: () => new Date('2026-09-24T00:00:00Z'),
  });

  const result = await engine.query();
  assert.deepEqual(
    result.providers.map(({ provider_id, ok }) => [provider_id, ok]),
    [
      ['good', true],
      ['bad', false],
    ],
  );
  assert.match(result.providers[1].error, /provider unavailable/);
});
