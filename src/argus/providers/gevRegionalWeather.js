import { createObservationEnvelope } from '../observationEnvelope.js';
import { normalizeRegionalWeather } from '../../data/regionalModel.js';

export const GEV_REGIONAL_WEATHER_PROVIDER = Object.freeze({
  provider_id: 'gev-regional-weather',
  category: 'weather',
  geography: 'point-query global coverage via inherited regional briefing',
  auth_mode: 'keyless-inherited-gev-proxy',
  cost_class: 'free-upstream-via-inherited-proxy',
  update_frequency: 'current-conditions',
  latency: 'provider-and-cache-dependent',
  coverage: 'point weather conditions around requested coordinate',
  license_class: 'inherited-gev-source-license-review',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy: 'retain normalized observations with source provenance',
  reliability: 'inherited-gev-cache-and-stale-fallback',
  adapter_status: 'argus-mapped-validated',
  source_url: 'https://api.open-meteo.com/v1/forecast',
});

function queryPoint(scope, filters) {
  const latitude = Number(filters?.latitude);
  const longitude = Number(filters?.longitude);
  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return { latitude, longitude };
  }
  const bbox = scope?.bbox;
  if (Array.isArray(bbox) && bbox.length === 4) {
    const [west, south, east, north] = bbox.map(Number);
    if ([west, south, east, north].every(Number.isFinite)) {
      return {
        latitude: (south + north) / 2,
        longitude: (west + east) / 2,
      };
    }
  }
  return null;
}

function coordinateId(point) {
  return `${point.latitude.toFixed(4)},${point.longitude.toFixed(4)}`;
}

export function createGevRegionalWeatherAdapter({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('GEV regional weather adapter requires fetch');
  }

  return Object.freeze({
    metadata: GEV_REGIONAL_WEATHER_PROVIDER,

    async query({ scope, filters = {}, limit = 100, ingestionRunId } = {}) {
      const point = queryPoint(scope, filters);
      if (!point) {
        throw new TypeError(
          'regional weather query requires filters latitude/longitude or scope.bbox',
        );
      }

      const params = new URLSearchParams({
        latitude: point.latitude.toFixed(5),
        longitude: point.longitude.toFixed(5),
      });
      const response = await fetchImpl(`/api/regional-brief?${params}`);
      if (!response?.ok) {
        const error = new Error(
          `GEV regional weather request failed with HTTP ${response?.status ?? 'unknown'}`,
        );
        error.retryable =
          response?.status === 408 ||
          response?.status === 429 ||
          Number(response?.status) >= 500;
        throw error;
      }

      const payload = await response.json();
      const normalized =
        payload?.weather?.observedAt != null
          ? payload.weather
          : normalizeRegionalWeather(payload?.weather ?? payload);
      if (!normalized?.observedAt) {
        throw new TypeError('GEV regional weather payload has no usable observation');
      }

      if (Number(limit) <= 0) return [];
      const receivedAt = now();
      const degraded =
        payload?.weatherStatus === 'unavailable' ||
        payload?.status === 'stale' ||
        payload?.status === 'partial';

      return [
        createObservationEnvelope({
          provider_id: GEV_REGIONAL_WEATHER_PROVIDER.provider_id,
          entity_type: 'weather-location',
          entity_id: coordinateId(point),
          observation_type: 'weather-current-conditions',
          timestamp_observed: normalized.observedAt,
          timestamp_received: receivedAt,
          geometry: {
            type: 'Point',
            coordinates: [point.longitude, point.latitude],
          },
          properties: {
            temperature_c: normalized.temperatureC,
            apparent_temperature_c: normalized.apparentTemperatureC,
            precipitation_mm: normalized.precipitationMm,
            cloud_cover_pct: normalized.cloudCoverPct,
            wind_kph: normalized.windKph,
            wind_direction_deg: normalized.windDirectionDeg,
            visibility_m: normalized.visibilityM,
            weather_code: normalized.weatherCode,
            proxy_status: payload?.status ?? 'ready',
            weather_status: payload?.weatherStatus ?? 'ready',
            place: payload?.place ?? null,
          },
          coverage: GEV_REGIONAL_WEATHER_PROVIDER.coverage,
          confidence: degraded ? 0.75 : 0.95,
          source_url: GEV_REGIONAL_WEATHER_PROVIDER.source_url,
          license_class: GEV_REGIONAL_WEATHER_PROVIDER.license_class,
          commercial_allowed: GEV_REGIONAL_WEATHER_PROVIDER.commercial_allowed,
          attribution_required:
            GEV_REGIONAL_WEATHER_PROVIDER.attribution_required,
          retention_policy: GEV_REGIONAL_WEATHER_PROVIDER.retention_policy,
          rate_limit_class: 'inherited-gev-regional-brief',
          ingestion_run_id:
            ingestionRunId ?? `gev-weather-${receivedAt.toISOString()}`,
          raw_reference: coordinateId(point),
        }),
      ];
    },
  });
}
