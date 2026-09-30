import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  UPSTREAM_GEV_CAPABILITY_INVENTORY,
  listUpstreamGevCapabilities,
} from './upstreamCapabilityInventory.js';

test('inherited GEV capability inventory keeps critical real-world surfaces visible', () => {
  const ids = new Set(
    UPSTREAM_GEV_CAPABILITY_INVENTORY.map(({ capability_id }) => capability_id),
  );

  for (const required of [
    'aviation-flights',
    'local-adsb',
    'ais-vessels',
    'weather',
    'traffic',
    'cctv',
    'space-satellites-launches',
    'fire-firms',
    'transit',
    'radio',
  ]) {
    assert.equal(ids.has(required), true, `missing capability: ${required}`);
  }
});

test('inventory code paths exist in the inherited GEV codebase', () => {
  for (const capability of UPSTREAM_GEV_CAPABILITY_INVENTORY) {
    assert.equal(capability.argus_status, 'inherited_present_unmapped');
    assert.ok(capability.code_paths.length > 0);

    for (const codePath of capability.code_paths) {
      assert.equal(
        existsSync(resolve(process.cwd(), codePath)),
        true,
        `missing inherited path: ${codePath}`,
      );
    }
  }
});

test('capability inventory can be filtered by domain', () => {
  assert.deepEqual(
    listUpstreamGevCapabilities({ domain: 'aviation' }).map(
      ({ capability_id }) => capability_id,
    ),
    ['aviation-flights', 'local-adsb'],
  );
});
