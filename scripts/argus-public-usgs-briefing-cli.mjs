import { runPublicUsgsNexusQuery } from './argus-public-usgs-nexus-query.mjs';
import { renderPublicUsgsBriefing } from '../src/argus/publicUsgsBriefing.js';

// A human-readable entrypoint for the existing official public, read-only
// ARGUS -> NEXUS verified-query path. Never displays synthetic observations.
try {
  if (process.argv.length !== 2) throw new TypeError('NO_ARGUMENTS_SUPPORTED');
  const verified = await runPublicUsgsNexusQuery({ limit: 10 });
  process.stdout.write(renderPublicUsgsBriefing(verified) + '\n');
} catch (error) {
  const allowed = new Set([
    'USGS_UNAVAILABLE',
    'UNVERIFIED_OR_DEGRADED_USGS_RESULT',
    'INVALID_USGS_RESULT_COUNT',
    'UNTRUSTED_USGS_BRIEFING_ITEM',
    'OUT_OF_WINDOW_USGS_OBSERVATION',
    'INVALID_OBSERVATION_TIME',
    'NO_ARGUMENTS_SUPPORTED',
  ]);
  const code = allowed.has(error?.message) ? error.message : 'UNKNOWN';
  process.stderr.write('ARGUS_USGS_BRIEFING_UNAVAILABLE: ' + code + '\n');
  process.exitCode = 2;
}
