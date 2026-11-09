import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  COMMON_GRID_PINNED_SOURCE,
  inspectCommonGridUtilities,
} from './commonGridEvidence.js';

// Structure grounded in the actual public CommonGrid utilities.json file.
const utility = {
  id: '2dc5b7fc-9f3d-8198-942c-cfeb9aa94d94',
  name: 'Duke Energy',
  segment: 'INVESTOR_OWNED_UTILITY',
  jurisdiction: 'FL, IN, KY, NC, OH, SC',
  customerCount: 7183801,
  website: 'https://www.duke-energy.com',
  // Untrusted extra field must never become a measured power observation.
  currentGenerationMw: 999999,
};
const COMMIT = COMMON_GRID_PINNED_SOURCE.upstreamCommit;
const options = {
  upstreamCommit: COMMIT,
  asOfDate: '2026-11-10',
};
const json = JSON.stringify([utility]);

test('source-shaped fixture stays research only without a trusted receipt', async () => {
  const expected = createHash('sha256').update(json, 'utf8').digest('hex');
  const result = await inspectCommonGridUtilities(json, {
    ...options,
    expectedSha256: expected,
  });

  assert.equal(result.sourceSha256, expected);
  assert.equal(result.status, 'RESEARCH_ONLY');
  assert.equal(result.sourceVintageStatus, 'UNVERIFIED_SOURCE_RECEIPT');
  assert.equal(result.freshnessVerified, false);
  assert.equal(result.canEnterWorldMemory, false);
  assert.equal(result.observationVerified, false);
  assert.equal(result.upstreamCommit, COMMIT);
  assert.equal(result.sourceClock.fileModifiedDate, null);
  assert.equal(result.sourceClock.officialReleaseDate, null);
  assert.equal(result.sourceClock.observationAsOf, null);
  assert.deepEqual(result.utilities[0].jurisdictionCodes, [
    'FL',
    'IN',
    'KY',
    'NC',
    'OH',
    'SC',
  ]);
  assert.equal('currentGenerationMw' in result.utilities[0], false);
  assert.equal('customerCount' in result.utilities[0], false);
  assert.equal(Object.isFrozen(result.utilities[0]), true);
});

test('cannot claim source from floating tag or unpinned repo', async () => {
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(json, {
        ...options,
        upstreamCommit: 'main',
      }),
    /pinned/,
  );
});

test('rejects tampered bytes if expected digest is supplied', async () => {
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(json, {
        ...options,
        expectedSha256: '0'.repeat(64),
      }),
    /SHA-256/,
  );
});

test('caller dates and generic age gates cannot manufacture freshness', async () => {
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(json, {
        ...options,
        sourcePublishedDate: '2026-11-10',
      }),
    /untrusted caller metadata/,
  );
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(json, {
        ...options,
        maxAgeDays: 90,
      }),
    /source-vintage policy/,
  );
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(json, {
        ...options,
        asOfDate: '2026-02-30',
      }),
    /calendar/,
  );
});

test('rejects duplicate utility identifiers and unsupported geography', async () => {
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(
        JSON.stringify([utility, utility]),
        options,
      ),
    /duplicate/,
  );
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(
        JSON.stringify([{ ...utility, jurisdiction: 'Japan' }]),
        options,
      ),
    /non-US/,
  );
});

test('rejects missing or ill-typed provenance/content', async () => {
  await assert.rejects(
    () => inspectCommonGridUtilities(json, { upstreamCommit: COMMIT }),
    /asOfDate requires/,
  );
  await assert.rejects(
    () => inspectCommonGridUtilities('[] not json', options),
    /invalid/,
  );
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(
        JSON.stringify([{ ...utility, name: '' }]),
        options,
      ),
    /name/,
  );
  await assert.rejects(
    () =>
      inspectCommonGridUtilities(
        JSON.stringify([{ ...utility, segment: 'unknown!' }]),
        options,
      ),
    /segment/,
  );
});

test('bounded empty response does not provide verified observations', async () => {
  const result = await inspectCommonGridUtilities('[]', options);
  assert.deepEqual(result.utilities, []);
  assert.equal(result.freshnessVerified, false);
  assert.equal(result.canEnterWorldMemory, false);
});

test('trusted receipt documents distinct clocks without inventing observation time', () => {
  assert.equal(COMMON_GRID_PINNED_SOURCE.fileModifiedDate, '2026-05-09');
  assert.equal(COMMON_GRID_PINNED_SOURCE.officialReleaseDate, null);
  assert.equal(COMMON_GRID_PINNED_SOURCE.observationAsOf, null);
  assert.equal(
    COMMON_GRID_PINNED_SOURCE.datasetVintage,
    'EIA Form 861 (2024 XLSX) + Notion Knowledge Base',
  );
  assert.equal(COMMON_GRID_PINNED_SOURCE.refreshCadence, 'ANNUAL');
  assert.equal(COMMON_GRID_PINNED_SOURCE.expectedRecordCount, 3_133);
});
