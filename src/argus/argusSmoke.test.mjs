import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runArgusSmoke } from '../../scripts/argus-smoke.mjs';

test('ARGUS smoke command validates a normalized provider result', async () => {
  const now = () => new Date('2026-09-24T00:01:00Z');
  const summary = await runArgusSmoke({
    now,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          features: [
            {
              id: 'smoke-quake-1',
              geometry: {
                type: 'Point',
                coordinates: [127.1, 37.5, 5],
              },
              properties: {
                time: Date.parse('2026-09-24T00:00:00Z'),
                mag: 2.5,
                place: 'smoke fixture',
                status: 'reviewed',
                tsunami: 0,
                sig: 50,
                url: 'https://example.test/smoke-quake-1',
              },
            },
          ],
        };
      },
    }),
  });

  assert.equal(summary.provider_id, 'usgs-earthquakes-all-hour');
  assert.equal(summary.provider_ok, true);
  assert.equal(summary.observation_count, 1);
  assert.equal(summary.as_of, '2026-09-24T00:01:00.000Z');
  assert.equal(
    summary.ingestion_run_id,
    'argus-smoke-2026-09-24T00:01:00.000Z',
  );
  assert.equal(Number.isFinite(summary.latency_ms), true);
});
