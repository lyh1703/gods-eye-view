import { runPublicUsgsNexusQuery } from './argus-public-usgs-nexus-query.mjs';

// Compatible with NEXUS JsonSubprocessArgusClient: one JSON request on stdin,
// one verified-query JSON response on stdout. No database or API keys required.
let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk.toString('utf8');
    if (Buffer.byteLength(input, 'utf8') > 8192) {
      throw new Error('REQUEST_TOO_LARGE');
    }
  }
  const request = JSON.parse(input);
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      request.operation !== 'query' ||
      Object.keys(request).some(key => ![
        'operation', 'provider_ids', 'type', 'limit', 'time_basis',
      ].includes(key)) ||
      request.type != null && request.type !== 'earthquake' ||
      request.time_basis != null && request.time_basis !== 'observed' ||
      request.provider_ids != null && (
        !Array.isArray(request.provider_ids) || request.provider_ids.length !== 1 ||
        request.provider_ids[0] !== 'usgs-earthquakes-all-hour'
      )) {
    throw new Error('UNSUPPORTED_PUBLIC_QUERY');
  }
  const result = await runPublicUsgsNexusQuery({ limit: request.limit ?? 10 });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch {
  process.stderr.write('ARGUS_PUBLIC_NEXUS_QUERY_FAILED\n');
  process.exitCode = 2;
}
