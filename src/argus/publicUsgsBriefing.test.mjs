import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPublicUsgsBriefing } from './publicUsgsBriefing.js';

const end = '2026-10-25T01:35:00Z';
const source = 'https://earthquake.usgs.gov/earthquakes/eventpage/demo';
function result(items = []) {
  return {
    contract_id: 'argus-nexus-verified-query-v0.1',
    operation: 'query', verified: true,
    data: { mode: 'history', time: { end }, count: items.length, observations: items },
    evidence: {
      observation_ids: items.map(x => x.observation_id),
      source_urls: items.map(x => x.source_url),
    },
    health: {
      degraded: items.length ? false : null, partial_failure: false,
      ingestion_runs: items.length ? [{ status: 'SUCCEEDED' }] : [],
      requested_providers: [{
        provider_id: 'usgs-earthquakes-all-hour',
        state: items.length ? 'OK' : 'NO_DATA',
        run: { status: 'SUCCEEDED' },
      }],
    },
  };
}
function item(extra = {}) {
  return {
    observation_id: 'obs-demo', provider_id: 'usgs-earthquakes-all-hour',
    timestamp_observed: '2026-10-25T01:34:00Z', source_url: source,
    properties: { magnitude: 2.5, place: 'Pacific\nRegion' }, ...extra,
  };
}

test('verified public observation becomes a source-linked readable briefing', () => {
  const text = renderPublicUsgsBriefing(result([item()]));
  assert.match(text, /M2\.5 \| Pacific Region \| 2026-10-25T01:34:00\.000Z/);
  assert.match(text, /출처: https:\/\/earthquake\.usgs\.gov\/earthquakes\/eventpage\/demo/);
  assert.doesNotMatch(text, /Pacific\nRegion/);
});

test('valid empty feed is not misrepresented as no earthquakes', () => {
  const text = renderPublicUsgsBriefing(result());
  assert.match(text, /관측 결과: 0건/);
  assert.match(text, /지진이 없었다는 뜻은 아닙니다/);
});

test('degraded, missing evidence and mismatched counts fail closed', () => {
  const degraded = result([item()]); degraded.health.degraded = true;
  assert.throws(() => renderPublicUsgsBriefing(degraded), /UNVERIFIED/);
  const missing = result([item()]); missing.evidence.observation_ids = [];
  assert.throws(() => renderPublicUsgsBriefing(missing), /UNTRUSTED/);
  const count = result([item()]); count.data.count = 2;
  assert.throws(() => renderPublicUsgsBriefing(count), /COUNT/);
});

test('untrusted, future, stale and invalid observed times never render', () => {
  for (const bad of [
    { source_url: 'https://earthquake.usgs.gov.evil.test/obs' },
    { source_url: 'http://earthquake.usgs.gov/obs' },
    { timestamp_observed: '2026-10-25T01:36:00Z' },
    { timestamp_observed: '2026-10-24T23:34:00Z' },
    { timestamp_observed: 'not-a-date' },
  ]) {
    assert.throws(() => renderPublicUsgsBriefing(result([item(bad)])));
  }
});
