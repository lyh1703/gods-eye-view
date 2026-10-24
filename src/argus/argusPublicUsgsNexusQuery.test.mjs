import test from 'node:test';
import assert from 'node:assert/strict';
import { runPublicUsgsNexusQuery } from '../../scripts/argus-public-usgs-nexus-query.mjs';

const CLOCK = new Date('2026-10-24T07:35:00Z');
function quake(id, observed, url = 'https://earthquake.usgs.gov/earthquakes/eventpage/' + id) {
  return {
    type: 'Feature', id,
    geometry: { type: 'Point', coordinates: [127.1, 37.6, 8] },
    properties: {
      time: Date.parse(observed), mag: 2.5, place: 'test fixture',
      status: 'reviewed', tsunami: 0, sig: 50, url,
    },
  };
}
function feed(features, status = 200) {
  return { ok: status === 200, status, async json() {
    return { type: 'FeatureCollection', features };
  } };
}

test('public USGS -> ephemeral World Memory -> official NEXUS verified query', async () => {
  let requests = 0;
  const result = await runPublicUsgsNexusQuery({
    now: () => CLOCK,
    fetchImpl: async (url) => {
      requests++;
      assert.equal(url, 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson');
      return feed([
        quake('fresh', '2026-10-24T07:34:00Z'),
        quake('stale', '2026-10-24T06:00:00Z'),
      ]);
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.contract_id, 'argus-nexus-verified-query-v0.1');
  assert.equal(result.operation, 'query');
  assert.equal(result.verified, true);
  assert.equal(result.data.mode, 'history');
  assert.deepEqual(result.data.observations.map(x => x.entity_id), ['fresh']);
  assert.equal(result.data.count, 1);
  assert.equal(result.data.observations[0].source_url, 'https://earthquake.usgs.gov/earthquakes/eventpage/fresh');
  assert.equal(result.data.observations[0].timestamp_observed, '2026-10-24T07:34:00.000Z');
  assert.equal(result.data.observations[0].timestamp_received, CLOCK.toISOString());
  assert.equal(result.data.observations[0].freshness_seconds, 60);
  assert.equal(result.evidence.observation_ids.length, 1);
  assert.equal(result.evidence.ingestion_run_ids.length, 1);
  assert.equal(result.health.ingestion_runs[0].status, 'SUCCEEDED');
});

test('empty public feed yields empty result, not a made-up event', async () => {
  const result = await runPublicUsgsNexusQuery({
    now: () => CLOCK, fetchImpl: async () => feed([]),
  });
  assert.equal(result.data.count, 0);
  assert.deepEqual(result.evidence.observation_ids, []);
});

test('HTTP provider error is not converted to successful empty result', async () => {
  await assert.rejects(() => runPublicUsgsNexusQuery({
    now: () => CLOCK, fetchImpl: async () => feed([], 503),
  }), /USGS_UNAVAILABLE/);
});

test('unexpected public URL cannot be passed as verified source', async () => {
  await assert.rejects(() => runPublicUsgsNexusQuery({
    now: () => CLOCK, fetchImpl: async () => feed([
      quake('bad', '2026-10-24T07:34:00Z', 'https://example.com/other'),
    ]),
  }), /UNTRUSTED_PUBLIC_OBSERVATION/);
});

test('query result size remains bounded before network request', async () => {
  let calls = 0;
  await assert.rejects(() => runPublicUsgsNexusQuery({
    limit: 999, fetchImpl: async () => { calls++; return feed([]); },
  }), /limit 1..25/);
  assert.equal(calls, 0);
});

for (const [name, features] of [
  ['future-only', [quake('future', '2026-10-24T07:36:00Z')]],
  ['mixed fresh+future', [
    quake('fresh', '2026-10-24T07:34:00Z'),
    quake('future', '2026-10-24T07:36:00Z'),
  ]],
]) {
  test(`${name} batch fails closed without a verified query result`, async () => {
    await assert.rejects(() => runPublicUsgsNexusQuery({
      now: () => CLOCK,
      fetchImpl: async () => feed(features),
    }), /^Error: USGS_UNAVAILABLE$/);
  });
}
