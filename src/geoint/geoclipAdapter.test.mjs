import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGeoClipSidecarCommand, normalizeGeoClipPredictions } from './geoclipAdapter.js';

test('GeoCLIP output is candidate-only and ranked', () => {
  const result = normalizeGeoClipPredictions([
    { lat: 37.5, lon: 126.9, probability: 0.6 },
    { lat: 35.1, lon: 129.0, probability: 0.2 },
  ], { imageId: 'fixture-1' });
  assert.equal(result.kind, 'geoint_candidate_set');
  assert.equal(result.candidates[0].rank, 1);
  assert.ok(result.candidates[0].normalizedConfidence > result.candidates[1].normalizedConfidence);
  assert.equal(result.verification.requiresIndependentCorroboration, true);
});
test('GeoCLIP sidecar command is deterministic', () => {
  assert.deepEqual(buildGeoClipSidecarCommand('sample.jpg', { topK: 3 }), ['python','scripts/geoclip-poc.py','sample.jpg','--top-k','3']);
});
