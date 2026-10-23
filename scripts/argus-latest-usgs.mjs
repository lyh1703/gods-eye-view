import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createWorldQueryEngine } from '../src/argus/worldQuery.js';
import {
  createUsgsEarthquakesAdapter,
  USGS_EARTHQUAKES_PROVIDER,
} from '../src/argus/providers/usgsEarthquakes.js';

/** Public USGS -> actual ARGUS adapter -> bounded, freshness-checked read-only feed. */
export async function runArgusLatestUsgs({
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  limit = 25,
  staleAfterSeconds = 3600,
} = {}) {
  const adapter = createUsgsEarthquakesAdapter({ fetchImpl, now });
  const world = createWorldQueryEngine({ adapters: [adapter], now });
  const result = await world.latest({
    provider_ids: [USGS_EARTHQUAKES_PROVIDER.provider_id],
    limit,
    stale_after_seconds: staleAfterSeconds,
  });
  return {
    ...result,
    source_feed_url: USGS_EARTHQUAKES_PROVIDER.source_url,
    source_license: USGS_EARTHQUAKES_PROVIDER.license_class,
    read_only: true,
    operational_e2e_verified: false,
  };
}

const invoked = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : '';
if (import.meta.url === invoked) {
  try {
    const result = await runArgusLatestUsgs();
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (result.providers[0]?.ok !== true) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(JSON.stringify({
      status: 'ERROR', error: error.message,
    }) + '\n');
    process.exitCode = 2;
  }
}
