const RU_VIEW_UPSTREAM = 'https://github.com/ruvnet/RuView';

function finite(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(field + ' must be finite');
  return number;
}

export function ruViewRuntimeEventToObservation(event) {
  if (!event || typeof event !== 'object')
    throw new TypeError('event must be an object');

  if (event.event_type === 'realtek_csi') {
    const simulated =
      event.synthetic === true || event.source === 'realtek_csi:simulated';
    return {
      id:
        'rf-runtime:' +
        String(event.node_id ?? 'unknown') +
        ':' +
        String(event.sequence ?? event.timestamp_us ?? 'unknown'),
      kind: 'observation',
      domain: 'rf_spatial',
      observationType: 'ruview_runtime_csi_summary',
      source: {
        provider: 'ruview',
        upstream: RU_VIEW_UPSTREAM,
        upstreamType: 'RealtekCsiSnapshot',
        mode: simulated ? 'simulated' : 'live',
      },
      observedAt: null,
      measurements: {
        nodeId: Number(event.node_id ?? 0),
        sequence: Number(event.sequence ?? 0),
        timestampUs: finite(event.timestamp_us ?? 0, 'timestamp_us'),
        channel: Number(event.channel ?? 0),
        bandwidthMhz: Number(event.bandwidth_mhz ?? 0),
        subcarriers: Number(event.num_sub_carrier ?? 0),
        rssiDbm:
          event.rssi_dbm == null ? null : finite(event.rssi_dbm, 'rssi_dbm'),
        meanAmplitude:
          event.mean_amplitude == null
            ? null
            : finite(event.mean_amplitude, 'mean_amplitude'),
        peakAmplitude:
          event.peak_amplitude == null
            ? null
            : finite(event.peak_amplitude, 'peak_amplitude'),
        csiValid: Boolean(event.csi_valid),
      },
      confidence: simulated ? 0.25 : 0.5,
      provenance: {
        upstreamLicense: 'MIT',
        synthetic: simulated,
        transform: 'argus.ruview-runtime-event.v0',
      },
      privacy: {
        personIdentification: false,
        biometricInference: false,
        rawCsiRetention: false,
      },
    };
  }

  if (
    Array.isArray(event.amplitude) &&
    Array.isArray(event.phase) &&
    event.timestamp_unix_ms != null
  ) {
    if (event.amplitude.length !== event.phase.length)
      throw new TypeError('phase length must match amplitude length');
    return {
      id:
        'rf-runtime:' +
        String(event.node_id ?? 'unknown') +
        ':' +
        String(event.timestamp_unix_ms),
      kind: 'observation',
      domain: 'rf_spatial',
      observationType: 'ruview_runtime_csi_frame',
      source: {
        provider: 'ruview',
        upstream: RU_VIEW_UPSTREAM,
        upstreamType: 'CsiData',
        mode: event.synthetic === true ? 'simulated' : 'live',
      },
      observedAt: new Date(finite(event.timestamp_unix_ms, 'timestamp_unix_ms')).toISOString(),
      measurements: {
        nodeId: Number(event.node_id ?? 0),
        antennas: Number(event.n_antennas ?? 0),
        subcarriersPerAntenna: Number(event.n_subcarriers ?? 0),
        samples: event.amplitude.length,
        rssiDbm:
          event.rssi_dbm == null ? null : finite(event.rssi_dbm, 'rssi_dbm'),
        noiseFloorDbm:
          event.noise_floor_dbm == null
            ? null
            : finite(event.noise_floor_dbm, 'noise_floor_dbm'),
        channelFreqMhz: Number(event.channel_freq_mhz ?? 0),
        sequence: Number(event.sequence ?? 0),
      },
      confidence: event.synthetic === true ? 0.25 : 0.5,
      provenance: {
        upstreamLicense: 'MIT',
        synthetic: event.synthetic === true,
        transform: 'argus.ruview-runtime-event.v0',
      },
      privacy: {
        personIdentification: false,
        biometricInference: false,
        rawCsiRetention: false,
      },
    };
  }

  throw new TypeError('unsupported RuView runtime event');
}
