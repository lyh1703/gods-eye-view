function capability({
  capability_id,
  domain,
  code_paths,
  mapped_to_argus = false,
  implemented = mapped_to_argus,
  query_callable = false,
  validated = false,
  operational = false,
}) {
  const status = Object.freeze({
    inherited_present: true,
    mapped_to_argus,
    implemented,
    query_callable,
    validated,
    operational,
  });
  const argus_status = operational
    ? 'operational'
    : validated
      ? 'validated'
      : query_callable
        ? 'query_callable'
        : implemented
          ? 'implemented'
          : mapped_to_argus
            ? 'mapped_to_argus'
            : 'inherited_present';

  return Object.freeze({
    capability_id,
    domain,
    code_paths: Object.freeze([...code_paths]),
    status,
    argus_status,
  });
}

export const UPSTREAM_GEV_CAPABILITY_INVENTORY = Object.freeze([
  capability({
    capability_id: 'aviation-flights',
    domain: 'aviation',
    code_paths: [
      'src/app/layers/flights.js',
      'src/layers/flights/index.js',
      'src/sources/live/aircraft.js',
      'server/providers/aircraft/opensky.js',
      'server/providers/aircraft/adsb-lol.js',
    ],
    mapped_to_argus: true,
    query_callable: true,
    validated: true,
  }),
  capability({
    capability_id: 'local-adsb',
    domain: 'aviation',
    code_paths: [
      'src/app/layers/localAdsb.js',
      'src/layers/localAdsb/index.js',
      'src/sdr/adsbDecoder.js',
      'server/providers/local-receivers.js',
    ],
  }),
  capability({
    capability_id: 'ais-vessels',
    domain: 'maritime',
    code_paths: [
      'src/app/layers/aisLiveVessels.js',
      'src/layers/vessels/index.js',
      'server/providers/vessels/ais-live.js',
      'server/providers/vessels/ais-store.js',
      'src/argus/providers/gevAisVessels.js',
    ],
    mapped_to_argus: true,
    implemented: true,
    query_callable: true,
  }),
  capability({
    capability_id: 'weather-imagery',
    domain: 'weather',
    code_paths: [
      'src/layers/weather/index.js',
      'src/layers/weather/source.js',
      'server/providers/weather.js',
    ],
  }),
  capability({
    capability_id: 'regional-weather',
    domain: 'weather',
    code_paths: [
      'src/data/regionalModel.js',
      'server/providers/regional/weather.js',
      'server/providers/regional/briefing.js',
    ],
    mapped_to_argus: true,
    query_callable: true,
    validated: true,
  }),
  capability({
    capability_id: 'wind-fields',
    domain: 'weather',
    code_paths: [
      'src/layers/wind/index.js',
      'src/layers/wind/source.js',
      'server/providers/wind.js',
    ],
  }),
  capability({
    capability_id: 'traffic-flow',
    domain: 'mobility',
    code_paths: [
      'src/app/layers/traffic.js',
      'src/layers/traffic/flowSource.js',
      'src/layers/traffic/flowDecode.js',
      'server/providers/traffic.js',
    ],
    mapped_to_argus: true,
    query_callable: true,
    validated: true,
  }),
  capability({
    capability_id: 'transit',
    domain: 'mobility',
    code_paths: [
      'src/app/layers/transit.js',
      'src/layers/transit/index.js',
      'server/providers/transit.js',
      'server/providers/transitHistory.js',
    ],
  }),
  capability({
    capability_id: 'bikeshare',
    domain: 'mobility',
    code_paths: [
      'src/app/layers/bikeshare.js',
      'src/layers/bikeshare/index.js',
      'server/providers/gbfs.js',
    ],
  }),
  capability({
    capability_id: 'directions',
    domain: 'mobility',
    code_paths: [
      'src/app/layers/directions.js',
      'src/layers/directions/index.js',
    ],
  }),
  capability({
    capability_id: 'cctv',
    domain: 'vision',
    code_paths: [
      'src/app/layers/cctv.js',
      'src/layers/cctv/index.js',
      'server/providers/cctv.js',
      'server/providers/cctv/catalog.js',
    ],
  }),
  capability({
    capability_id: 'alpr-cameras',
    domain: 'vision',
    code_paths: ['src/app/layers/alprCameras.js', 'src/layers/alpr/index.js'],
  }),
  capability({
    capability_id: 'fire-firms',
    domain: 'disaster',
    code_paths: [
      'src/app/layers/firms.js',
      'src/layers/firms/index.js',
      'server/providers/firms.js',
      'src/argus/providers/gevFirmsFire.js',
    ],
    mapped_to_argus: true,
    implemented: true,
    query_callable: true,
  }),
  capability({
    capability_id: 'fire-perimeters',
    domain: 'disaster',
    code_paths: [
      'src/app/layers/perimeters.js',
      'src/layers/perimeters/index.js',
      'server/providers/firePerimeters.js',
    ],
  }),
  capability({
    capability_id: 'cyclones',
    domain: 'disaster',
    code_paths: [
      'src/layers/cyclones/index.js',
      'server/providers/cyclones.js',
    ],
  }),
  capability({
    capability_id: 'earthquakes',
    domain: 'disaster',
    code_paths: [
      'src/app/layers/earthquakes.js',
      'src/layers/earthquakes/index.js',
      'src/argus/providers/usgsEarthquakes.js',
    ],
    mapped_to_argus: true,
    query_callable: true,
    validated: true,
    operational: true,
  }),
  capability({
    capability_id: 'space-satellites',
    domain: 'space',
    code_paths: [
      'src/app/layers/satellites.js',
      'src/layers/satellites/index.js',
      'server/providers/space/celestrak.js',
      'src/argus/providers/gevCelestrakSatellites.js',
    ],
    mapped_to_argus: true,
    implemented: true,
    query_callable: true,
  }),
  capability({
    capability_id: 'rocket-launches',
    domain: 'space',
    code_paths: [
      'src/app/layers/rocketLaunches.js',
      'src/layers/launches/index.js',
      'server/providers/space/launch-library.js',
    ],
  }),
  capability({
    capability_id: 'recent-imagery',
    domain: 'imagery',
    code_paths: [
      'src/app/layers/recentImagery.js',
      'src/layers/recentImagery/index.js',
    ],
  }),
  capability({
    capability_id: 'submarine-cables',
    domain: 'infrastructure',
    code_paths: [
      'src/app/layers/submarineCables.js',
      'src/layers/submarineCables/index.js',
    ],
  }),
  capability({
    capability_id: 'military-awareness',
    domain: 'security',
    code_paths: [
      'src/app/layers/militaryAwareness.js',
      'src/layers/awareness/index.js',
    ],
  }),
  capability({
    capability_id: 'military-flights',
    domain: 'security',
    code_paths: [
      'src/app/layers/militaryFlights.js',
      'src/layers/military/index.js',
    ],
  }),
  capability({
    capability_id: 'military-installations',
    domain: 'security',
    code_paths: [
      'src/app/layers/militaryInstallations.js',
      'src/layers/installations/index.js',
      'server/providers/military-installations.js',
    ],
  }),
  capability({
    capability_id: 'radio',
    domain: 'rf-audio',
    code_paths: [
      'src/app/layers/radio.js',
      'src/layers/radio/index.js',
      'server/providers/radio.js',
    ],
  }),
  capability({
    capability_id: 'regional-briefing',
    domain: 'context',
    code_paths: [
      'server/providers/regional/briefing.js',
      'server/providers/regional/place.js',
      'server/providers/regional/news.js',
      'server/providers/regional/weather.js',
    ],
  }),
  capability({
    capability_id: 'places',
    domain: 'context',
    code_paths: [
      'server/providers/places.js',
      'server/providers/places/google.js',
    ],
  }),
  capability({
    capability_id: 'overpass-map-context',
    domain: 'context',
    code_paths: [
      'server/providers/overpass.js',
      'server/providers/overpass/query.js',
    ],
  }),
  capability({
    capability_id: 'terrain',
    domain: 'terrain',
    code_paths: ['server/providers/terrain.js'],
  }),
]);

export function listUpstreamGevCapabilities({
  domain,
  mapped_to_argus,
  implemented,
  query_callable,
  validated,
  operational,
} = {}) {
  return UPSTREAM_GEV_CAPABILITY_INVENTORY.filter((capability) => {
    if (domain && capability.domain !== domain) return false;
    for (const [key, value] of Object.entries({
      mapped_to_argus,
      implemented,
      query_callable,
      validated,
      operational,
    })) {
      if (value != null && capability.status[key] !== value) return false;
    }
    return true;
  });
}

export function getUpstreamGevCapability(capabilityId) {
  return (
    UPSTREAM_GEV_CAPABILITY_INVENTORY.find(
      ({ capability_id }) => capability_id === capabilityId,
    ) ?? null
  );
}
