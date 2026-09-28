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
          ('provider-b', 'test', 'global', 'test', false, false, 'test-only', 'test')
      `,
    );
    await pool.query(
      `
        INSERT INTO argus_world.entities (
          entity_id,
          entity_type,
          canonical_name
        ) VALUES ($1::uuid, 'asset', 'Temporal Gate Asset')
      `,
      [CANONICAL_ID],
    );

    const repository = createPostgresWorldMemoryRepository({
      db: pool,
      now: () => new Date('2026-09-28T00:20:00Z'),
    });
    await repository.saveIngestionRun({
      ingestion_run_id: RUN_A,
      provider_id: 'provider-a',
      started_at: '2026-09-28T00:00:00Z',
      status: 'RUNNING',
    });
    await repository.saveIngestionRun({
      ingestion_run_id: RUN_B,
      provider_id: 'provider-b',
      started_at: '2026-09-28T00:00:00Z',
      status: 'RUNNING',
    });

    const make = ({
      id,
      providerId,
      runId,
      entityId = 'asset-1',
      observedAt,
      effectiveAt,
      coordinates,
      value,
      canonicalEntityId = CANONICAL_ID,
    }) =>
      createObservationEnvelope({
        observation_id: id,
        provider_id: providerId,
        entity_type: 'asset',
        entity_id: entityId,
        canonical_entity_id: canonicalEntityId,
        observation_type: 'state',
        timestamp_observed: observedAt,
        effective_at: effectiveAt ?? observedAt,
        timestamp_received: observedAt,
        geometry: { type: 'Point', coordinates },
        properties: { value },
        source_url: 'https://example.test/' + providerId + '/' + entityId,
        license_class: 'test',
        commercial_allowed: false,
        attribution_required: false,
        retention_policy: 'test-only',
        rate_limit_class: 'test',
        ingestion_run_id: runId,
      });

    await repository.appendObservations([
      make({
        id: '00000000-0000-4000-8000-00000000b401',
        providerId: 'provider-a',
        runId: RUN_A,
        observedAt: '2026-09-28T00:00:00Z',
        coordinates: [126.9005, 37.5],
        value: 1,
      }),
      make({
        id: '00000000-0000-4000-8000-00000000b402',
        providerId: 'provider-a',
        runId: RUN_A,
        observedAt: '2026-09-28T00:10:00Z',
        effectiveAt: '2026-09-28T00:05:00Z',
        coordinates: [127.5, 37.5],
        value: 2,
      }),
      make({
        id: '00000000-0000-4000-8000-00000000b403',
        providerId: 'provider-b',
        runId: RUN_B,
        observedAt: '2026-09-28T00:09:00Z',
        coordinates: [126.91, 37.5],
        value: 99,
      }),
      make({
        id: '00000000-0000-4000-8000-00000000b404',
        providerId: 'provider-a',
        runId: RUN_A,
        entityId: 'asset-2',
        observedAt: '2026-09-28T00:04:00Z',
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

  test('Postgres world.get replays point-in-time state and explicit conflicts', async () => {
    const { world } = await seed();

    const before = await world.get(CANONICAL_ID, '2026-09-28T00:04:59Z');
    assert.equal(before.state.properties.value, 1);

    const after = await world.get(CANONICAL_ID, '2026-09-28T00:09:30Z');
    assert.deepEqual(
      after.states.map((item) => item.properties.value),
      [99, 2],
    );
    assert.equal(after.evidence.conflict_count, 1);
  });

  test('Postgres world.query and world.near reproduce historical spatial state', async () => {
    const { world } = await seed();

    const snapshot = await world.query(
      [126.8, 37.4, 128.0, 37.6],
      '2026-09-28T00:06:00Z',
      'asset',
    );
    assert.deepEqual(
      snapshot.states.map((item) => item.properties.value),
      [2, 8],
    );

    const beforeMove = await world.near(
      [126.9, 37.5],
      2,
      '2026-09-28T00:04:59Z',
    );
    assert.deepEqual(
      beforeMove.results.map((item) => item.observation.properties.value),
      [1, 8],
    );

    const afterMove = await world.near(
      [126.9, 37.5],
      2,
      '2026-09-28T00:06:00Z',
    );
    assert.deepEqual(
      afterMove.results.map((item) => item.observation.properties.value),
      [8],
    );
  });

  test.after(async () => {
    await pool.end();
  });
}
