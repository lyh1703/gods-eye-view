import {
  createUsgsEarthquakesAdapter,
  createWorldQueryEngine,
  validateObservationEnvelope,
} from '../src/argus/index.js';

export async function runArgusSmoke({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const adapter = createUsgsEarthquakesAdapter({ fetchImpl, now });
  const engine = createWorldQueryEngine({ adapters: [adapter], now });
  const startedAt = Date.now();
  const ingestionRunId = `argus-smoke-${now().toISOString()}`;

  const result = await engine.query({
    provider_ids: [adapter.metadata.provider_id],
    limit: 25,
    ingestion_run_id: ingestionRunId,
  });

  const provider = result.providers[0];
  if (!provider?.ok) {
    throw new Error(
      `ARGUS smoke provider failed: ${provider?.error ?? 'unknown error'}`,
    );
  }

  const invalid = result.observations.filter(
    (observation) => !validateObservationEnvelope(observation).ok,
  );
  if (invalid.length > 0) {
    throw new Error(
      `ARGUS smoke received ${invalid.length} invalid observation(s)`,
    );
  }

  // A valid envelope alone does not prove that the response belongs to this
  // provider or this ingestion run. Never accept cross-run observations.
  const mismatched = result.observations.filter(
    (observation) =>
      observation.provider_id !== provider.provider_id ||
      observation.ingestion_run_id !== ingestionRunId,
  );
  if (mismatched.length > 0) {
    throw new Error(
      `ARGUS smoke received ${mismatched.length} observation(s) with mismatched provenance`,
    );
  }

  return {
    provider_id: provider.provider_id,
    provider_ok: provider.ok,
    observation_count: result.observations.length,
    as_of: result.as_of,
    ingestion_run_id: ingestionRunId,
    latency_ms: Date.now() - startedAt,
  };
}

if (import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const summary = await runArgusSmoke();
  console.log(JSON.stringify(summary, null, 2));
}
