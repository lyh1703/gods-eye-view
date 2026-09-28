import { createObservationEnvelope } from '../observationEnvelope.js';

export const USGS_EARTHQUAKES_PROVIDER = Object.freeze({
  provider_id: 'usgs-earthquakes-all-hour',
  category: 'natural-hazards',
  geography: 'global',
  auth_mode: 'keyless',
  cost_class: 'free',
  update_frequency: 'near-real-time',
  latency: 'provider-dependent',
  coverage: 'global earthquake summary feed',
  license_class: 'us-government-public-domain',
  commercial_allowed: true,
  attribution_required: true,
  retention_policy: 'review before persistent redistribution',
  reliability: 'authoritative-government-source',
  adapter_status: 'phase-0-reference',
  source_url:
    'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
});

function inBbox(coordinates, bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return true;
  const [west, south, east, north] = bbox.map(Number);
  const [longitude, latitude] = coordinates;
  if (![west, south, east, north, longitude, latitude].every(Number.isFinite)) {
    return false;
  }
  return (
    longitude >= west &&
    longitude <= east &&
    latitude >= south &&
    latitude <= north
  );
}

export function createUsgsEarthquakesAdapter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  timeoutMs = 10_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('USGS adapter requires fetch');
  }

  return Object.freeze({
    metadata: USGS_EARTHQUAKES_PROVIDER,

    async query({ scope, filters = {}, limit = 100, ingestionRunId } = {}) {
      const timeout = Math.max(0, Number(timeoutMs) || 0);
      const controller = new AbortController();
      const timeoutId =
        timeout > 0 ? setTimeout(() => controller.abort(), timeout) : null;

      let payload;
      try {
        const response = await fetchImpl(USGS_EARTHQUAKES_PROVIDER.source_url, {
          signal: controller.signal,
        });
        if (!response.ok) {
          const error = new Error(
            `USGS request failed with HTTP ${response.status}`,
          );
          error.status = response.status;
          error.retryable =
            response.status === 408 ||
            response.status === 429 ||
            response.status >= 500;
          throw error;
        }
        payload = await response.json();
      } catch (error) {
        if (controller.signal.aborted) {
          const timeoutError = new Error(
            `USGS request timed out after ${timeout}ms`,
            { cause: error },
          );
          timeoutError.name = 'TimeoutError';
          timeoutError.retryable = true;
          throw timeoutError;
        }
        if (typeof error?.retryable === 'boolean') {
          throw error;
        }
        const networkError = new Error(
          `USGS request failed: ${error?.message ?? String(error)}`,
          { cause: error },
        );
        networkError.name = 'ProviderNetworkError';
        networkError.retryable = true;
        throw networkError;
      } finally {
        if (timeoutId != null) {
          clearTimeout(timeoutId);
        }
      }

      if (
        payload?.type !== 'FeatureCollection' ||
        !Array.isArray(payload.features)
      ) {
        throw new TypeError(
          'USGS payload must be a GeoJSON FeatureCollection with features',
        );
      }
      const features = payload.features;
      const receivedAt = now();
      const minMagnitude = Number(filters.min_magnitude ?? -Infinity);
      const bbox = scope?.bbox;

      return features
        .filter((feature) => {
          const coordinates = feature?.geometry?.coordinates;
          if (!Array.isArray(coordinates) || coordinates.length < 2) {
            return false;
          }
          const magnitude = Number(feature?.properties?.mag);
          if (Number.isFinite(minMagnitude) && magnitude < minMagnitude) {
            return false;
          }
          return inBbox(coordinates, bbox);
        })
        .slice(0, Math.max(0, Math.min(Number(limit) || 100, 1000)))
        .map((feature) => {
          const properties = feature.properties ?? {};
          const observedAt = new Date(properties.time);
          const reviewed =
            String(properties.status).toLowerCase() === 'reviewed';

          return createObservationEnvelope({
            provider_id: USGS_EARTHQUAKES_PROVIDER.provider_id,
            entity_type: 'earthquake',
            entity_id: String(feature.id),
            observation_type: 'earthquake-event',
            timestamp_observed: observedAt,
            timestamp_received: receivedAt,
            geometry: feature.geometry ?? null,
            properties: {
              magnitude: properties.mag ?? null,
              place: properties.place ?? null,
              depth_km: feature.geometry?.coordinates?.[2] ?? null,
              status: properties.status ?? null,
              tsunami: properties.tsunami ?? null,
              significance: properties.sig ?? null,
            },
            coverage: USGS_EARTHQUAKES_PROVIDER.coverage,
            confidence: reviewed ? 0.99 : 0.9,
            source_url: properties.url ?? USGS_EARTHQUAKES_PROVIDER.source_url,
            license_class: USGS_EARTHQUAKES_PROVIDER.license_class,
            commercial_allowed: USGS_EARTHQUAKES_PROVIDER.commercial_allowed,
            attribution_required:
              USGS_EARTHQUAKES_PROVIDER.attribution_required,
            retention_policy: USGS_EARTHQUAKES_PROVIDER.retention_policy,
            rate_limit_class: 'public-feed',
            ingestion_run_id:
              ingestionRunId ??
              `usgs-${receivedAt.toISOString().replaceAll(':', '-')}`,
            raw_reference: feature.id,
          });
        });
    },
  });
}
