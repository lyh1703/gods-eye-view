/* Personal place shortlist and official Maps URL launch, with NO scraping or provider calls. */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export const PLACE_SCHEMA = 'maker-team-personal-places-v1';
export const MAX_PLACES = 250;
export const VALID_MODES = new Set(['driving', 'walking', 'bicycling', 'transit']);

export function defaultPlacesPath() {
  return path.join(homedir(), '.maker-team', 'personal-places.json');
}

export function field(text, label, limit) {
  if (typeof text !== 'string' || !text.trim() || text.length > limit) {
    throw new Error(label + ' must be a nonempty string within ' + limit + ' characters');
  }
  return text.trim();
}

export function mapsSearchUrl(query) {
  const url = new URL('https://www.google.com/maps/search/');
  url.searchParams.set('api', '1');
  url.searchParams.set('query', field(query, 'query', 400));
  return url.href;
}

export function directionsUrl(places, mode = 'driving') {
  if (!Array.isArray(places) || places.length < 2 || places.length > 9) {
    throw new Error('route requires 2–9 manually saved places');
  }
  if (!VALID_MODES.has(mode)) throw new Error('invalid travel mode');
  const terms = places.map((place) => field(place.name + ' ' + place.area, 'place', 400));
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', terms[0]);
  url.searchParams.set('destination', terms.at(-1));
  if (terms.length > 2) url.searchParams.set('waypoints', terms.slice(1, -1).join('|'));
  url.searchParams.set('travelmode', mode);
  return url.href;
}

export function manualPlace({ name, area, category = 'place', note = '' }) {
  if (typeof note !== 'string' || note.length > 1000) throw new Error('note too long');
  return {
    id: randomUUID(),
    name: field(name, 'name', 200),
    area: field(area, 'area', 200),
    category: field(category, 'category', 40),
    note: note.trim(),
    source: 'USER_TYPED_ONLY',
    createdAt: new Date().toISOString(),
  };
}

export async function loadPlaces(databasePath = defaultPlacesPath()) {
  try {
    const data = JSON.parse(await readFile(databasePath, 'utf8'));
    if (data.schema !== PLACE_SCHEMA || !Array.isArray(data.places)) {
      throw new Error('unexpected personal places schema');
    }
    if (data.places.length > MAX_PLACES || data.places.some((p) => p.source !== 'USER_TYPED_ONLY')) {
      throw new Error('refusing unknown or unverified imported place data');
    }
    return data.places;
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

export async function savePlaces(places, databasePath = defaultPlacesPath()) {
  if (!Array.isArray(places) || places.length > MAX_PLACES ||
      places.some((p) => p.source !== 'USER_TYPED_ONLY')) {
    throw new Error('only bounded user-authored places may be stored');
  }
  await mkdir(path.dirname(databasePath), { recursive: true });
  const temp = databasePath + '.' + process.pid + '-' + randomUUID() + '.tmp';
  await writeFile(temp, JSON.stringify({ schema: PLACE_SCHEMA, places }, null, 2), {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  await rename(temp, databasePath);
}

export function findSavedPlace(places, id) {
  const place = places.find((entry) => entry.id === id);
  if (!place) throw new Error('saved place not found');
  return place;
}
