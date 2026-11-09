const UPSTREAM = 'https://github.com/TextureHQ/commongrid';
const SHA40 = /^[0-9a-f]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INPUT_BYTES = 8_000_000;

export const COMMON_GRID_PINNED_SOURCE = Object.freeze({
  upstreamCommit: '724449879f12519f60446926cd38164761d7d515',
  expectedSha256:
    'e019c969e0866715d0976e362cb6997b8c4504ca86821b19524bcdbacc63c166',
  expectedRecordCount: 3_133,
  fileModifiedDate: '2026-05-09',
  officialReleaseDate: null,
  observationAsOf: null,
  datasetVintage: 'EIA Form 861 (2024 XLSX) + Notion Knowledge Base',
  refreshCadence: 'ANNUAL',
  provenanceSources: Object.freeze([
    'https://github.com/TextureHQ/commongrid/blob/724449879f12519f60446926cd38164761d7d515/docs/DATA_CATALOG.md',
    'https://github.com/TextureHQ/commongrid/commit/152875b551aa539b7b5b8d3840ba07d5b25f0946',
  ]),
});

function parseDay(value, field) {
  if (typeof value !== 'string' || !DAY.test(value)) {
    throw new Error(`${field} requires YYYY-MM-DD`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} is not a calendar date`);
  }
  return date;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function resolveTrustedProvenance(upstreamCommit, sourceSha256) {
  if (
    upstreamCommit === COMMON_GRID_PINNED_SOURCE.upstreamCommit &&
    sourceSha256 === COMMON_GRID_PINNED_SOURCE.expectedSha256
  ) {
    return COMMON_GRID_PINNED_SOURCE;
  }
  return null;
}

/**
 * Convert a pinned CommonGrid utilities JSON snapshot into a RESEARCH_ONLY
 * evidence envelope. This method is pure, read-only and never accesses a URL.
 * It deliberately does not synthesize coordinates, power flow or live readings.
 *
 * Source time is never caller-controlled. A commit/hash pair can bind only the
 * clocks that are independently evidenced for those exact bytes. Unknown
 * observation vintage therefore remains blocked as UNVERIFIED_SOURCE_VINTAGE.
 */
export async function inspectCommonGridUtilities(rawJson, options = {}) {
  const {
    upstreamCommit,
    asOfDate,
    expectedSha256 = null,
    sourcePublishedDate,
  } = options;

  if (typeof rawJson !== 'string') {
    throw new Error('source must be bounded UTF-8 JSON string');
  }
  const bytes = new TextEncoder().encode(rawJson);
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new Error('source must be bounded UTF-8 JSON string');
  }
  if (!SHA40.test(upstreamCommit ?? '')) {
    throw new Error('require pinned 40-hex upstream commit');
  }

  parseDay(asOfDate, 'asOfDate');

  if (hasOwn(options, 'sourcePublishedDate')) {
    void sourcePublishedDate;
    throw new Error(
      'sourcePublishedDate is untrusted caller metadata; use receipt-bound provenance',
    );
  }
  if (hasOwn(options, 'maxAgeDays')) {
    throw new Error(
      'maxAgeDays is not a valid CommonGrid source-vintage policy',
    );
  }

  const hashedBytes = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', bytes),
  );
  const sourceSha256 = Array.from(hashedBytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');

  if (expectedSha256 != null && sourceSha256 !== expectedSha256) {
    throw new Error('source SHA-256 mismatch');
  }

  const trustedProvenance = resolveTrustedProvenance(
    upstreamCommit,
    sourceSha256,
  );
  const sourceVintageStatus = trustedProvenance
    ? 'UNVERIFIED_SOURCE_VINTAGE'
    : 'UNVERIFIED_SOURCE_RECEIPT';

  let decoded;
  try {
    decoded = JSON.parse(rawJson);
  } catch {
    throw new Error('source JSON is invalid');
  }
  if (!Array.isArray(decoded) || decoded.length > 5_000) {
    throw new Error('utilities must be bounded JSON array');
  }

  const seen = new Set();
  const utilities = decoded.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new Error('invalid utility entry');
    }
    if (
      typeof record.id !== 'string' ||
      !/^[a-zA-Z0-9-]{8,64}$/.test(record.id)
    ) {
      throw new Error('utility id is missing or unsafe');
    }
    if (seen.has(record.id)) throw new Error('duplicate utility id');
    seen.add(record.id);

    if (
      typeof record.name !== 'string' ||
      !record.name.trim() ||
      record.name.length > 240
    ) {
      throw new Error('utility name missing or too long');
    }
    if (
      typeof record.segment !== 'string' ||
      !/^[A-Z_]{2,64}$/.test(record.segment)
    ) {
      throw new Error('utility segment missing or invalid');
    }
    if (
      record.jurisdiction != null &&
      typeof record.jurisdiction !== 'string'
    ) {
      throw new Error('jurisdiction type invalid');
    }

    const regions = (record.jurisdiction || '')
      .split(',')
      .map((region) => region.trim())
      .filter(Boolean);
    if (regions.some((region) => !/^[A-Z]{2}$/.test(region))) {
      throw new Error('non-US jurisdiction code');
    }

    // Strict allowlist: no location points or inferred live output.
    return Object.freeze({
      id: record.id,
      name: record.name.trim(),
      segment: record.segment,
      jurisdictionCodes: Object.freeze(regions),
    });
  });

  const sourceClock = Object.freeze({
    fileModifiedDate: trustedProvenance?.fileModifiedDate ?? null,
    officialReleaseDate: trustedProvenance?.officialReleaseDate ?? null,
    observationAsOf: trustedProvenance?.observationAsOf ?? null,
    datasetVintage: trustedProvenance?.datasetVintage ?? null,
    refreshCadence: trustedProvenance?.refreshCadence ?? null,
  });

  return Object.freeze({
    schema: 'argus-common-grid-research-v1',
    status: 'RESEARCH_ONLY',
    sourceVintageStatus,
    freshnessVerified: false,
    observationVerified: false,
    canEnterWorldMemory: false,
    originalViewer: 'OpenGridWorks is not the source code for this dataset',
    source: UPSTREAM,
    upstreamCommit,
    inspectedAsOfDate: asOfDate,
    sourceSha256,
    sourceClock,
    provenanceSources:
      trustedProvenance?.provenanceSources ?? Object.freeze([]),
    license: 'ODbL-1.0 (downstream obligations require separate review)',
    utilities: Object.freeze(utilities),
  });
}
