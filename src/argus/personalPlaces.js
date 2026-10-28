/* Private user-authored places and official Maps URLs, without scraping. */
export const PLACE_SCHEMA = 'maker-team-personal-places-v1';
export const MAX_PLACES = 250;
export const MAX_PLACES_JSON_BYTES = 2 * 1024 * 1024;
const PLACE_FIELDS = [
  'id',
  'name',
  'area',
  'category',
  'note',
  'source',
  'createdAt',
];
const TEXT_LIMITS = { id: 100, name: 200, area: 200, category: 40 };
export const VALID_MODES = new Set([
  'driving',
  'walking',
  'bicycling',
  'transit',
]);

export function field(text, label, limit) {
  if (typeof text !== 'string' || !text.trim() || text.length > limit) {
    throw new Error('invalid ' + label);
  }
  return text.trim();
}

function exactRecord(value, keys) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid personal places record');
  }
  const prototype = Object.getPrototypeOf(value);
  const ownKeys = Reflect.ownKeys(value);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => !keys.includes(key))
  ) {
    throw new Error('unexpected personal places fields');
  }
  // Read only data properties; save must not invoke accessors or toJSON hooks.
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw new Error('invalid personal places field');
    }
    copy[key] = descriptor.value;
  }
  return copy;
}

// Return a validated snapshot so persistence never serializes caller objects.
export function validatePlacesDocument(document) {
  const data = exactRecord(document, ['schema', 'places']);
  if (
    data.schema !== PLACE_SCHEMA ||
    !Array.isArray(data.places) ||
    data.places.length > MAX_PLACES
  ) {
    throw new Error('unexpected personal places schema or count');
  }
  const ids = new Set();
  const places = [];
  for (let index = 0; index < data.places.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(data.places, index);
    if (!descriptor || !('value' in descriptor)) {
      throw new Error('invalid personal places entry');
    }
    const place = exactRecord(descriptor.value, PLACE_FIELDS);
    for (const [key, limit] of Object.entries(TEXT_LIMITS)) {
      field(place[key], key, limit);
    }
    if (typeof place.note !== 'string' || place.note.length > 1000) {
      throw new Error('invalid note');
    }
    if (place.source !== 'USER_TYPED_ONLY') {
      throw new Error('refusing unknown or unverified imported place data');
    }
    if (
      typeof place.createdAt !== 'string' ||
      place.createdAt.length !== 24 ||
      !Number.isFinite(Date.parse(place.createdAt)) ||
      new Date(place.createdAt).toISOString() !== place.createdAt
    ) {
      throw new Error('invalid createdAt');
    }
    if (ids.has(place.id)) throw new Error('duplicate personal place id');
    ids.add(place.id);
    places.push(place);
  }
  return { schema: PLACE_SCHEMA, places };
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
  const terms = places.map((p) => field(p.name + ' ' + p.area, 'place', 400));
  const url = new URL('https://www.google.com/maps/dir/');
  url.searchParams.set('api', '1');
  url.searchParams.set('origin', terms[0]);
  url.searchParams.set('destination', terms.at(-1));
  const mid = terms.slice(1, -1).join('|');
  if (terms.length > 2) url.searchParams.set('waypoints', mid);
  url.searchParams.set('travelmode', mode);
  return url.href;
}

export function manualPlace({ name, area, category = 'place', note = '' }) {
  if (typeof note !== 'string') throw new Error('note must be text');
  if (note.length > 1000) throw new Error('note too long');
  return {
    id: globalThis.crypto.randomUUID(),
    name: field(name, 'name', 200),
    area: field(area, 'area', 200),
    category: field(category, 'category', 40),
    note: note.trim(),
    source: 'USER_TYPED_ONLY',
    createdAt: new Date().toISOString(),
  };
}

export function findSavedPlace(places, id) {
  const place = places.find((entry) => entry.id === id);
  if (!place) throw new Error('saved place not found');
  return place;
}
