// Read-only latest-observation selection for an ARGUS user-facing provider query.
// Provider failures remain visible; no failed source is silently treated as fresh.
const MAX_LIMIT = 500;
const MAX_STALE_SECONDS = 7 * 24 * 3600;

export function validateFreshLatestOptions({
  limit = 100,
  staleAfterSeconds = 900,
} = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError(`limit must be an integer from 1 to ${MAX_LIMIT}`);
  }
  if (
    !Number.isFinite(staleAfterSeconds) ||
    staleAfterSeconds < 0 ||
    staleAfterSeconds > MAX_STALE_SECONDS
  ) {
    throw new RangeError(
      'staleAfterSeconds must be a finite number from 0 to 604800',
    );
  }
  return { limit, staleAfterSeconds };
}

function zonedTime(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value))
    return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function identity(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return value.trim();
}

export function selectFreshLatest(
  providerResults,
  { asOf, limit = 100, staleAfterSeconds = 900 } = {},
) {
  const options = validateFreshLatestOptions({ limit, staleAfterSeconds });
  if (!Array.isArray(providerResults))
    throw new TypeError('providerResults must be an array');
  const clock = zonedTime(asOf);
  if (clock === null)
    throw new TypeError('asOf must be a timezone-aware timestamp');
  const latest = new Map();
  const excluded = { invalid: 0, provider_mismatch: 0, future: 0, stale: 0 };
  const providers = providerResults.map((result) => ({
    provider_id: result?.provider_id ?? null,
    ok: result?.ok === true,
    error: result?.error ?? null,
    count: Array.isArray(result?.observations) ? result.observations.length : 0,
  }));

  for (const result of providerResults) {
    if (result?.ok !== true || !Array.isArray(result.observations)) continue;
    for (const item of result.observations) {
      const provider = identity(item?.provider_id);
      const entityType = identity(item?.entity_type);
      const entityId = identity(item?.entity_id);
      const observedMs = zonedTime(item?.timestamp_observed);
      if (!provider || !entityType || !entityId || observedMs === null) {
        excluded.invalid += 1;
        continue;
      }
      if (provider !== result.provider_id) {
        excluded.provider_mismatch += 1;
        continue;
      }
      if (observedMs > clock) {
        excluded.future += 1;
        continue;
      }
      if ((clock - observedMs) / 1000 > options.staleAfterSeconds) {
        excluded.stale += 1;
        continue;
      }
      const key = JSON.stringify([provider, entityType, entityId]);
      const previous = latest.get(key);
      if (!previous || observedMs > previous.observedMs) {
        latest.set(key, { key, observedMs, observation: item });
      }
    }
  }
  const ordered = [...latest.values()].sort(
    (a, b) => b.observedMs - a.observedMs || a.key.localeCompare(b.key),
  );
  return {
    as_of: new Date(clock).toISOString(),
    stale_after_seconds: options.staleAfterSeconds,
    status: providers.some((p) => !p.ok)
      ? 'PARTIAL_PROVIDER_FAILURE'
      : ordered.length
        ? 'OK'
        : 'NO_FRESH_DATA',
    providers,
    excluded,
    total_fresh_entities: ordered.length,
    truncated: ordered.length > options.limit,
    observations: ordered
      .slice(0, options.limit)
      .map((entry) => entry.observation),
  };
}
