import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createObservationEnvelope } from '../observationEnvelope.js';

const RUN_ID = '00000000-0000-4000-8000-00000000a001';

function observation({
  observationId,
  providerId = 'provider-a',
  entityId = 'asset-1',
  entityType = 'asset',
  observationType = 'position',
  observedAt,
  coordinates = [126.9, 37.5],
  value,
  canonicalEntityId = null,
  supersedesObservationId = null,
}) {
  return createObservationEnvelope({
    observation_id: observationId,
    provider_id: providerId,
    entity_type: entityType,
    entity_id: entityId,
    canonical_entity_id: canonicalEntityId,
    observation_type: observationType,
    timestamp_observed: observedAt,
    timestamp_received: observedAt,
    effective_at: observedAt,
    geometry: coordinates ? { type: 'Point', coordinates } : null,
    properties: { value },
    source_url: 'https://example.test/' + providerId + '/' + entityId,
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: false,
    retention_policy: 'test-only',
    rate_limit_class: 'test',
    ingestion_run_id: RUN_ID,
    supersedes_observation_id: supersedesObservationId,
  });
}

async function prepare(context) {
  await context.seedProvider?.('provider-a');
  await context.seedProvider?.('provider-b');
  await context.repository.saveIngestionRun({
    ingestion_run_id: RUN_ID,
    provider_id: 'provider-a',
    started_at: '2026-09-28T00:00:00Z',
    completed_at: null,
    status: 'RUNNING',
    metadata: { suite: true },
  });
}

export function registerWorldMemoryRepositoryContract(label, makeContext) {
  test(
    label + ' appends and queries evidence in observed-time order',
    async () => {
      const context = await makeContext();
      try {
        await prepare(context);
        const result = await context.repository.appendObservations([
          observation({
            observationId: '00000000-0000-4000-8000-00000000b001',
            observedAt: '2026-09-28T00:00:00Z',
            value: 1,
          }),
          observation({
            observationId: '00000000-0000-4000-8000-00000000b002',
            observedAt: '2026-09-28T00:01:00Z',
            value: 2,
          }),
        ]);
        assert.equal(result.inserted, 2);

        const rows = await context.repository.queryObservations({
          order: 'asc',
        });
        assert.deepEqual(
          rows.map((item) => item.properties.value),
          [1, 2],
        );
      } finally {
        await context.cleanup?.();
      }
    },
  );

  test(label + ' rejects an invalid batch before partial append', async () => {
    const context = await makeContext();
    try {
      await prepare(context);
      const good = observation({
        observationId: '00000000-0000-4000-8000-00000000b011',
        observedAt: '2026-09-28T00:00:00Z',
        value: 1,
      });
      const invalid = { ...good, provider_id: '' };

      await assert.rejects(
        context.repository.appendObservations([good, invalid]),
        /invalid observation/,
      );
      const rows = await context.repository.queryObservations();
      assert.equal(rows.length, 0);
    } finally {
      await context.cleanup?.();
    }
  });

  test(label + ' preserves provider-scoped entity history', async () => {
    const context = await makeContext();
    try {
      await prepare(context);
      await context.repository.saveIngestionRun({
        ingestion_run_id: '00000000-0000-4000-8000-00000000a002',
        provider_id: 'provider-b',
        started_at: '2026-09-28T00:00:00Z',
        completed_at: null,
        status: 'RUNNING',
      });

      const providerB = observation({
        observationId: '00000000-0000-4000-8000-00000000b021',
        providerId: 'provider-b',
        observedAt: '2026-09-28T00:01:00Z',
        value: 8,
      });
      providerB.ingestion_run_id = '00000000-0000-4000-8000-00000000a002';

      await context.repository.appendObservations([
        observation({
          observationId: '00000000-0000-4000-8000-00000000b022',
          observedAt: '2026-09-28T00:00:00Z',
          value: 1,
        }),
        providerB,
        observation({
          observationId: '00000000-0000-4000-8000-00000000b023',
          observedAt: '2026-09-28T00:02:00Z',
          value: 3,
        }),
      ]);

      const history = await context.repository.getEntityHistory({
        entity_type: 'asset',
        provider_entity_id: 'asset-1',
        provider_ids: ['provider-a'],
        from: '2026-09-28T00:00:30Z',
        to: '2026-09-28T00:03:00Z',
      });
      assert.deepEqual(
        history.map((item) => item.properties.value),
        [3],
      );
    } finally {
      await context.cleanup?.();
    }
  });

  test(label + ' returns nearby points ordered by exact distance', async () => {
    const context = await makeContext();
    try {
      await prepare(context);
      await context.repository.appendObservations([
        observation({
          observationId: '00000000-0000-4000-8000-00000000b031',
          entityId: 'near',
          observedAt: '2026-09-28T00:00:00Z',
          coordinates: [126.9005, 37.5],
          value: 1,
        }),
        observation({
          observationId: '00000000-0000-4000-8000-00000000b032',
          entityId: 'farther',
          observedAt: '2026-09-28T00:01:00Z',
          coordinates: [126.91, 37.5],
          value: 2,
        }),
        observation({
          observationId: '00000000-0000-4000-8000-00000000b033',
          entityId: 'outside',
          observedAt: '2026-09-28T00:02:00Z',
          coordinates: [127.5, 37.5],
          value: 3,
        }),
      ]);

      const rows = await context.repository.queryNearby({
        center: [126.9, 37.5],
        radius_km: 2,
      });
      assert.deepEqual(
        rows.map((item) => item.observation.entity_id),
        ['near', 'farther'],
      );
      assert.equal(rows[0].distance_km < rows[1].distance_km, true);
    } finally {
      await context.cleanup?.();
    }
  });

  test(label + ' round-trips ingestion-run state', async () => {
    const context = await makeContext();
    try {
      await context.seedProvider?.('provider-a');
      const saved = await context.repository.saveIngestionRun({
        ingestion_run_id: RUN_ID,
        provider_id: 'provider-a',
        started_at: '2026-09-28T00:00:00Z',
        completed_at: null,
        status: 'RUNNING',
        metadata: { attempt: 1 },
      });
      assert.equal(saved.status, 'RUNNING');

      const completed = await context.repository.saveIngestionRun({
        ...saved,
        completed_at: '2026-09-28T00:01:00Z',
        status: 'SUCCEEDED',
      });
      assert.equal(completed.status, 'SUCCEEDED');

      const reread = await context.repository.getIngestionRun(RUN_ID);
      assert.equal(reread.completed_at, '2026-09-28T00:01:00.000Z');
    } finally {
      await context.cleanup?.();
    }
  });
}