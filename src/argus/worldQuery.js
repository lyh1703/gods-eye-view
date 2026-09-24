import { createProviderRegistry } from './providerRegistry.js';

export function createWorldQueryEngine({
  providerRegistry = createProviderRegistry(),
  adapters = [],
  now = () => new Date(),
} = {}) {
  const adapterMap = new Map();

  function registerAdapter(adapter, options) {
    if (!adapter?.metadata?.provider_id || typeof adapter.query !== 'function') {
      throw new TypeError('adapter requires metadata.provider_id and query()');
    }

    providerRegistry.register(adapter.metadata, options);
    adapterMap.set(adapter.metadata.provider_id, adapter);
    return adapter.metadata;
  }

  for (const adapter of adapters) registerAdapter(adapter);

  async function query({
    provider_ids,
    scope = null,
    time = null,
    filters = {},
    limit = 100,
    ingestion_run_id,
  } = {}) {
    const selectedIds =
      Array.isArray(provider_ids) && provider_ids.length > 0
        ? provider_ids
        : [...adapterMap.keys()];

    const providerResults = await Promise.all(
      selectedIds.map(async (providerId) => {
        const adapter = adapterMap.get(providerId);
        if (!adapter) {
          return {
            provider_id: providerId,
            ok: false,
            error: 'provider-not-registered',
            observations: [],
          };
        }

        try {
          const observations = await adapter.query({
            scope,
            time,
            filters,
            limit,
            ingestionRunId: ingestion_run_id,
          });
          return {
            provider_id: providerId,
            ok: true,
            error: null,
            observations: Array.isArray(observations) ? observations : [],
          };
        } catch (error) {
          return {
            provider_id: providerId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            observations: [],
          };
        }
      }),
    );

    return {
      as_of: now().toISOString(),
      scope,
      time,
      filters,
      providers: providerResults.map(
        ({ provider_id, ok, error, observations }) => ({
          provider_id,
          ok,
          error,
          count: observations.length,
        }),
      ),
      observations: providerResults
        .flatMap((result) => result.observations)
        .slice(0, Math.max(0, Number(limit) || 100)),
    };
  }

  return Object.freeze({
    query,
    registerAdapter,
    providerRegistry,
    getAdapter: (providerId) => adapterMap.get(providerId) ?? null,
  });
}
