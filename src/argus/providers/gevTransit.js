import { createTransitSource } from '../../layers/transit/source.js';
import { TRANSIT_ENABLED_FEEDS } from '../../data/transitFeeds.js';
import {
  recoveryError, finiteCoordinate, inArea, inTime, boundedLimit,
  deadline, boundedJson, pointObservation,
} from './gevRecoveryCommon.js';

export const GEV_PUBLIC_TRANSIT_PROVIDER = Object.freeze({
  provider_id: 'gev-public-gtfs-transit',
  category: 'transit',
  geography: 'registered keyless GTFS-Realtime feed regions',
  auth_mode: 'inherited-allowlisted-gtfs-proxy',
  cost_class: 'public-read-only',
  update_frequency: 'feed-realtime-snapshot',
  latency: 'provider-and-cache-dependent',
  coverage: 'one explicitly selected enabled GTFS feed per call',
  license_class: 'feed-specific-registered-terms',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy: 'bounded normalized vehicle position/route evidence only',
  rate_limit_class: 'inherited-transit-proxy-admission',
  reliability: 'operator feed timestamps may lag cached receipt time',
  adapter_status: 'argus-query-callable',
  source_url: 'https://gtfs.org/documentation/realtime/reference/',
});

function normalizeEpochSeconds(value) {
  if (value === null || value === undefined || value === '') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 946684800 || seconds > 4102444800)
    return null;
  return new Date(seconds * 1000).toISOString();
}

export function createGevTransitAdapter({
  fetchImpl = globalThis.fetch, now = () => new Date(),
  timeoutMs = 15_000, maxRows = 5000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  const source = createTransitSource({ fetchImpl });
  const allowed = new Map(TRANSIT_ENABLED_FEEDS.map((feed) => [feed.id, feed]));
  return Object.freeze({
    metadata: GEV_PUBLIC_TRANSIT_PROVIDER,
    async query({ scope, time, filters = {}, limit = 100, ingestionRunId } = {}) {
      if (filters.entity_type && filters.entity_type !== 'transit-vehicle') return [];
      const feedId = String(filters.feed_id || '').trim();
      const feed = allowed.get(feedId);
      if (!feed) throw recoveryError('UNSUPPORTED_QUERY', 'registered enabled feed_id required');
      return deadline(async (signal) => {
        const response = await source.requestSnapshot(feedId, { signal });
        const payload = await boundedJson(response, 3_000_000);
        if (payload.feedId !== feedId || !Array.isArray(payload.vehicles))
          throw recoveryError('MALFORMED_PAYLOAD', 'invalid feed snapshot');
        if (payload.vehicles.length > maxRows)
          throw recoveryError('OVERSIZED_RESPONSE', 'transit snapshot exceeds row limit');
        const receivedAt = now().toISOString();
        const feedTimestamp = normalizeEpochSeconds(payload.feedTimestamp);
        const fetchedAt = Number(payload.fetchedAt);
        const receiptStamp = Number.isFinite(fetchedAt) && fetchedAt > 0
          ? new Date(fetchedAt).toISOString() : receivedAt;
        const staleProxy = String(response.headers?.get?.('X-GEV-Cache') || '').toUpperCase() === 'STALE-ERROR';
        const seen = new Set();
        const observations = [];
        for (const item of payload.vehicles) {
          const id = String(item?.id || '').slice(0, 160);
          const lat = finiteCoordinate(item?.lat, 90);
          const lon = finiteCoordinate(item?.lon, 180);
          if (!id || lat == null || lon == null || seen.has(id)) continue;
          seen.add(id);
          const entityId = `${feedId}:${id}`;
          if (filters.entity_id && filters.entity_id !== entityId) continue;
          if (!inArea(lon, lat, scope)) continue;
          const observedAt = normalizeEpochSeconds(item.timestamp) ||
            feedTimestamp || receiptStamp;
          if (!inTime(observedAt, time)) continue;
          observations.push(pointObservation({
            metadata: GEV_PUBLIC_TRANSIT_PROVIDER,
            id: entityId, type: 'transit-vehicle',
            observationType: 'transit-vehicle-position',
            timestamp: observedAt, receivedAt, lon, lat, ingestionRunId,
            properties: {
              feed_id: feedId,
              operator: feed.operator,
              route_id: item.routeId ?? null,
              trip_id: item.tripId ?? null,
              stop_id: item.stopId ?? null,
              speed_mps: Number.isFinite(item.speedMps) ? item.speedMps : null,
              course_deg: Number.isFinite(item.bearing) ? item.bearing : null,
              vehicle_status: item.status ?? null,
              timestamp_source: item.timestampSource || (feedTimestamp ? 'feed' : 'receipt'),
              feed_timestamp: feedTimestamp,
              fetched_at: receiptStamp,
              proxy_stale: staleProxy,
              source_attribution: feed.attribution,
              snapshot_truncated: Boolean(payload.truncated),
            },
            confidence: staleProxy ? 0.5 : 0.9,
            sourceUrl: feed.url,
            rawReference: `${feedId}:${id}:${observedAt}`,
          }));
          if (observations.length >= boundedLimit(limit)) break;
        }
        return observations;
      }, timeoutMs);
    },
  });
}
