import { createObservationEnvelope } from '../observationEnvelope.js';
import { createFlowTileSource } from '../../layers/traffic/flowSource.js';

export const GEV_TRAFFIC_PROVIDER = Object.freeze({
  provider_id: 'gev-tomtom-traffic-flow',
  category: 'traffic',
  geography: 'viewport tile coverage',
  auth_mode: 'server-side-key-via-inherited-gev-proxy',
  cost_class: 'provider-budgeted',
  update_frequency: 'near-real-time-tile-cache',
  latency: 'provider-and-cache-dependent',
  coverage: 'TomTom traffic flow segments for requested bounding box',
  license_class: 'inherited-gev-source-license-review',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy: 'retain normalized observations with source provenance',
  reliability: 'inherited-gev-serve-stale-on-failure',
  adapter_status: 'argus-mapped-validated',
  source_url:
    'https://api.tomtom.com/traffic/map/4/tile/flow/relative/',
});

function boundsFromScope(scope) {
  const bbox = scope?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4) return null;
  const [west, south, east, north] = bbox.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  return { west, south, east, north };
}

function stableSegmentId(segment) {
  const input = JSON.stringify([
    segment.roadType ?? '',
    Boolean(segment.closure),
    segment.coords,
  ]);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `flow-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

export function createGevTrafficAdapter({
  fetchImpl = globalThis.fetch,
  flowSource = null,
  now = () => new Date(),
  zoom = 12,
} = {}) {
  const source =
    flowSource ??
    createFlowTileSource({
      fetchImpl:
        typeof fetchImpl === 'function'
          ? (...args) => fetchImpl(...args)
          : undefined,
    });
  if (typeof source?.fetchFlowForBounds !== 'function') {
    throw new TypeError('GEV traffic adapter requires a flow tile source');
  }

  return Object.freeze({
    metadata: GEV_TRAFFIC_PROVIDER,

    async query({ scope, filters = {}, limit = 100, ingestionRunId } = {}) {
      const bounds = boundsFromScope(scope);
      if (!bounds) {
        throw new TypeError('traffic query requires scope.bbox');
      }
      if (
        filters.entity_type != null &&
        filters.entity_type !== 'road-segment'
      ) {
        return [];
      }

      const receivedAt = now();
      const segments = await source.fetchFlowForBounds(bounds, { zoom });
      const entityFilter =
        filters.entity_id == null ? null : String(filters.entity_id);
      const max = Math.max(0, Math.min(Number(limit) || 100, 5000));

      return segments
        .map((segment) => ({
          segment,
          entityId: stableSegmentId(segment),
        }))
        .filter(({ entityId }) => !entityFilter || entityId === entityFilter)
        .slice(0, max)
        .map(({ segment, entityId }) =>
          createObservationEnvelope({
            provider_id: GEV_TRAFFIC_PROVIDER.provider_id,
            entity_type: 'road-segment',
            entity_id: entityId,
            observation_type: 'traffic-flow',
            timestamp_observed: receivedAt,
            timestamp_received: receivedAt,
            geometry: {
              type: 'LineString',
              coordinates: segment.coords,
            },
            properties: {
              traffic_level: segment.trafficLevel,
              road_type: segment.roadType || null,
              closure: Boolean(segment.closure),
              freshness_basis: 'inherited-proxy-retrieval-time',
            },
            coverage: GEV_TRAFFIC_PROVIDER.coverage,
            confidence: segment.closure ? 0.9 : 0.85,
            source_url: GEV_TRAFFIC_PROVIDER.source_url,
            license_class: GEV_TRAFFIC_PROVIDER.license_class,
            commercial_allowed: GEV_TRAFFIC_PROVIDER.commercial_allowed,
            attribution_required: GEV_TRAFFIC_PROVIDER.attribution_required,
            retention_policy: GEV_TRAFFIC_PROVIDER.retention_policy,
            rate_limit_class: 'inherited-gev-tomtom-budget',
            ingestion_run_id:
              ingestionRunId ?? `gev-traffic-${receivedAt.toISOString()}`,
            raw_reference: entityId,
          }),
        );
    },
  });
}
