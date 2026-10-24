import { runPublicUsgsNexusQuery } from './argus-public-usgs-nexus-query.mjs';
import { renderPublicUsgsBriefing } from '../src/argus/publicUsgsBriefing.js';

// A human-readable entrypoint for the existing official public, read-only
// ARGUS -> NEXUS verified-query path. Never displays synthetic observations.
try {
  if (process.argv.length !== 2) throw new TypeError('NO_ARGUMENTS_SUPPORTED');
  const verified = await runPublicUsgsNexusQuery({ limit: 10 });
  process.stdout.write(renderPublicUsgsBriefing(verified) + '\n');
} catch {
  process.stderr.write('ARGUS_USGS_BRIEFING_UNAVAILABLE (no verified public result)\n');
  process.exitCode = 2;
}
