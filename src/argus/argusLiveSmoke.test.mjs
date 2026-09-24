import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runArgusSmoke } from '../../scripts/argus-smoke.mjs';

test(
  'ARGUS live USGS smoke validates the provider path',
  { timeout: 30_000 },
  async () => {
    const summary = await runArgusSmoke();

    assert.equal(summary.provider_id, 'usgs-earthquakes-all-hour');
    assert.equal(summary.provider_ok, true);
    assert.equal(Number.isInteger(summary.observation_count), true);
    assert.equal(summary.observation_count >= 0, true);
    assert.match(summary.ingestion_run_id, /^argus-smoke-/);
    assert.equal(Number.isFinite(summary.latency_ms), true);
  },
);
