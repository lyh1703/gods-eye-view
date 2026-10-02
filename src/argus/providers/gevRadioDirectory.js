import { createRadioSource } from '../../layers/radio/source.js';
import { publicRadioHttpsUrl } from '../../sources/radioBrowser.js';
import {
  recoveryError, finiteCoordinate, inArea, inTime, boundedLimit,
  deadline, boundedJson, pointObservation,
} from './gevRecoveryCommon.js';

export const GEV_RADIO_DIRECTORY_PROVIDER = Object.freeze({
  provider_id: 'gev-radio-browser-directory',
  category: 'radio-metadata',
  geography: 'public global broadcaster directory',
  auth_mode: 'inherited-radio-browser-proxy',
  cost_class: 'public-directory',
  update_frequency: 'catalog-cache-refresh',
  latency: 'radio-directory-cache-dependent',
  coverage: 'directory-listed stations with valid public HTTPS streams',
  license_class: 'radio-browser-directory-attribution-and-station-rights',
  commercial_allowed: null,
  attribution_required: true,
  retention_policy: 'station catalog and accessibility metadata; no audio retention',
  rate_limit_class: 'inherited-radio-browser-proxy-budget',
  reliability: 'catalog acceptance is not a live stream test',
  adapter_status: 'argus-query-callable',
  source_url: 'https://www.radio-browser.info/',
});

export function createGevRadioDirectoryAdapter({
  fetchImpl = globalThis.fetch, now = () => new Date(),
  timeoutMs = 12_000, maxRows = 5000,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  const source = createRadioSource({
    fetchImpl: async (url, init) => {
      const payload = await boundedJson(await fetchImpl(url, init), 3_000_000);
      return { ok: true, async json() { return payload; } };
    },
  });

  return Object.freeze({
    metadata: GEV_RADIO_DIRECTORY_PROVIDER,
    async query({ scope, time, filters = {}, limit = 100, ingestionRunId } = {}) {
      if (filters.entity_type && filters.entity_type !== 'radio-station') return [];
      return deadline(async (signal) => {
        const payload = await source.getDirectory({ signal });
        if (!Array.isArray(payload?.stations))
          throw recoveryError('MALFORMED_PAYLOAD', 'radio directory lacks stations');
        if (payload.stations.length > maxRows)
          throw recoveryError('OVERSIZED_RESPONSE', 'radio directory exceeds row limit');
        const receivedAt = now().toISOString();
        const catalogObserved = payload.updatedAt && Number.isFinite(Date.parse(payload.updatedAt))
          ? new Date(payload.updatedAt).toISOString() : receivedAt;
        if (!inTime(catalogObserved, time)) return [];
        const seen = new Set();
        const observations = [];
        for (const station of payload.stations) {
          const id = String(station?.id || '').trim();
          const lat = finiteCoordinate(station?.lat, 90);
          const lon = finiteCoordinate(station?.lon, 180);
          const stream = publicRadioHttpsUrl(station?.streamUrl);
          if (!/^[0-9a-f-]{36}$/i.test(id) || lat == null ||
              lon == null || !stream || seen.has(id)) continue;
          seen.add(id);
          if (filters.entity_id && filters.entity_id !== id) continue;
          if (filters.country_code &&
              String(station.countryCode || '').toUpperCase() !==
                String(filters.country_code).toUpperCase()) continue;
          if (!inArea(lon, lat, scope)) continue;
          observations.push(pointObservation({
            metadata: GEV_RADIO_DIRECTORY_PROVIDER,
            id, type: 'radio-station', observationType: 'radio-catalog-entry',
            timestamp: catalogObserved, receivedAt, lon, lat, ingestionRunId,
            properties: {
              name: String(station.name || '').slice(0, 140),
              country: station.country || null,
              country_code: station.countryCode || null,
              state: station.state || null,
              languages: Array.isArray(station.languages) ? station.languages.slice(0, 8) : [],
              tags: Array.isArray(station.tags) ? station.tags.slice(0, 12) : [],
              codec: station.codec || null,
              stream_url: stream,
              stream_status: 'NOT_PROBED',
              directory_stale: Boolean(payload.stale),
              directory_degraded: Boolean(payload.degraded),
              metadata_trust: station.metadataTrust || 'untrusted-community',
              observation_basis: 'directory-entry-not-live-audio',
            },
            confidence: payload.stale || payload.degraded ? 0.5 : 0.75,
            rawReference: id,
          }));
          if (observations.length >= boundedLimit(limit)) break;
        }
        return observations;
      }, timeoutMs);
    },
  });
}
