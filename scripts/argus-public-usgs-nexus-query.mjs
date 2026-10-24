import { createExternalProviderIngestor, createInMemoryWorldMemoryRepository, createNexusVerifiedQueryAdapter, createUsgsEarthquakesAdapter, createWorldMemoryQueryEngine, USGS_EARTHQUAKES_PROVIDER } from '../src/argus/index.js';

export async function runPublicUsgsNexusQuery({ fetchImpl = fetch, now = () => new Date(), limit = 10 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 25) throw new RangeError('limit 1..25 required');
  const repository = createInMemoryWorldMemoryRepository({ now });
  const adapter = createUsgsEarthquakesAdapter({ fetchImpl, now });
  const ingested = await createExternalProviderIngestor({
    repository, now, maxAttempts: 1, staleAfterSeconds: 3600,
  }).ingest(adapter, { limit: 100 });
  if (ingested.status === 'DEGRADED') throw new Error('USGS_UNAVAILABLE');
  const asOf = now();
  const world = createWorldMemoryQueryEngine({ repository, now });
  const result = await createNexusVerifiedQueryAdapter({ world, now }).execute({
    operation: 'query',
    provider_ids: [USGS_EARTHQUAKES_PROVIDER.provider_id],
    type: 'earthquake',
    time_basis: 'observed',
    time: {
      start: new Date(asOf.getTime() - 3600000).toISOString(),
      end: asOf.toISOString(),
    },
    limit,
  });
  for (const item of result.data.observations ?? []) {
    if (item.provider_id !== USGS_EARTHQUAKES_PROVIDER.provider_id ||
        new URL(item.source_url).origin !== 'https://earthquake.usgs.gov' ||
        !result.evidence.observation_ids.includes(item.observation_id)) {
      throw new Error('UNTRUSTED_PUBLIC_OBSERVATION');
    }
  }
  return result;
}
