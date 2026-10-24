const GROUPS = new Set([
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
]);

/** Read catalog text from the existing group endpoint using a supplied transport. */
export function createSatelliteSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  return {
    async readGroup(group, { signal } = {}) {
      if (!GROUPS.has(group)) throw new TypeError('Unknown satellite group');
      signal?.throwIfAborted();
      const response = await fetchImpl(`/api/celestrak/${group}`, { signal });
      const text = response.ok ? await response.text() : '';
      signal?.throwIfAborted();
      return {
        ok: response.ok,
        status: response.status,
        text,
        cache: response.headers?.get('x-tle-cache') ?? null,
        fetchedAt: response.headers?.get('x-tle-fetched-at') ?? null,
        sourceUrl: response.headers?.get('x-tle-source') ?? null,
        sha256: response.headers?.get('x-tle-sha256') ?? null,
        errorCode: response.headers?.get('x-celestrak-error') ?? null,
        upstreamStatus:
          response.headers?.get('x-celestrak-http-status') ?? null,
        requiresOperator:
          response.headers?.get('x-celestrak-operator-required') === 'true',
      };
    },
  };
}
