import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  directionsUrl,
  findSavedPlace,
  manualPlace,
  mapsSearchUrl,
  MAX_PLACES,
  MAX_PLACES_JSON_BYTES,
  PLACE_SCHEMA,
} from './personalPlaces.js';
import {
  loadPlaces,
  savePlaces,
} from '../../scripts/personal-places-storage.mjs';

async function isolatedStorage(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'personal-places-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: path.join(root, 'places.json') };
}

function savedPlace() {
  return manualPlace({ name: 'Owned Favorite', area: 'Incheon', note: 'my note' });
}

function document(places) {
  return { schema: PLACE_SCHEMA, places };
}

test('Maps search links contain only user-supplied query data', () => {
  const link = new URL(mapsSearchUrl('인천 송도 맛집'));
  assert.equal(link.hostname, 'www.google.com');
  assert.equal(link.searchParams.get('query'), '인천 송도 맛집');
  assert.equal(link.searchParams.get('api'), '1');
});

test('user-authored route link has no invented travel metrics', () => {
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

test('reject invalid query, travel mode, route size', () => {
  assert.throws(() => mapsSearchUrl('  '));
  assert.throws(() => directionsUrl([{ name: 'A', area: 'X' }]));
  const places = [{ name: 'A', area: 'X' }, { name: 'B', area: 'Y' }];
  assert.throws(() => directionsUrl(places, 'airplane'));
});

test('local-only persistence roundtrips and creates private POSIX files', async (t) => {
  const { file } = await isolatedStorage(t);
  assert.deepEqual(await loadPlaces(file), []);
  const a = savedPlace();
  for (const places of [[a], []]) {
    await savePlaces(places, file);
    assert.deepEqual(await loadPlaces(file), places);
    if (process.platform !== 'win32') {
      assert.equal((await lstat(file)).mode & 0o777, 0o600);
      // Replacement must also create a private file, even after a mode change.
      await chmod(file, 0o644);
    }
  }
  await savePlaces([a], file);
  assert.equal(findSavedPlace(await loadPlaces(file), a.id).name, a.name);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), document([a]));
});

test('exact top-level schema and malformed JSON fail without changing disk', async (t) => {
  const { root, file } = await isolatedStorage(t);
  const a = savedPlace();
  const invalidDocuments = [
    '{', '', 'null', '[]', '1', '"text"',
    JSON.stringify({ places: [a] }),
    JSON.stringify({ schema: PLACE_SCHEMA }),
    JSON.stringify({ schema: 'unknown', places: [a] }),
    JSON.stringify({ ...document([a]), importedFrom: 'Google Maps' }),
    JSON.stringify(document(null)),
    JSON.stringify(document({ 0: a, length: 1 })),
    JSON.stringify({ ...document([a]), ['__proto__']: {} }),
  ];
  for (const json of invalidDocuments) {
    await writeFile(file, json, { mode: 0o600 });
    await assert.rejects(loadPlaces(file));
    assert.equal(await readFile(file, 'utf8'), json);
    assert.deepEqual(await readdir(root), ['places.json']);
  }
});

test('invalid rows, duplicate IDs and counts fail on load and save without mutation', async (t) => {
  const { root, file } = await isolatedStorage(t);
  const a = savedPlace();
  const invalidRows = [null, [], true, 1, 'place', { ...a, importedFrom: 'Google Maps' }];
  for (const key of Object.keys(a)) {
    const missing = { ...a };
    delete missing[key];
    invalidRows.push(missing);
    for (const value of [null, {}, [], 1, false]) {
      invalidRows.push({ ...a, [key]: value });
    }
  }
  for (const [key, limit] of Object.entries({
    id: 100, name: 200, area: 200, category: 40,
  })) {
    for (const value of ['', '  ', 'x'.repeat(limit + 1)]) {
      invalidRows.push({ ...a, [key]: value });
    }
  }
  invalidRows.push(
    { ...a, note: 'x'.repeat(1001) },
    { ...a, source: '' },
    { ...a, source: 'SCRAPED_GOOGLE_MAPS' },
    { ...a, source: 'USER_TYPED_ONLY ' },
    { ...a, source: 'x'.repeat(1000) },
  );
  for (const createdAt of [
    '', 'yesterday', '2026-02-30T00:00:00.000Z', '2026-01-01',
    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000+00:00', 'x'.repeat(25),
  ]) {
    invalidRows.push({ ...a, createdAt });
  }
  const invalidLists = [
    null, {}, [a, { ...a, name: 'Duplicate' }],
    Array.from({ length: MAX_PLACES + 1 }, (_, index) => ({ ...a, id: String(index) })),
    [a, null], ...invalidRows.map((row) => [row]),
  ];
  const validJson = JSON.stringify(document([a]));
  for (const places of invalidLists) {
    const invalidJson = JSON.stringify(document(places));
    await writeFile(file, invalidJson, { mode: 0o600 });
    await assert.rejects(loadPlaces(file));
    assert.equal(await readFile(file, 'utf8'), invalidJson);

    await writeFile(file, validJson);
    const inputBefore = JSON.stringify(places);
    await assert.rejects(savePlaces(places, file));
    assert.equal(JSON.stringify(places), inputBefore);
    assert.equal(await readFile(file, 'utf8'), validJson);
    assert.deepEqual(await readdir(root), ['places.json']);
  }
  const absent = path.join(root, 'absent', 'places.json');
  await assert.rejects(savePlaces([{ ...a, extra: true }], absent));
  await assert.rejects(lstat(path.dirname(absent)), { code: 'ENOENT' });
});

test('save rejects accessors, serialization hooks, sparse rows and non-records', async (t) => {
  const { root, file } = await isolatedStorage(t);
  const a = savedPlace();
  await savePlaces([a], file);
  const before = await readFile(file);
  let invoked = false;
  const getter = { ...a };
  Object.defineProperty(getter, 'name', {
    enumerable: true,
    get() { invoked = true; return 'hidden'; },
  });
  const hook = { ...a, toJSON() { invoked = true; return a; } };
  const hidden = { ...a };
  Object.defineProperty(hidden, 'note', { enumerable: false });
  const sparse = new Array(1);
  const accessorRows = [];
  Object.defineProperty(accessorRows, '0', {
    get() { invoked = true; return a; },
  });
  for (const places of [
    [getter], [hook], [hidden], [Object.assign(Object.create(a), a)],
    [{ ...a, [Symbol('unknown')]: true }], sparse, accessorRows,
  ]) {
    await assert.rejects(savePlaces(places, file));
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readdir(root), ['places.json']);
  }
  assert.equal(invoked, false);
});

test('field and count boundaries remain valid, including empty notes', async (t) => {
  const { file } = await isolatedStorage(t);
  const a = {
    ...savedPlace(), id: 'i'.repeat(100), name: 'n'.repeat(200),
    area: 'a'.repeat(200), category: 'c'.repeat(40), note: 'x'.repeat(1000),
  };
  const places = Array.from({ length: MAX_PLACES }, (_, index) => ({
    ...a, id: index === 0 ? a.id : String(index), note: index === 1 ? '' : a.note,
  }));
  await savePlaces(places, file);
  assert.deepEqual(await loadPlaces(file), places);
});

test('JSON byte limit applies before parsing and before any save mutation', async (t) => {
  const { root, file } = await isolatedStorage(t);
  const json = JSON.stringify(document([]));
  const atLimit = json + ' '.repeat(MAX_PLACES_JSON_BYTES - Buffer.byteLength(json));
  await writeFile(file, atLimit, { mode: 0o600 });
  assert.deepEqual(await loadPlaces(file), []);
  const oversized = atLimit + ' ';
  await writeFile(file, oversized);
  await assert.rejects(loadPlaces(file), /size limit/);
  assert.equal(await readFile(file, 'utf8'), oversized);

  // Individually valid fields may exceed the total budget after JSON escaping.
  const a = {
    ...savedPlace(), name: '\u0000'.repeat(200), area: '\u0000'.repeat(200),
    category: '\u0000'.repeat(40), note: '\u0000'.repeat(1000),
  };
  const places = Array.from({ length: MAX_PLACES }, (_, index) => ({ ...a, id: String(index) }));
  assert.ok(Buffer.byteLength(JSON.stringify(document(places))) > MAX_PLACES_JSON_BYTES);
  await assert.rejects(savePlaces(places, file), /size limit/);
  assert.equal(await readFile(file, 'utf8'), oversized);
  assert.deepEqual(await readdir(root), ['places.json']);
  await assert.rejects(savePlaces(places, path.join(root, 'absent', 'places.json')), /size limit/);
  await assert.rejects(lstat(path.join(root, 'absent')), { code: 'ENOENT' });
});

test('invalid UTF-8 fails closed', async (t) => {
  const { file } = await isolatedStorage(t);
  const json = JSON.stringify(document([{ ...savedPlace(), note: 'MARKER' }]));
  const [prefix, suffix] = json.split('MARKER');
  const bad = Buffer.concat([Buffer.from(prefix), Buffer.from([0xff]), Buffer.from(suffix)]);
  await writeFile(file, bad, { mode: 0o600 });
  await assert.rejects(loadPlaces(file));
  assert.deepEqual(await readFile(file), bad);
});

test('symlink databases, including dangling links, reject load/save without touching targets', async (t) => {
  const { root, file } = await isolatedStorage(t);
  const target = path.join(root, 'target.json');
  await savePlaces([savedPlace()], target);
  const original = await readFile(target);
  try {
    await symlink(target, file, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'ENOSYS'].includes(error.code)) {
      t.skip('file symlinks unavailable: ' + error.code);
      return;
    }
    throw error;
  }
  for (const dangling of [false, true]) {
    if (dangling) await rm(target);
    await assert.rejects(loadPlaces(file), /regular file/);
    await assert.rejects(savePlaces([savedPlace()], file), /regular file/);
    assert.equal((await lstat(file)).isSymbolicLink(), true);
    if (dangling) {
      await assert.rejects(lstat(target), { code: 'ENOENT' });
      assert.deepEqual(await readdir(root), ['places.json']);
    } else {
      assert.deepEqual(await readFile(target), original);
      assert.deepEqual((await readdir(root)).sort(), ['places.json', 'target.json']);
    }
  }
});

test('non-regular database paths reject load and save', async (t) => {
  const { file } = await isolatedStorage(t);
  await mkdir(file);
  const sentinel = path.join(file, 'sentinel');
  await writeFile(sentinel, 'untouched', { mode: 0o600 });
  await assert.rejects(loadPlaces(file), /regular file/);
  await assert.rejects(savePlaces([savedPlace()], file), /regular file/);
  assert.deepEqual(await readdir(file), ['sentinel']);
  assert.equal(await readFile(sentinel, 'utf8'), 'untouched');
});

test('CLI search, list and add preserve commands using only an isolated home', async (t) => {
  const { root } = await isolatedStorage(t);
  const cli = fileURLToPath(new URL('../../scripts/personal-places.mjs', import.meta.url));
  // Do not inherit Node's test IPC context or any real user home configuration.
  const env = { HOME: root, USERPROFILE: root };
  for (const key of ['SystemRoot', 'LD_LIBRARY_PATH']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const stdoutPath = path.join(root, 'stdout');
  const stderrPath = path.join(root, 'stderr');
  const run = async (args) => {
    // Real isolated files also work in sandboxes that disallow child stdio pipes.
    const stdout = await open(stdoutPath, 'w', 0o600);
    const stderr = await open(stderrPath, 'w', 0o600);
    let result;
    try {
      result = spawnSync(process.execPath, [cli, ...args], {
        env, stdio: ['ignore', stdout.fd, stderr.fd], timeout: 10000,
      });
    } finally {
      await stdout.close();
      await stderr.close();
    }
    assert.ifError(result.error);
    assert.equal(result.status, 0, await readFile(stderrPath, 'utf8'));
    return readFile(stdoutPath, 'utf8');
  };
  assert.equal(new URL((await run(['search', '인천', '송도'])).trim())
    .searchParams.get('query'), '인천 송도');
  assert.deepEqual(JSON.parse(await run(['list'])), []);
  const added = JSON.parse(await run(['add', 'Cafe', 'Incheon', 'cafe']));
  const listed = JSON.parse(await run(['list']));
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, added.id);
  assert.equal(listed[0].name, 'Cafe');
  assert.equal(listed[0].category, 'cafe');
  assert.equal(listed[0].source, 'USER_TYPED_ONLY');
});

test('reject out-of-bounds manual data', () => {
  assert.throws(() => manualPlace({ name: '', area: 'Seoul' }));
  assert.throws(() => manualPlace({ name: 'Place', area: '' }));
  const excessive = 'x'.repeat(1001);
  assert.throws(() => manualPlace({
    name: 'Place',
    area: 'Seoul',
    note: excessive,
  }));
});
