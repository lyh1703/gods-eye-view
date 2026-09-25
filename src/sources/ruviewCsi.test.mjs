import test from 'node:test';
import assert from 'node:assert/strict';
import { makeSimulatedRuViewSequence, ruViewFrameToObservation, validateRuViewCsiFrame } from './ruviewCsi.js';

test('simulated RuView CSI converts into privacy-bounded ARGUS observations', () => {
  const frames = makeSimulatedRuViewSequence({ frames: 5, subcarriers: 56 });
  const first = ruViewFrameToObservation(frames[0]);
  const second = ruViewFrameToObservation(frames[1], frames[0]);
  assert.equal(first.domain, 'rf_spatial');
  assert.equal(first.source.mode, 'simulated');
  assert.equal(first.measurements.subcarriers, 56);
  assert.equal(first.privacy.personIdentification, false);
  assert.equal(first.privacy.rawCsiRetention, false);
  assert.ok(second.measurements.motionScore > 0);
});

test('RuView CSI validation rejects mismatched vectors', () => {
  assert.throws(() => validateRuViewCsiFrame({ timestamp_unix_ms: 1, amplitude: [1,2], phase: [0] }), /phase length/);
});
