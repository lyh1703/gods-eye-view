import test from 'node:test';
import assert from 'node:assert/strict';

import { ruViewRuntimeEventToObservation } from './ruviewRuntimeEvent.js';

test('maps RuView Realtek simulated runtime snapshot into ARGUS observation', () => {
  const observation = ruViewRuntimeEventToObservation({
    event_type: 'realtek_csi',
    source: 'realtek_csi:simulated',
    node_id: 7,
    sequence: 42,
    timestamp_us: 123456,
    channel: 6,
    bandwidth_mhz: 20,
    num_sub_carrier: 52,
    rssi_dbm: -45,
    csi_valid: true,
    synthetic: true,
    mean_amplitude: 12.5,
    peak_amplitude: 21.0,
  });

  assert.equal(observation.source.mode, 'simulated');
  assert.equal(observation.source.upstreamType, 'RealtekCsiSnapshot');
  assert.equal(observation.measurements.subcarriers, 52);
  assert.equal(observation.measurements.csiValid, true);
  assert.equal(observation.privacy.rawCsiRetention, false);
});

test('maps RuView CsiData boundary without retaining raw arrays', () => {
  const observation = ruViewRuntimeEventToObservation({
    timestamp_unix_ms: 1700000000000,
    node_id: 1,
    n_antennas: 1,
    n_subcarriers: 3,
    amplitude: [5, 10, 3],
    phase: [0.1, 0.2, 0.3],
    rssi_dbm: -45,
    noise_floor_dbm: -90,
    channel_freq_mhz: 2437,
    sequence: 42,
    synthetic: true,
  });

  assert.equal(observation.observationType, 'ruview_runtime_csi_frame');
  assert.equal(observation.measurements.samples, 3);
  assert.equal(observation.measurements.subcarriersPerAntenna, 3);
  assert.equal(observation.privacy.rawCsiRetention, false);
});

test('rejects unsupported RuView runtime payloads', () => {
  assert.throws(() => ruViewRuntimeEventToObservation({ foo: 'bar' }), /unsupported/);
});
