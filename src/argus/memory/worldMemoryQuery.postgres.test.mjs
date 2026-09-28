import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createObservationEnvelope,
  createPostgresWorldMemoryRepository,
  createWorldMemoryQueryEngine,
} from '../index.js';

const url = process.env.ARGUS_POSTGRES_TEST_URL;
const CANONICAL_ID = '00000000-0000-4000-8000-00000000c401';
const RUN_A = '00000000-0000-4000-8000-00000000a401';
const RUN_B = '00000000-0000-4000-8000-00000000a402';

if (!url) {
  test(
    'World Memory temporal Postgres integration requires ARGUS_POSTGRES_TEST_URL',
    { skip: true },
    () => {},
  );
} else {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });

  async function reset() {
    await pool.query(
      `TRUNCATE
        argus_world.lineage_edges,
        argus_world.event_entities,
        argus_world.event_observations,
        argus_world.events,
        argus_world.observation_retractions,
        argus_world.entity_aliases,
        argus_world.entity_external_ids,
        argus_world.entity_relations,
        argus_world.observations,
        argus_world.source_artifacts,
        argus_world.ingestion_runs,
        argus_world.entities,
        argus_world.providers
      RESTART IDENTITY CASCADE`,
    );
  }

  async function seed() {
    await reset();
    await pool.query(
      `
        INSERT INTO argus_world.providers (
          provider_id,
          category,
          geography,
          license_class,
          commercial_allowed,
          attribution_required,
          retention_policy,
          adapter_status
        ) VALUES
          ('provider-a', 'test', 'global', 'test', false, false, 'test-only', 'test'),
          ('provider-b', 'test', 'global', 'test', false, false, 'test-only', 'test'),
          ('provider-c', 'test', 'global', 'test', false, false, 'test-only', 'test')
      `,
    );
    await pool.query(
      `
        INSERT INTO argus_world.entities (
          entity_id,
          entity_type,
          canonical_name,
          valid_from,
          valid_to
        ) VALUES (
          $1::uuid,
          'asset',
          'Temporal Gate Asset',
          '2026-09-28T00:00:00Z',
          '2026-09-28T00:30:00Z'
        )
      `,
      [CANONICAL_ID],
    );

    const repository = createPostgresWorldMemoryRepository({
      db: pool,
      now: () => new Date('2026-09-28T00:20:00Z'),
    });

    for (const [runId, providerId] of [
      [RUN_A, 'provider-a'],
      [RUN_B, 'provider-b'],
      ['00000000-0000-4000-8000-00000000a403', 'provider-c'],
    ]) {
      await repository.saveIngestionRun({
        ingestion_run_id: runId,
        provider_id: providerId,
        started_at: '2026-09-28T00:00:00Z',
        status: 'RUNNING',
      });
    }

    const make = ({
      id,
      providerId,
      runId,
      entityId = 'asset-1',
      observedAt,
      effectiveAt = observedAt,
      ingestedAt = observedAt,
      coordinates,
      value,
      canonicalEntityId = CANONICAL_ID,
      supersedesObservationId = null,
    }) =>
      createObservationEnvelope({
        observation_id: id,
        provider_id: providerId,
        entity_type: 'asset',
        entity_id: entityId,
        canonical_entity_id: canonicalEntityId,
        observation_type: 'state',
        timestamp_observed: observedAt,
        effective_at: effectiveAt,
        timestamp_received: observedAt,
        ingested_at: ingestedAt,
        geometry: { type: 'Point', coordinates },
        properties: { value },
        source_url: 'https://example.test/' + providerId + '/' + entityId,
        license_class: 'test',
        commercial_allowed: false,
        attribution_required: false,
        retention_policy: 'test-only',
        rate_limit_class: 'test',
        ingestion_run_id: runId,
        supersedes_observation_id: supersedesObservationId,
      });

    await repository.appendObservations([
      make({
        id: '00000000-0000-4000-8000-00000000b401',
        providerId: 'provider-a',
        runId: RUN_A,
        observedAt: '2026-09-28T00:00:00Z',
        ingestedAt: '2026-09-28T00:00:30Z',
        coordinates: [126.9005, 37.5],
        value: 1,
      }),
      make({
        id: '00000000-0000-4000-8000-00000000b402',
        providerId: 'provider-a',
        runId: RUN_A,
        observedAt: '2026-09-28T00:06:00Z',
        effectiveAt: '2026-09-28T00:05:00Z',
        ingestedAt: '2026-09-28T00:06:30Z',
        coordinates: [127.5, 37.5],
        value: 2,
        supersedesObservationId: '00000000-0000-4000-8000-00000000b401',
      }),
      make({
        id: '00000000-0000-4000-8000-00000000b405',
        providerId: 'provider-a',
        runId: RUN_A,
        observedAt: '2026-09-28T00:10:00Z',
        effectiveAt: '2026-09-28T00:05:00Z',
        ingestedAt: '2026-09-28T00:10:30Z',
        coordinates: [127.5, 37.5],
        value: 3,
        supersedesObservationId: '00000000-0000-4000-8000-00000000b402',
      }),
      make({
        id: '00000000-0000-4000-8000-00000000b403',
        providerId: 'provider-b',
        runId: RUN_B,
        observedAt: '2026-09-28T00:07:00Z',
        effectiveAt: '2026-09-28T00:05:00Z',
        ingestedAt: '2026-09-28T00:07:30Z',
        coordinates: [126.91, 37.5],
        value: 99,
      }),
      make({
        id: '00000000-0000-4000-8000-00000000b406',
        providerId: 'provider-c',
        runId: '00000000-0000-4000-8000-00000000a403',
        observedAt: '2026-09-28T00:04:00Z',
        ingestedAt: '2026-09-28T00:04:30Z',
        coordinates: [126.906, 37.5],
        value: 77,
        canonicalEntityId: null,
      }),
      make({
        id: '00000000-0000-4000-8000-00000000b404',
        providerId: 'provider-a',
        runId: RUN_A,
        entityId: 'asset-2',
        observedAt: '2026-09-28T00:04:00Z',
        ingestedAt: '2026-09-28T00:04:30Z',
        coordinates: [126.905, 37.5],
        value: 8,
        canonicalEntityId: null,
      }),
    ]);

    return {
      repository,
      world: createWorldMemoryQueryEngine({
        repository,
        now: () => new Date('2026-09-28T00:20:00Z'),
      }),
    };
  }

  test('Postgres replay preserves T1 T2 T3 and blocks future corrections', async () => {
    const { world } = await seed();

    const t1 = await world.get(
      {
        entity_type: 'asset',
        entity_id: 'asset-1',
        provider_ids: ['provider-a'],
      },
      '2026-09-28T00:04:59Z',
    );
    assert.equal(t1.state.properties.value, 1);

    const t2 = await world.get(
      {
        entity_type: 'asset',
        entity_id: 'asset-1',
        provider_ids: ['provider-a'],
      },
      '2026-09-28T00:07:00Z',
    );
    assert.equal(t2.state.properties.value, 2);
    assert.equal(
      t2.evidence.observation_ids.includes(
        '00000000-0000-4000-8000-00000000b405',
      ),
      false,
    );

    const current = await world.get({
      entity_type: 'asset',
      entity_id: 'asset-1',
      provider_ids: ['provider-a'],
    });
    assert.equal(current.state.properties.value, 3);
    assert.equal(current.evidence.supersessions.length, 1);
  });

  test('Postgres canonical replay only combines explicitly linked providers', async () => {
    const { world } = await seed();

    const canonical = await world.get(CANONICAL_ID, '2026-09-28T00:09:00Z');
    assert.deepEqual(canonical.states.map((item) => item.provider_id).sort(), [
      'provider-a',
      'provider-b',
    ]);
    assert.equal(canonical.evidence.conflict_count, 1);
    assert.equal(
      canonical.evidence.canonical_validity[0].valid_from,
      '2026-09-28T00:00:00.000Z',
    );
    assert.equal(
      canonical.evidence.canonical_validity[0].valid_to,
      '2026-09-28T00:30:00.000Z',
    );

    const expired = await world.get(CANONICAL_ID, '2026-09-28T00:31:00Z');
    assert.equal(expired.found, false);
  });

  test('Postgres temporal spatial queries retain provenance', async () => {
    const { world } = await seed();

    const snapshot = await world.query(
      [126.8, 37.4, 127.0, 37.6],
      '2026-09-28T00:09:00Z',
      'asset',
    );
    assert.deepEqual(
      snapshot.states
        .map((item) => item.properties.value)
        .sort((a, b) => a - b),
      [8, 77, 99],
    );
    assert.equal(
      snapshot.evidence.observation_ids.includes(
        '00000000-0000-4000-8000-00000000b403',
      ),
      true,
    );

    const near = await world.near([126.9, 37.5], 2, '2026-09-28T00:09:00Z');
    assert.deepEqual(
      near.results
        .map((item) => item.observation.properties.value)
        .sort((a, b) => a - b),
      [8, 77, 99],
    );
    assert.equal(near.evidence.provider_ids.includes('provider-b'), true);
  });

  test('Postgres history and ingested-time basis remain explicit', async () => {
    const { world } = await seed();

    const history = await world.history(
      {
        entity_type: 'asset',
        entity_id: 'asset-1',
        provider_ids: ['provider-a'],
      },
      '2026-09-28T00:00:00Z',
      '2026-09-28T00:12:00Z',
    );
    assert.deepEqual(
      history.observations.map((item) => item.properties.value),
      [1, 2, 3],
    );
    assert.equal(
      history.evidence.timestamps.ingested.max,
      '2026-09-28T00:10:30.000Z',
    );

    const ingestionHistory = await world.history(
      {
        entity_type: 'asset',
        entity_id: 'asset-1',
        provider_ids: ['provider-a'],
      },
      '2026-09-28T00:06:00Z',
      '2026-09-28T00:11:00Z',
      { time_basis: 'ingested' },
    );
    assert.deepEqual(
      ingestionHistory.observations.map((item) => item.properties.value),
      [2, 3],
    );
  });

  test.after(async () => {
    await pool.end();
  });
}
