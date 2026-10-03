const UPSTREAM = 'https://github.com/TextureHQ/commongrid';
const SHA40 = /^[0-9a-f]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_INPUT_BYTES = 8_000_000;

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

/**
 * Convert a pinned CommonGrid utilities JSON snapshot into a RESEARCH_ONLY
 * evidence envelope. This method is pure, read-only and never accesses a URL.
 * It deliberately does not synthesize coordinates, power flow or live readings.
 */
export async function inspectCommonGridUtilities(
  rawJson,
  {
    upstreamCommit,
    sourcePublishedDate,
    asOfDate,
    expectedSha256 = null,
    maxAgeDays = 90,
  } = {},
) {
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
  const published = parseDay(sourcePublishedDate, 'sourcePublishedDate');
  const asOf = parseDay(asOfDate, 'asOfDate');
  const age = (asOf - published) / 86_400_000;
  if (
    age < 0 ||
    !Number.isInteger(maxAgeDays) ||
    maxAgeDays < 1 ||
    age > maxAgeDays
  ) {
    throw new Error('snapshot is future-dated or stale');
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
  return Object.freeze({
    schema: 'argus-common-grid-research-v0',
    status: 'RESEARCH_ONLY',
    observationVerified: false,
    canEnterWorldMemory: false,
    originalViewer: 'OpenGridWorks is not the source code for this dataset',
    source: UPSTREAM,
    upstreamCommit,
    sourcePublishedDate,
    asOfDate,
    sourceSha256,
    license: 'ODbL-1.0 (downstream obligations require separate review)',
    utilities: Object.freeze(utilities),
  });
}
