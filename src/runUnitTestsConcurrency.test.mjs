import test from 'node:test';
import assert from 'node:assert/strict';
import { parallelTestArgs } from '../scripts/run-unit-tests.mjs';

test('ordinary unit tests have bounded cross-file concurrency', () => {
  assert.deepEqual(parallelTestArgs(['src/a.test.mjs', 'src/b.test.mjs']), [
    '--test',
    '--test-concurrency=2',
    'src/a.test.mjs',
    'src/b.test.mjs',
  ]);
});

test('concurrency override is explicit and cannot exceed safe bounds', () => {
  assert.deepEqual(parallelTestArgs(['src/a.test.mjs'], 1), [
    '--test',
    '--test-concurrency=1',
    'src/a.test.mjs',
  ]);
  for (const value of [0, 9, -1, 1.5, NaN, Infinity, '2']) {
    assert.throws(() => parallelTestArgs([], value), RangeError);
  }
});

test('unit runner does not remove or rewrite test paths', () => {
  const files = ['src/devCctv.test.mjs', 'src/data/other.test.mjs'];
  assert.deepEqual(parallelTestArgs(files).slice(2), files);
});
