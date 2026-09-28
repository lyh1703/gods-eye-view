import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createPostgresWorldMemoryRepository } from './postgresRepository.js';
import { registerWorldMemoryRepositoryContract } from './worldMemoryContractSuite.mjs';

const url = process.env.ARGUS_POSTGRES_TEST_URL;

if (!url) {
  test('PostgresWorldMemory integration requires ARGUS_POSTGRES_TEST_URL', {
    skip: true,
  }, () => {});
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

  async function seedProvider(providerId) {
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
        ) VALUES ($1, 'test', 'global', 'test', false, false, 'test-only', 'test')
        ON CONFLICT (provider_id) DO NOTHING
      `,
      [providerId],
    );
  }

  registerWorldMemoryRepositoryContract('PostgresWorldMemory', async () => {
    await reset();
    return {
      repository: createPostgresWorldMemoryRepository({
        db: pool,
        now: () => new Date('2026-09-28T00:05:00Z'),
      }),
      seedProvider,
    };
  });

  test('PostgresWorldMemory rolls back the whole batch on database failure', async () => {
    await reset();
    await seedProvider('provider-a');
    const repository = createPostgresWorldMemoryRepository({ db: pool });
    await repository.saveIngestionRun({
      ingestion_run_id: '00000000-0000-4000-8000-00000000a010',
      provider_id: 'provider-a',
      started_at: '2026-09-28T00:00:00Z',
      status: 'RUNNING',
    });

    const base = {
      provider_id: 'provider-a',
      entity_type: 'asset',
      entity_id: 'asset-rollback',
      observation_type: 'position',
      timestamp_observed: '2026-09-28T00:00:00Z',
      timestamp_received: '2026-09-28T00:00:00Z',
      geometry: { type: 'Point', coordinates: [126.9, 37.5] },
      properties: {},
      freshness_seconds: 0,
      coverage: null,
      confidence: 1,
      license_class: 'test',
      commercial_allowed: false,
      attribution_required: false,
      retention_policy: 'test-only',
      source_url: 'https://example.test/rollback',
      rate_limit_class: 'test',
      ingestion_run_id: '00000000-0000-4000-8000-00000000a010',
    };

    await assert.rejects(
      repository.appendObservations([
        {
          ...base,
          observation_id: '00000000-0000-4000-8000-00000000b101',
        },
        {
          ...base,
          observation_id: '00000000-0000-4000-8000-00000000b102',
          canonical_entity_id: 'not-a-uuid',
        },
      ]),
      /uuid|invalid input syntax/i,
    );

    const count = await pool.query(
      'SELECT count(*)::integer AS count FROM argus_world.observations',
    );
    assert.equal(count.rows[0].count, 0);
  });

  test('PostgresWorldMemory persists canonical entity link and supersession', async () => {
    await reset();
    await seedProvider('provider-a');
    await pool.query(
      `
        INSERT INTO argus_world.entities (
          entity_id,
          entity_type,
          canonical_name
        ) VALUES (
          '00000000-0000-4000-8000-00000000c001',
          'asset',
          'Canonical Asset'
        )
      `,
    );

    const repository = createPostgresWorldMemoryRepository({ db: pool });
    await repository.saveIngestionRun({
      ingestion_run_id: '00000000-0000-4000-8000-00000000a020',
      provider_id: 'provider-a',
      started_at: '2026-09-28T00:00:00Z',
      status: 'RUNNING',
    });

    const make = (id, observedAt, value, supersedes = null) => ({
      observation_id: id,
      provider_id: 'provider-a',
      entity_type: 'asset',
      entity_id: 'asset-1',
      canonical_entity_id: '00000000-0000-4000-8000-00000000c001',
      observation_type: 'state',
      timestamp_observed: observedAt,
      timestamp_received: observedAt,
      effective_at: observedAt,
      geometry: { type: 'Point', coordinates: [126.9, 37.5] },
      properties: { value },
      freshness_seconds: 0,
      coverage: null,
      confidence: 1,
      license_class: 'test',
      commercial_allowed: false,
      attribution_required: false,
      retention_policy: 'test-only',
      source_url: 'https://example.test/asset-1',
      rate_limit_class: 'test',
      ingestion_run_id: '00000000-0000-4000-8000-00000000a020',
      supersedes_observation_id: supersedes,
    });

    await repository.appendObservations([
      make(
        '00000000-0000-4000-8000-00000000b201',
        '2026-09-28T00:00:00Z',
        1,
      ),
      make(
        '00000000-0000-4000-8000-00000000b202',
        '2026-09-28T00:01:00Z',
        2,
        '00000000-0000-4000-8000-00000000b201',
      ),
    ]);

    const rows = await repository.getEntityHistory({
      entity_type: 'asset',
      provider_entity_id: 'asset-1',
      order: 'asc',
    });

    assert.equal(
      rows[1].canonical_entity_id,
      '00000000-0000-4000-8000-00000000c001',
    );
    assert.equal(
      rows[1].supersedes_observation_id,
      '00000000-0000-4000-8000-00000000b201',
    );
  });

  test('PostgresWorldMemory surfaces connection failures', async () => {
    const failingDb = {
      async query() {
        throw new Error('connection refused');
      },
      async connect() {
        throw new Error('connection refused');
      },
    };
    const repository = createPostgresWorldMemoryRepository({ db: failingDb });
    await assert.rejects(
      repository.queryObservations(),
      /connection refused/,
    );
  });

  test.after(async () => {
    await pool.end();
  });
}
