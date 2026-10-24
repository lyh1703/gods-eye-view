import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectFreshLatest, validateFreshLatestOptions } from './freshLatest.js';
import { createWorldQueryEngine } from './worldQuery.js';

const asOf = '2026-10-24T02:35:00Z';
const item = (provider_id, entity_id, timestamp_observed, extra = {}) => ({
  provider_id, entity_type: 'earthquake', entity_id, timestamp_observed,
  source_url: `https://example.org/${provider_id}/${entity_id}`, ...extra,
});
const result = (provider_id, observations, ok = true) => ({
  provider_id, ok, error: ok ? null : 'upstream unavailable', observations,
});

test('latest is newest-per-provider-entity and keeps source provenance', () => {
  const old = item('usgs', 'q1', '2026-10-24T02:33:00Z');
  const newest = item('usgs', 'q1', '2026-10-24T02:34:00Z');
  const other = item('other', 'q1', '2026-10-24T02:34:30Z');
  const out = selectFreshLatest([result('usgs', [old, newest]), result('other', [other])], { asOf });
  assert.equal(out.status, 'OK');
  assert.deepEqual(out.observations, [other, newest]);
  assert.equal(out.total_fresh_entities, 2);
  assert.equal(out.observations[1].source_url, newest.source_url);
});

test('future, stale, malformed, and provider-spoofed observations are excluded', () => {
  const out = selectFreshLatest([result('usgs', [
    item('usgs', 'future', '2026-10-24T02:35:01Z'),
    item('usgs', 'stale', '2026-10-24T02:19:59Z'),
    item('usgs', 'naive', '2026-10-24T02:34:00'),
    item('other', 'spoof', '2026-10-24T02:34:00Z'),
  ])], { asOf });
  assert.equal(out.status, 'NO_FRESH_DATA');
  assert.deepEqual(out.excluded, { invalid: 1, provider_mismatch: 1, future: 1, stale: 1 });
  assert.deepEqual(out.observations, []);
});

test('provider failure is explicit even with healthy observations', () => {
  const out = selectFreshLatest([
    result('usgs', [item('usgs', 'q1', '2026-10-24T02:34:00Z')]),
    result('other', [item('other', 'hidden', '2026-10-24T02:34:00Z')], false),
  ], { asOf });
  assert.equal(out.status, 'PARTIAL_PROVIDER_FAILURE');
  assert.equal(out.observations.length, 1);
  assert.equal(out.providers[1].error, 'upstream unavailable');
});

test('limits are strict, deterministic and cannot trigger unlimited output', () => {
  assert.throws(() => validateFreshLatestOptions({ limit: 0 }), /limit/);
  assert.throws(() => validateFreshLatestOptions({ limit: 501 }), /limit/);
  assert.throws(() => validateFreshLatestOptions({ staleAfterSeconds: -1 }), /stale/);
  const out = selectFreshLatest([result('usgs', [
    item('usgs', 'q1', '2026-10-24T02:34:00Z'),
    item('usgs', 'q2', '2026-10-24T02:34:01Z'),
  ])], { asOf, limit: 1 });
  assert.equal(out.truncated, true);
  assert.equal(out.total_fresh_entities, 2);
  assert.equal(out.observations[0].entity_id, 'q2');
});

test('world.latest queries adapters and returns a usable bounded read-only feed', async () => {
  const metadata = {
    provider_id: 'usgs', category: 'test', geography: 'global', auth_mode: 'keyless',
    cost_class: 'free', update_frequency: 'test', latency: 'test', coverage: 'test',
    license_class: 'test', commercial_allowed: false, attribution_required: false,
    retention_policy: 'test', reliability: 'test', adapter_status: 'test',
    source_url: 'https://example.org/usgs',
  };
  const engine = createWorldQueryEngine({
    now: () => new Date(asOf),
    adapters: [{
      metadata,
      async query() {
        return [
          item('usgs', 'quake-1', '2026-10-24T02:34:00Z'),
          item('usgs', 'quake-1', '2026-10-24T02:33:00Z'),
        ];
      },
    }],
  });
  const feed = await engine.latest({ limit: 1 });
  assert.equal(feed.status, 'OK');
  assert.equal(feed.observations[0].entity_id, 'quake-1');
  assert.equal(feed.observations[0].timestamp_observed, '2026-10-24T02:34:00Z');
  assert.equal(feed.providers[0].ok, true);
});
