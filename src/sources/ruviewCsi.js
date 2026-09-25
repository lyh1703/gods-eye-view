const RU_VIEW_UPSTREAM = 'https://github.com/ruvnet/RuView';

function asFiniteArray(value, field) {
  if (!Array.isArray(value) || value.length === 0)
    throw new TypeError(field + ' must be a non-empty array');
  const out = value.map(Number);
  if (out.some((v) => !Number.isFinite(v)))
    throw new TypeError(field + ' must contain only finite numbers');
  return out;
}
function timestampMs(frame) {
  if (Number.isFinite(Number(frame.timestamp_unix_ms)))
    return Math.trunc(Number(frame.timestamp_unix_ms));
  if (frame.timestamp != null) {
    const parsed = Date.parse(frame.timestamp);
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new TypeError('frame requires timestamp_unix_ms or an ISO timestamp');
}
function mean(values) {
  return values.reduce((s, v) => s + v, 0) / values.length;
}
function variance(values, avg) {
  return values.reduce((s, v) => s + (v - avg) ** 2, 0) / values.length;
}
function circularVariance(phases) {
  if (!phases.length) return null;
  const c = phases.reduce((s, x) => s + Math.cos(x), 0) / phases.length;
  const s = phases.reduce((a, x) => a + Math.sin(x), 0) / phases.length;
  return 1 - Math.sqrt(c * c + s * s);
}
function motionScore(current, previous) {
  if (!previous || current.length !== previous.length) return 0;
  const baseline = Math.max(mean(previous.map((x) => Math.abs(x))), 1e-9);
  return mean(current.map((x, i) => Math.abs(x - previous[i]))) / baseline;
}
export function validateRuViewCsiFrame(frame) {
  if (!frame || typeof frame !== 'object')
    throw new TypeError('frame must be an object');
  const amplitude = asFiniteArray(frame.amplitude, 'amplitude');
  const phase = frame.phase == null ? [] : asFiniteArray(frame.phase, 'phase');
  if (phase.length && phase.length !== amplitude.length)
    throw new TypeError('phase length must match amplitude length');
  const rssi = frame.rssi_dbm == null ? null : Number(frame.rssi_dbm);
  if (rssi != null && !Number.isFinite(rssi))
    throw new TypeError('rssi_dbm must be finite');
  return {
    ...frame,
    amplitude,
    phase,
    timestampMs: timestampMs(frame),
    nodeId: String(frame.node_id ?? frame.nodeId ?? 'unknown'),
    rssi,
  };
}
export function ruViewFrameToObservation(frame, previousFrame = null) {
  const current = validateRuViewCsiFrame(frame);
  const previous = previousFrame ? validateRuViewCsiFrame(previousFrame) : null;
  const avg = mean(current.amplitude);
  const simulated = Boolean(current.synthetic ?? current.simulated);
  return {
    id: 'rf:' + current.nodeId + ':' + current.timestampMs,
    kind: 'observation',
    domain: 'rf_spatial',
    observationType: 'wifi_csi',
    observedAt: new Date(current.timestampMs).toISOString(),
    source: {
      provider: 'ruview',
      nodeId: current.nodeId,
      mode: simulated ? 'simulated' : 'live',
      upstream: RU_VIEW_UPSTREAM,
    },
    measurements: {
      subcarriers: current.amplitude.length,
      amplitudeMean: avg,
      amplitudeVariance: variance(current.amplitude, avg),
      phaseCircularVariance: circularVariance(current.phase),
      motionScore: motionScore(current.amplitude, previous?.amplitude),
      rssiDbm: current.rssi,
    },
    confidence: simulated ? 0.25 : 0.5,
    provenance: {
      upstreamLicense: 'MIT',
      synthetic: simulated,
      transform: 'argus.ruview-csi.v0',
    },
    privacy: {
      personIdentification: false,
      biometricInference: false,
      rawCsiRetention: false,
    },
  };
}
export function makeSimulatedRuViewSequence(opts = {}) {
  const frames = opts.frames ?? 12,
    subcarriers = opts.subcarriers ?? 56,
    nodeId = opts.nodeId ?? 1;
  const startMs = opts.startMs ?? 1700000000000,
    samplePeriodMs = opts.samplePeriodMs ?? 10;
  const baseAmplitude = opts.baseAmplitude ?? 1,
    motionAmplitude = opts.motionAmplitude ?? 0.15;
  if (!Number.isInteger(frames) || frames < 2)
    throw new TypeError('frames must be >= 2');
  if (!Number.isInteger(subcarriers) || subcarriers < 4)
    throw new TypeError('subcarriers must be >= 4');
  return Array.from({ length: frames }, (_, t) => ({
    timestamp_unix_ms: startMs + t * samplePeriodMs,
    node_id: nodeId,
    amplitude: Array.from(
      { length: subcarriers },
      (_, k) =>
        baseAmplitude +
        Math.sin(k * 0.17) * 0.04 +
        Math.sin((t / frames) * Math.PI * 2 + k * 0.07) * motionAmplitude,
    ),
    phase: Array.from({ length: subcarriers }, (_, k) =>
      Math.atan2(Math.sin(k * 0.11 + t * 0.03), Math.cos(k * 0.11 + t * 0.03)),
    ),
    rssi_dbm: -48,
    synthetic: true,
  }));
}
