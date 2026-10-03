/**
 * Read-only CommonGrid public dataset probe.
 * Do not promote output to ARGUS World Memory or use it as live electrical telemetry.
 * Run: node scripts/probe-commongrid-public.mjs
 */
import { inspectCommonGridUtilities } from '../src/data/commonGridEvidence.js';

const upstreamCommit = '724449879f12519f60446926cd38164761d7d515';
const upstreamCommitDate = '2026-10-01'; // Repository COMMIT date, not an asset-observation time.
const upstream = `https://raw.githubusercontent.com/TextureHQ/commongrid/${upstreamCommit}/data/utilities.json`;

const response = await fetch(upstream, {
  signal: AbortSignal.timeout(20_000),
  redirect: 'error',
  headers: { Accept: 'application/json' },
});
if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
const type = response.headers.get('content-type') || '';
if (!/json|text\/plain|octet-stream/i.test(type)) {
  throw new Error(`unexpected upstream response content-type ${type}`);
}
const contentLength = Number(response.headers.get('content-length') || '0');
if (!Number.isFinite(contentLength) || contentLength > 8_000_000) {
  throw new Error('upstream content too large');
}
const raw = await response.text();
const evidence = await inspectCommonGridUtilities(raw, {
  upstreamCommit,
  sourcePublishedDate: upstreamCommitDate,
  asOfDate: new Date().toISOString().slice(0, 10),
  maxAgeDays: 90,
});
if (evidence.utilities.length < 1 || evidence.canEnterWorldMemory !== false) {
  throw new Error('unexpected source data count or observed state');
}
console.log(JSON.stringify({
  status: 'PASS_PUBLIC_SOURCE',
  source: upstream,
  commit: upstreamCommit,
  commitDateNotObservationTime: upstreamCommitDate,
  sourceSha256: evidence.sourceSha256,
  utilityCount: evidence.utilities.length,
  dataType: 'US electrical utilities',
  rights: 'ODbL-1.0; derivative obligations require separate license review',
  livePowerTelemetry: false,
  worldMemoryEligible: evidence.canEnterWorldMemory,
}));
