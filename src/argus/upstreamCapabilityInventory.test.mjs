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
      assert.equal(capability.status.implemented, true);
    }
    if (capability.status.implemented) {
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

test('recovered high-value providers are mapped without overclaiming operational status', () => {
  const mapped = listUpstreamGevCapabilities({ mapped_to_argus: true }).map(
    ({ capability_id }) => capability_id,
  );
  assert.deepEqual(mapped, [
    'aviation-flights',
    'ais-vessels',
    'regional-weather',
    'traffic-flow',
    'transit',
    'cctv',
    'fire-firms',
    'earthquakes',
    'space-satellites',
    'radio',
  ]);
  for (const capabilityId of [
    'aviation-flights',
    'regional-weather',
    'traffic-flow',
  ]) {
    const status = getUpstreamGevCapability(capabilityId)?.status;
    assert.equal(status?.query_callable, true);
    assert.equal(status?.validated, true);
    assert.equal(status?.operational, false);
  }
  for (const capabilityId of [
    'ais-vessels',
    'fire-firms',
    'cctv',
    'radio',
  ]) {
    const status = getUpstreamGevCapability(capabilityId)?.status;
    assert.equal(status?.mapped_to_argus, true);
    assert.equal(status?.implemented, true);
    assert.equal(status?.query_callable, true);
    assert.equal(status?.validated, false);
    assert.equal(status?.operational, false);
  }
  const spaceStatus = getUpstreamGevCapability('space-satellites')?.status;
  assert.equal(spaceStatus?.mapped_to_argus, true);
  assert.equal(spaceStatus?.implemented, true);
  assert.equal(spaceStatus?.query_callable, true);
  assert.equal(spaceStatus?.validated, true);
  assert.equal(spaceStatus?.operational, false);

  const transit = getUpstreamGevCapability('transit')?.status;
  assert.equal(transit?.mapped_to_argus, true);
  assert.equal(transit?.implemented, true);
  assert.equal(transit?.query_callable, true);
  assert.equal(transit?.validated, true);
  assert.equal(transit?.operational, false);
  // A live feed E2E proves data validation, not a deployed monitored service.
  const quake = getUpstreamGevCapability('earthquakes')?.status;
  assert.equal(quake?.validated, true);
  assert.equal(quake?.operational, false);
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
    UPSTREAM_GEV_CAPABILITY_INVENTORY.length - 10,
  );
});
