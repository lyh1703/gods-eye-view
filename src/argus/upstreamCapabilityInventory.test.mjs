import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  UPSTREAM_GEV_CAPABILITY_INVENTORY,
  getUpstreamGevCapability,
  listUpstreamGevCapabilities,
} from './upstreamCapabilityInventory.js';

test('inherited GEV capability inventory covers the current provider/layer surface', () => {
  const ids = new Set(
    UPSTREAM_GEV_CAPABILITY_INVENTORY.map(({ capability_id }) => capability_id),
  );

  for (const required of [
    'aviation-flights',
    'local-adsb',
    'ais-vessels',
    'weather-imagery',
    'regional-weather',
    'wind-fields',
    'traffic-flow',
    'transit',
    'bikeshare',
    'directions',
    'cctv',
    'alpr-cameras',
    'fire-firms',
    'fire-perimeters',
    'cyclones',
    'earthquakes',
    'space-satellites',
    'rocket-launches',
    'recent-imagery',
    'submarine-cables',
    'military-awareness',
    'military-flights',
    'military-installations',
    'radio',
    'regional-briefing',
    'places',
    'overpass-map-context',
    'terrain',
  ]) {
    assert.equal(ids.has(required), true, `missing capability: ${required}`);
  }

  assert.ok(
    UPSTREAM_GEV_CAPABILITY_INVENTORY.length >= 28,
    'inventory unexpectedly regressed to the initial small surface',
  );
});

test('inventory code paths exist and lifecycle status cannot overclaim inherited code', () => {
  for (const capability of UPSTREAM_GEV_CAPABILITY_INVENTORY) {
    assert.equal(capability.status.inherited_present, true);
    assert.ok(capability.code_paths.length > 0);

    if (capability.status.operational) {
      assert.equal(capability.status.validated, true);
    }
    if (capability.status.validated) {
      assert.equal(capability.status.query_callable, true);
    }
    if (capability.status.query_callable) {
      assert.equal(capability.status.mapped_to_argus, true);
    }

    for (const codePath of capability.code_paths) {
      assert.equal(
        existsSync(resolve(process.cwd(), codePath)),
        true,
        `missing inherited path: ${codePath}`,
      );
    }
  }
});

test('only already-integrated earthquake capability is mapped before recovery adapters land', () => {
  const mapped = listUpstreamGevCapabilities({ mapped_to_argus: true }).map(
    ({ capability_id }) => capability_id,
  );
  assert.deepEqual(mapped, ['earthquakes']);
  assert.equal(getUpstreamGevCapability('earthquakes')?.status.operational, true);
});

test('capability inventory supports domain and lifecycle filters', () => {
  assert.deepEqual(
    listUpstreamGevCapabilities({ domain: 'aviation' }).map(
      ({ capability_id }) => capability_id,
    ),
    ['aviation-flights', 'local-adsb'],
  );
  assert.equal(
    listUpstreamGevCapabilities({ query_callable: false }).length,
    UPSTREAM_GEV_CAPABILITY_INVENTORY.length - 1,
  );
});
