/**
 * Read-only CommonGrid public dataset probe.
 * Do not promote output to ARGUS World Memory or use it as live electrical telemetry.
 * Run: node scripts/probe-commongrid-public.mjs
 */
import {
  COMMON_GRID_PINNED_SOURCE,
  inspectCommonGridUtilities,
} from '../src/data/commonGridEvidence.js';

const upstreamCommit = COMMON_GRID_PINNED_SOURCE.upstreamCommit;
const expectedSha256 = COMMON_GRID_PINNED_SOURCE.expectedSha256;
const expectedRecordCount = COMMON_GRID_PINNED_SOURCE.expectedRecordCount;
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
const asOfDate = new Date().toISOString().slice(0, 10);

let forgedFreshDateRejected = false;
try {
  await inspectCommonGridUtilities(raw, {
    upstreamCommit,
    expectedSha256,
    asOfDate,
    sourcePublishedDate: asOfDate,
  });
} catch (error) {
  if (!/untrusted caller metadata/.test(String(error?.message || error))) {
    throw error;
  }
  forgedFreshDateRejected = true;
}
if (!forgedFreshDateRejected) {
  throw new Error('forged sourcePublishedDate was not rejected');
}

const evidence = await inspectCommonGridUtilities(raw, {
  upstreamCommit,
  expectedSha256,
  asOfDate,
});

if (evidence.utilities.length !== expectedRecordCount) {
  throw new Error(
    `unexpected source data count: ${evidence.utilities.length} != ${expectedRecordCount}`,
  );
}
if (evidence.sourceSha256 !== expectedSha256) {
  throw new Error('pinned CommonGrid source digest did not match');
}
if (
  evidence.status !== 'RESEARCH_ONLY' ||
  evidence.sourceVintageStatus !== 'UNVERIFIED_SOURCE_VINTAGE' ||
  evidence.freshnessVerified !== false ||
  evidence.observationVerified !== false ||
  evidence.canEnterWorldMemory !== false
) {
  throw new Error('unexpected CommonGrid trust or operating state');
}
if (
  evidence.sourceClock.fileModifiedDate !==
    COMMON_GRID_PINNED_SOURCE.fileModifiedDate ||
  evidence.sourceClock.officialReleaseDate !== null ||
  evidence.sourceClock.observationAsOf !== null ||
  evidence.sourceClock.datasetVintage !==
    COMMON_GRID_PINNED_SOURCE.datasetVintage ||
  evidence.sourceClock.refreshCadence !==
    COMMON_GRID_PINNED_SOURCE.refreshCadence
) {
  throw new Error('CommonGrid source clocks were not kept distinct');
}

console.log(
  JSON.stringify({
    status: 'PASS_PUBLIC_SOURCE_PINNED_BYTES',
    source: upstream,
    commit: upstreamCommit,
    sourceSha256: evidence.sourceSha256,
    utilityCount: evidence.utilities.length,
    forgedFreshDateRejected,
    sourceVintageStatus: evidence.sourceVintageStatus,
    freshnessVerified: evidence.freshnessVerified,
    fileModifiedDate: evidence.sourceClock.fileModifiedDate,
    officialReleaseDate: evidence.sourceClock.officialReleaseDate,
    observationAsOf: evidence.sourceClock.observationAsOf,
    datasetVintage: evidence.sourceClock.datasetVintage,
    refreshCadence: evidence.sourceClock.refreshCadence,
    dataType: 'US electrical utilities',
    rights:
      'ODbL-1.0; derivative obligations require separate license review',
    livePowerTelemetry: false,
    worldMemoryEligible: evidence.canEnterWorldMemory,
  }),
);
