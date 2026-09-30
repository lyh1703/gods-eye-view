const CAPABILITY_STATUS = 'inherited_present_unmapped';

export const UPSTREAM_GEV_CAPABILITY_INVENTORY = Object.freeze([
  {
    capability_id: 'aviation-flights',
    domain: 'aviation',
    code_paths: [
      'src/app/layers/flights.js',
      'src/layers/flights/index.js',
      'server/providers/aircraft/opensky.js',
      'server/providers/aircraft/adsb-lol.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'local-adsb',
    domain: 'aviation',
    code_paths: [
      'src/app/layers/localAdsb.js',
      'src/layers/localAdsb/index.js',
      'src/sdr/adsbDecoder.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'ais-vessels',
    domain: 'maritime',
    code_paths: [
      'src/app/layers/aisLiveVessels.js',
      'server/providers/vessels/ais-live.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'weather',
    domain: 'weather',
    code_paths: ['server/providers/weather.js'],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'traffic',
    domain: 'mobility',
    code_paths: [
      'src/app/layers/traffic.js',
      'server/providers/traffic.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'cctv',
    domain: 'vision',
    code_paths: [
      'src/app/layers/cctv.js',
      'server/providers/cctv.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'space-satellites-launches',
    domain: 'space',
    code_paths: [
      'src/app/layers/satellites.js',
      'src/app/layers/rocketLaunches.js',
      'server/providers/space.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'fire-firms',
    domain: 'disaster',
    code_paths: [
      'src/app/layers/firms.js',
      'server/providers/firms.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'transit',
    domain: 'mobility',
    code_paths: [
      'src/app/layers/transit.js',
      'server/providers/transit.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
  {
    capability_id: 'radio',
    domain: 'rf-audio',
    code_paths: [
      'src/app/layers/radio.js',
      'server/providers/radio.js',
    ],
    argus_status: CAPABILITY_STATUS,
  },
]);

export function listUpstreamGevCapabilities({ domain } = {}) {
  return UPSTREAM_GEV_CAPABILITY_INVENTORY.filter(
    (capability) => !domain || capability.domain === domain,
  );
}
