import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  directionsUrl,
  findSavedPlace,
  loadPlaces,
  manualPlace,
  mapsSearchUrl,
  savePlaces,
} from './personalPlaces.js';

test('public Maps search links are only generated (no network)', () => {
  const link = new URL(mapsSearchUrl('인천 송도 맛집'));
  assert.equal(link.hostname, 'www.google.com');
  assert.equal(link.searchParams.get('query'), '인천 송도 맛집');
  assert.equal(link.searchParams.get('api'), '1');
});

test('routes come from manually entered place names and do not claim driving time', () => {
  const places = [
    { name: 'Restaurant A', area: 'Seoul' },
    { name: 'Park B', area: 'Incheon' },
    { name: 'Cafe C', area: 'Suwon' },
  ];
  const link = new URL(directionsUrl(places, 'walking'));
  assert.equal(link.searchParams.get('origin'), 'Restaurant A Seoul');
  assert.equal(link.searchParams.get('destination'), 'Cafe C Suwon');
  assert.equal(link.searchParams.get('waypoints'), 'Park B Incheon');
  assert.equal(link.searchParams.get('travelmode'), 'walking');
  assert.equal(link.searchParams.has('duration'), false);
});

test('reject empty query, invalid travel mode, and ungrounded route size', () => {
  assert.throws(() => mapsSearchUrl('  '));
  assert.throws(() => directionsUrl([{ name: 'A', area: 'X' }]));
  assert.throws(() =>
    directionsUrl(
      [{ name: 'A', area: 'X' }, { name: 'B', area: 'Y' }],
      'airplane',
    ),
  );
});

test('private local-only file stores only user-typed notes', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'personal-places-test-'));
  try {
    const file = path.join(root, 'places.json');
    assert.deepEqual(await loadPlaces(file), []);
    const a = manualPlace({ name: 'Owned Favorite', area: 'Incheon', note: 'my note' });
    await savePlaces([a], file);
    const readback = await loadPlaces(file);
    assert.equal(readback[0].source, 'USER_TYPED_ONLY');
    assert.equal(findSavedPlace(readback, a.id).name, 'Owned Favorite');
    const raw = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(raw.places[0].note, 'my note');
    await assert.rejects(
      savePlaces([{ ...a, source: 'SCRAPED_GOOGLE_MAPS' }], file),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('personal shortlist refuses out-of-bounds or unlabeled imported data', () => {
  assert.throws(() => manualPlace({ name: '', area: 'Seoul' }));
  assert.throws(() => manualPlace({ name: 'Place', area: '' }));
  assert.throws(() => manualPlace({ name: 'Place', area: 'Seoul', note: 'x'.repeat(1001) }));
});
