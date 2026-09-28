import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARGUS_NEXUS_QUERY_CONTRACT_ID,
  createNexusVerifiedQueryAdapter,
} from './nexusVerifiedQuery.js';

function evidence() {
  return {
    provider_ids: ['provider-a'],
    observation_ids: ['obs-1'],
    ingestion_run_ids: ['00000000-0000-4000-8000-00000000a001'],
    source_artifact_ids: [],
    source_urls: ['https://example.test/obs-1'],
    timestamps: {
      observed: { min: '2026-09-28T00:00:00Z', max: '2026-09-28T00:00:00Z' },
      effective: { min: '2026-09-28T00:00:00Z', max: '2026-09-28T00:00:00Z' },
      received: { min: '2026-09-28T00:00:01Z', max: '2026-09-28T00:00:01Z' },
      ingested: { min: '2026-09-28T00:00:02Z', max: '2026-09-28T00:00:02Z' },
    },
    canonical_validity: [],
    supersessions: [],
    staleness_seconds: 2,
    conflicts: [],
    conflict_count: 0,
  };
}

function worldFixture() {
  const calls = [];
  const payload = {
    found: true,
    count: 1,
    state: { entity_id: 'entity-1' },
    evidence: evidence(),
  };
  return {
    calls,
    world: {
      repository: {
        async getIngestionRun(id) {
          return {
            ingestion_run_id: id,
            provider_id: 'provider-a',
            status: 'SUCCEEDED',
            metadata: { degraded: false, retry_count: 0 },
          };
        },
      },
      async get(...args) {
        calls.push(['get', ...args]);
        return structuredClone(payload);
      },
      async history(...args) {
        calls.push(['history', ...args]);
        return {
          count: 1,
          observations: [{ entity_id: 'entity-1' }],
          evidence: evidence(),
        };
      },
      async query(options) {
        calls.push(['query', options]);
        return {
          mode: 'snapshot',
          count: 1,
          states: [{ entity_id: 'entity-1' }],
          evidence: evidence(),
        };
      },
      async near(options) {
        calls.push(['near', options]);
        return {
          mode: 'snapshot',
          count: 1,
          results: [
            { distance_km: 0.2, observation: { entity_id: 'entity-1' } },
          ],
          evidence: evidence(),
        };
      },
    },
  };
}

test('NEXUS adapter preserves current-state evidence and ingestion health', async () => {
  const fixture = worldFixture();
  const adapter = createNexusVerifiedQueryAdapter({ world: fixture.world });
  const result = await adapter.execute({
    operation: 'current',
    identity: {
      provider_ids: ['provider-a'],
      entity_type: 'asset',
      provider_entity_id: 'entity-1',
    },
  });

  assert.equal(result.contract_id, ARGUS_NEXUS_QUERY_CONTRACT_ID);
  assert.equal(result.verified, true);
  assert.equal(result.data.found, true);
  assert.deepEqual(result.evidence.observation_ids, ['obs-1']);
  assert.equal(result.health.degraded, false);
  assert.equal(result.health.ingestion_runs[0].status, 'SUCCEEDED');
  assert.equal(fixture.calls[0][0], 'get');
});

test('NEXUS adapter exposes official current/history/query/near operations only', async () => {
  const fixture = worldFixture();
  const adapter = createNexusVerifiedQueryAdapter({ world: fixture.world });

  await adapter.execute({
    operation: 'history',
    identity: {
      provider_ids: ['provider-a'],
      entity_type: 'asset',
      provider_entity_id: 'entity-1',
    },
    start: '2026-09-28T00:00:00Z',
    end: '2026-09-28T00:10:00Z',
  });
  await adapter.execute({
    operation: 'query',
    area: [126, 37, 128, 38],
    time: '2026-09-28T00:05:00Z',
    type: 'asset',
  });
  await adapter.execute({
    operation: 'near',
    point: [127.1, 37.5],
    radius_km: 10,
  });

  assert.deepEqual(
    fixture.calls.map((item) => item[0]),
    ['history', 'query', 'near'],
  );
});

test('NEXUS adapter fails closed on malformed provenance', async () => {
  const fixture = worldFixture();
  fixture.world.get = async () => ({
    found: true,
    state: { entity_id: 'entity-1' },
    evidence: { ...evidence(), conflict_count: 2 },
  });
  const adapter = createNexusVerifiedQueryAdapter({ world: fixture.world });
  await assert.rejects(
    () =>
      adapter.execute({
        operation: 'current',
        identity: {
          provider_ids: ['provider-a'],
          entity_type: 'asset',
          provider_entity_id: 'entity-1',
        },
      }),
    /conflict_count/,
  );
});
