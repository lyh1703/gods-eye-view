import { createCctvSource } from '../../layers/cctv/source.js';
import {
  recoveryError,
  finiteCoordinate,
  inArea,
  inTime,
  boundedLimit,
  deadline,
  boundedJson,
  pointObservation,
} from './gevRecoveryCommon.js';

export const GEV_CCTV_CATALOG_PROVIDER = Object.freeze({
  provider_id: 'gev-public-cctv-catalog',
  category: 'vision-metadata',
  geography: 'licensed public camera catalog coverage',
  auth_mode: 'inherited-open-data-proxy',
  cost_class: 'free-public-catalog',
  update_frequency: 'catalog-refresh',
  latency: 'catalog-cache-dependent',
  coverage: 'registered public CCTV metadata only, not frames or footage',
  license_class: 'per-source-inherited-catalog-license',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy: 'bounded catalog and stream health metadata; never footage',
  rate_limit_class: 'inherited-gev-cctv-catalog-budget',
  reliability: 'catalog availability does not establish frame connectivity',
  adapter_status: 'argus-query-callable',
  source_url: 'https://github.com/lyh1703/gods-eye-view',
});

export function createGevCctvCatalogAdapter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 12_000,
  maxRows = 5000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  const source = createCctvSource({
    fetchImpl: async (url, init) => {
      const response = await fetchImpl(url, init);
      const payload = await boundedJson(response, 3_000_000);
      return {
        ok: true,
        async json() {
          return payload;
        },
      };
    },
  });
  return Object.freeze({
    metadata: GEV_CCTV_CATALOG_PROVIDER,
    async query({
      scope,
      time,
      filters = {},
      limit = 100,
      ingestionRunId,
    } = {}) {
      if (filters.entity_type && filters.entity_type !== 'cctv-camera')
        return [];
      return deadline(async (signal) => {
        const catalog = await source.getCatalog({ signal });
        if (catalog.sources.length > maxRows)
          throw recoveryError(
            'OVERSIZED_RESPONSE',
            'camera catalog exceeds row limit',
          );
        let healthById = new Map();
        let healthUnavailable = false;
        try {
          const health = await source.getHealth({ signal });
          healthById = new Map(
            health.cameras.map((entry) => [String(entry.id), entry]),
          );
        } catch {
          healthUnavailable = true;
        }
        const receivedAt = now().toISOString();
        if (!inTime(receivedAt, time)) return [];
        const seen = new Set();
        const observations = [];
        for (const record of catalog.sources) {
          const id = String(record?.id ?? '').slice(0, 160);
          const lat = finiteCoordinate(record?.lat, 90);
          const lon = finiteCoordinate(record?.lon, 180);
          if (!id || lat == null || lon == null || seen.has(id)) continue;
          seen.add(id);
          if (filters.entity_id && filters.entity_id !== id) continue;
          if (!inArea(lon, lat, scope)) continue;
          const health = healthById.get(id);
          const synthetic = ['fallback', 'synthetic'].includes(
            String(record.sourceKind || '').toLowerCase(),
          );
          observations.push(
            pointObservation({
              metadata: GEV_CCTV_CATALOG_PROVIDER,
              id,
              type: 'cctv-camera',
              observationType: 'cctv-catalog-status',
              timestamp: receivedAt,
              receivedAt,
              lon,
              lat,
              ingestionRunId,
              properties: {
                name: String(record.name || '').slice(0, 160),
                city: String(record.city || '').slice(0, 100),
                source_provider: String(record.provider || '').slice(0, 140),
                source_kind: record.sourceKind ?? null,
                source_license: record.license ?? null,
                credit: record.credit ?? null,
                feed_type: record.feedType ?? null,
                availability: healthUnavailable
                  ? 'HEALTH_UNAVAILABLE'
                  : (health?.status ?? 'NOT_PROBED'),
                last_health_check: Number.isFinite(health?.updatedAt)
                  ? new Date(health.updatedAt).toISOString()
                  : null,
                stream_verified: false,
                synthetic_or_fallback: synthetic,
                observation_basis: 'catalog-sample-not-live-frame',
              },
              confidence: synthetic ? 0.3 : 0.7,
              rawReference: `catalog:${id}`,
            }),
          );
          if (observations.length >= boundedLimit(limit)) break;
        }
        return observations;
      }, timeoutMs);
    },
  });
}
