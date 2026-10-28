/* Private user-authored places and official Maps URLs, without scraping. */
export const PLACE_SCHEMA = 'maker-team-personal-places-v1';
export const MAX_PLACES = 250;
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
