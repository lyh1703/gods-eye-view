import { USGS_EARTHQUAKES_PROVIDER } from '../../argus/providers/usgsEarthquakes.js';

const PROVIDER_ID = USGS_EARTHQUAKES_PROVIDER.provider_id;
const MAX_LIMIT = 150;

function observedTime(value) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function storedEarthquake(observation, analysisMs, staleAfterSeconds, degraded) {
  if (
    observation?.provider_id !== PROVIDER_ID ||
    observation.entity_type !== 'earthquake' ||
    observation.observation_type !== 'earthquake-event' ||
    !observation.observation_id ||
    !observation.ingestion_run_id ||
    !/^[0-9a-f]{64}$/i.test(String(observation.content_hash ?? ''))
  ) {
    throw new TypeError('World Memory earthquake lacks verified storage lineage');
  }

  let origin;
  try {
    origin = new URL(observation.source_url);
  } catch {
    throw new TypeError('World Memory earthquake has invalid source URL');
  }
  if (origin.protocol !== 'https:' || origin.hostname !== 'earthquake.usgs.gov') {
    throw new TypeError('World Memory earthquake lacks official USGS source');
  }

  const observedMs = observedTime(observation.timestamp_observed);
  const receivedMs = observedTime(observation.timestamp_received);
  const ingestedMs = observedTime(observation.ingested_at);
  if (
    observedMs == null ||
    receivedMs == null ||
    ingestedMs == null ||
    observedMs > receivedMs + 120_000 ||
    receivedMs > ingestedMs + 120_000 ||
    ingestedMs > analysisMs + 120_000
  ) {
    throw new TypeError('World Memory earthquake observation/receipt/ingest chronology invalid');
  }

  const geometry = observation.geometry;
  const coords = geometry?.coordinates;
  if (
    geometry?.type !== 'Point' ||
    !Array.isArray(coords) ||
    coords.length < 2 ||
    !Number.isFinite(coords[0]) ||
    Math.abs(coords[0]) > 180 ||
    !Number.isFinite(coords[1]) ||
    Math.abs(coords[1]) > 90 ||
    (coords[2] != null && !Number.isFinite(coords[2]))
  ) {
    throw new TypeError('World Memory earthquake coordinates must be WGS84 Point');
  }
  const mag = observation.properties?.magnitude;
  if (typeof mag !== 'number' || !Number.isFinite(mag) || mag > 10) {
    throw new TypeError('World Memory earthquake magnitude invalid');
  }

  const ageSeconds = Math.max(0, (analysisMs - observedMs) / 1000);
  const stale = ageSeconds > staleAfterSeconds;
  return {
    stableId: String(observation.entity_id),
    usgsId: String(observation.entity_id),
    lon: coords[0],
    lat: coords[1],
    depthKm: coords[2] ?? observation.properties?.depth_km ?? null,
    mag,
    place: observation.properties?.place ?? null,
    time: observedMs,
    evidence: {
      kind: 'OBSERVATION',
      source_mode: 'STORED_WORLD_MEMORY',
      provider_id: PROVIDER_ID,
      observation_id: observation.observation_id,
      ingestion_run_id: observation.ingestion_run_id,
      source_url: observation.source_url,
      timestamp_observed: observation.timestamp_observed,
      timestamp_received: observation.timestamp_received,
      ingested_at: observation.ingested_at,
      analyzed_at: new Date(analysisMs).toISOString(),
      stale,
      degraded,
      age_seconds: ageSeconds,
      evidence_note: 'Official USGS source record, not independent event verification',
    },
  };
}

/**
 * Opt-in read-only bridge: persisted ARGUS World Memory -> existing Cesium
 * earthquake layer. No browser database driver, synthetic facts, or writes.
 * Callers provide a permissioned world query engine. The default standalone
 * UI continues to use its existing direct USGS public feed.
 */
export function createWorldMemoryEarthquakeSource({
  world,
  now = () => new Date(),
  limit = 100,
  staleAfterSeconds = 900,
} = {}) {
  if (typeof world?.query !== 'function') {
    throw new TypeError('ARGUS World Memory query engine required');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new RangeError('Earthquake readback limit must be 1..150');
  }
  if (
    !Number.isFinite(staleAfterSeconds) ||
    staleAfterSeconds < 0 ||
    staleAfterSeconds > 604800
  ) {
    throw new RangeError('Invalid earthquake staleness threshold');
  }

  let state = Object.freeze({
    status: 'unavailable',
    kind: 'OBSERVATION',
    source_mode: 'STORED_WORLD_MEMORY',
    count: 0,
    stale_count: 0,
    analyzed_at: null,
    provider_state: 'UNKNOWN',
  });

  return Object.freeze({
    getEvidenceStatus: () => ({ ...state }),
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await world.query({
        provider_ids: [PROVIDER_ID],
        type: 'earthquake',
        observation_type: 'earthquake-event',
        time_basis: 'observed',
        limit,
      });
      signal?.throwIfAborted();
      if (
        response?.mode !== 'snapshot' ||
        !Array.isArray(response.states) ||
        response.candidate_truncated === true ||
        response.states.length > limit
      ) {
        throw new TypeError('Incomplete World Memory earthquake snapshot');
      }

      let providerState = 'UNKNOWN';
      try {
        const run = await world.repository?.getLatestIngestionRunForProvider?.(
          PROVIDER_ID,
        );
        providerState = String(run?.status ?? 'UNKNOWN');
      } catch {
        providerState = 'UNKNOWN';
      }
      signal?.throwIfAborted();
      const degraded = providerState !== 'SUCCEEDED';
      const analysisMs = now().getTime();
      if (!Number.isFinite(analysisMs)) {
        throw new TypeError('Invalid World Memory presentation clock');
      }
      const rows = response.states.map((row) =>
        storedEarthquake(row, analysisMs, staleAfterSeconds, degraded),
      );
      const seen = new Set();
      for (const row of rows) {
        if (seen.has(row.stableId)) {
          throw new TypeError('Duplicate World Memory earthquake identity');
        }
        seen.add(row.stableId);
      }
      signal?.throwIfAborted();
      // Preserve the existing Earthquakes M2.5+ map policy. A lower-magnitude
      // recorded event is not fabricated into a visible marker.
      const visibleRows = rows.filter((row) => row.mag >= 2.5);
      const staleCount = visibleRows.filter((row) => row.evidence.stale).length;
      state = Object.freeze({
        status: degraded ? 'degraded' : staleCount > 0 ? 'stale' : 'nominal',
        kind: 'OBSERVATION',
        source_mode: 'STORED_WORLD_MEMORY',
        count: visibleRows.length,
        stale_count: staleCount,
        analyzed_at: new Date(analysisMs).toISOString(),
        provider_state: providerState,
      });
      return visibleRows;
    },
  });
}
