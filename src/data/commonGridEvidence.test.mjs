import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { inspectCommonGridUtilities } from './commonGridEvidence.js';

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
const COMMIT = '724449879f12519f60446926cd38164761d7d515';
const options = {
  upstreamCommit: COMMIT,
  sourcePublishedDate: '2026-08-09',
  asOfDate: '2026-10-03',
};
const json = JSON.stringify([utility]);

test('source-shaped fixture is research only and hashes real input bytes', async () => {
  const expected = createHash('sha256').update(json, 'utf8').digest('hex');
  const result = await inspectCommonGridUtilities(json, {
    ...options,
    expectedSha256: expected,
  });
  assert.equal(result.sourceSha256, expected);
  assert.equal(result.status, 'RESEARCH_ONLY');
  assert.equal(result.canEnterWorldMemory, false);
  assert.equal(result.observationVerified, false);
  assert.equal(result.upstreamCommit, COMMIT);
  assert.deepEqual(result.utilities[0].jurisdictionCodes, [
    'FL', 'IN', 'KY', 'NC', 'OH', 'SC',
  ]);
  assert.equal('currentGenerationMw' in result.utilities[0], false);
  assert.equal('customerCount' in result.utilities[0], false);
  assert.equal(Object.isFrozen(result.utilities[0]), true);
});

test('cannot claim source from floating tag or unpinned repo', async () => {
  await assert.rejects(
    () => inspectCommonGridUtilities(json, { ...options, upstreamCommit: 'main' }),
    /pinned/,
  );
});

test('rejects tampered bytes if expected digest is supplied', async () => {
  await assert.rejects(
    () => inspectCommonGridUtilities(json, { ...options, expectedSha256: '0'.repeat(64) }),
    /SHA-256/,
  );
});

test('rejects stale, future or malformed source dates', async () => {
  await assert.rejects(
    () => inspectCommonGridUtilities(json, { ...options, sourcePublishedDate: '2025-01-01' }),
    /stale/,
  );
  await assert.rejects(
    () => inspectCommonGridUtilities(json, { ...options, sourcePublishedDate: '2026-12-01' }),
    /future/,
  );
  await assert.rejects(
    () => inspectCommonGridUtilities(json, { ...options, asOfDate: '2026-02-30' }),
    /calendar/,
  );
});

test('rejects duplicate utility identifiers and unsupported geography', async () => {
  await assert.rejects(
    () => inspectCommonGridUtilities(JSON.stringify([utility, utility]), options),
    /duplicate/,
  );
  await assert.rejects(
    () => inspectCommonGridUtilities(
      JSON.stringify([{ ...utility, jurisdiction: 'Japan' }]),
      options,
    ),
    /non-US/,
  );
});

test('rejects missing or ill-typed provenance/content', async () => {
  await assert.rejects(
    () => inspectCommonGridUtilities(json, { ...options, sourcePublishedDate: null }),
    /requires/,
  );
  await assert.rejects(
    () => inspectCommonGridUtilities('[] not json', options),
    /invalid/,
  );
  await assert.rejects(
    () => inspectCommonGridUtilities(JSON.stringify([{ ...utility, name: '' }]), options),
    /name/,
  );
  await assert.rejects(
    () => inspectCommonGridUtilities(JSON.stringify([{ ...utility, segment: 'unknown!' }]), options),
    /segment/,
  );
});

test('bounded empty response does not provide verified observations', async () => {
  const result = await inspectCommonGridUtilities('[]', options);
  assert.deepEqual(result.utilities, []);
  assert.equal(result.canEnterWorldMemory, false);
});
