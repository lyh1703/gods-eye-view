import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runArgusLatestUsgs } from '../../scripts/argus-latest-usgs.mjs';

const CLOCK = new Date('2026-10-24T03:35:00.000Z');
const quake = (id, time) => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [127.1, 37.6, 9] },
  properties: {
    time: Date.parse(time), mag: 3.2, place: 'fixture only',
    status: 'reviewed', tsunami: 0, sig: 100,
    url: 'https://earthquake.usgs.gov/earthquakes/eventpage/' + id,
  },
});
const response = (features, status = 200) => ({
  ok: status === 200,
  status,
  async json() { return { type: 'FeatureCollection', features }; },
});

test('USGS adapter feeds latest read-only result with source and freshness', async () => {
  let requests = 0;
  const result = await runArgusLatestUsgs({
    now: () => CLOCK,
    fetchImpl: async (url) => {
      requests++;
      assert.equal(url, 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson');
      return response([
        quake('fresh', '2026-10-24T03:34:00Z'),
        quake('future', '2026-10-24T03:36:00Z'),
        quake('stale', '2026-10-24T02:30:00Z'),
      ]);
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.status, 'OK');
  assert.equal(result.read_only, true);
  assert.equal(result.operational_e2e_verified, false);
  assert.deepEqual(result.observations.map(x => x.entity_id), ['fresh']);
  assert.equal(result.excluded.future, 1);
  assert.equal(result.excluded.stale, 1);
  assert.match(result.observations[0].source_url, /earthquake.usgs.gov/);
  assert.equal(result.observations[0].attribution_required, true);
});

test('upstream HTTP failure is visible and never becomes a successful observation', async () => {
  const result = await runArgusLatestUsgs({
    now: () => CLOCK,
    fetchImpl: async () => response([], 503),
  });
  assert.equal(result.status, 'PARTIAL_PROVIDER_FAILURE');
  assert.equal(result.providers[0].ok, false);
  assert.match(result.providers[0].error, /HTTP 503/);
  assert.deepEqual(result.observations, []);
});

test('empty public feed is no fresh data, not a fabricated event', async () => {
  const result = await runArgusLatestUsgs({
    now: () => CLOCK,
    fetchImpl: async () => response([]),
  });
  assert.equal(result.status, 'NO_FRESH_DATA');
  assert.equal(result.providers[0].ok, true);
  assert.deepEqual(result.observations, []);
});
