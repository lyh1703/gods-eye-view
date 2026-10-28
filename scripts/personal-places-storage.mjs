/* Local disk persistence for manual places. Never reads remote provider data. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MAX_PLACES, PLACE_SCHEMA } from '../src/argus/personalPlaces.js';

export function defaultPlacesPath() {
  return path.join(homedir(), '.maker-team', 'personal-places.json');
}

export async function loadPlaces(databasePath = defaultPlacesPath()) {
  try {
    const data = JSON.parse(await readFile(databasePath, 'utf8'));
    if (data.schema !== PLACE_SCHEMA || !Array.isArray(data.places)) {
      throw new Error('unexpected personal places schema');
    }
    const invalid = data.places.some((p) => p.source !== 'USER_TYPED_ONLY');
    if (data.places.length > MAX_PLACES || invalid) {
      throw new Error('refusing unknown or unverified imported place data');
    }
    return data.places;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function savePlaces(places, databasePath = defaultPlacesPath()) {
  if (!Array.isArray(places)) {
    throw new Error('only bounded user-authored places may be stored');
  }
  const invalid = places.some((p) => p.source !== 'USER_TYPED_ONLY');
  if (places.length > MAX_PLACES || invalid) {
    throw new Error('only bounded user-authored places may be stored');
  }
  await mkdir(path.dirname(databasePath), { recursive: true });
  const temp = databasePath + '.' + process.pid + '-' + randomUUID() + '.tmp';
  const json = JSON.stringify({ schema: PLACE_SCHEMA, places }, null, 2);
  const opts = { encoding: 'utf8', mode: 0o600, flag: 'wx' };
  await writeFile(temp, json, opts);
  await rename(temp, databasePath);
}
