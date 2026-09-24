const EARTH_RADIUS_KM = 6371.0088;

function toRadians(value) {
  return (value * Math.PI) / 180;
}

function assertFiniteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${field} must be a finite number`);
  }
  return number;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

export function normalizeWorldPoint(center) {
  if (!Array.isArray(center) || center.length < 2) {
    throw new TypeError('center must be [longitude, latitude]');
  }

  const longitude = assertFiniteNumber(center[0], 'center longitude');
  const latitude = assertFiniteNumber(center[1], 'center latitude');
  if (longitude < -180 || longitude > 180) {
    throw new RangeError('center longitude must be between -180 and 180');
  }
  if (latitude < -90 || latitude > 90) {
    throw new RangeError('center latitude must be between -90 and 90');
  }
  return [longitude, latitude];
}

export function pointCoordinates(observation) {
  if (observation?.geometry?.type !== 'Point') return null;
  const coordinates = observation.geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    longitude < -180 ||
    longitude > 180 ||
    latitude < -90 ||
    latitude > 90
  ) {
    return null;
  }

  return [longitude, latitude];
}

export function haversineDistanceKm(left, right) {
  const [leftLongitude, leftLatitude] = normalizeWorldPoint(left);
  const [rightLongitude, rightLatitude] = normalizeWorldPoint(right);
  const latitudeDelta = toRadians(rightLatitude - leftLatitude);
  const longitudeDelta = toRadians(rightLongitude - leftLongitude);
  const leftLatitudeRadians = toRadians(leftLatitude);
  const rightLatitudeRadians = toRadians(rightLatitude);

  const a =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitudeRadians) *
      Math.cos(rightLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function radiusBbox(center, radiusKm) {
  const [longitude, latitude] = normalizeWorldPoint(center);
  const radius = assertFiniteNumber(radiusKm, 'radius_km');
  if (radius < 0) throw new RangeError('radius_km must be non-negative');

  const latitudeDelta = radius / 110.574;
  const cosine = Math.cos(toRadians(latitude));
  if (Math.abs(cosine) < 1e-9) return null;

  const longitudeDelta = radius / (111.32 * Math.abs(cosine));
  const west = longitude - longitudeDelta;
  const east = longitude + longitudeDelta;
  const south = Math.max(-90, latitude - latitudeDelta);
  const north = Math.min(90, latitude + latitudeDelta);

  if (west < -180 || east > 180) return null;
  return [west, south, east, north];
}

export function providerScopedEntityKey(observation) {
  return [
    observation?.provider_id,
    observation?.entity_type,
    observation?.entity_id,
  ].join(':');
}

function observationTimestamp(observation) {
  const observed = Date.parse(observation?.timestamp_observed ?? '');
  const received = Date.parse(observation?.timestamp_received ?? '');
  return Math.max(
    Number.isFinite(observed) ? observed : -Infinity,
    Number.isFinite(received) ? received : -Infinity,
  );
}

export function latestByProviderScopedEntity(observations) {
  const latest = new Map();

  for (const observation of observations) {
    const key = providerScopedEntityKey(observation);
    const previous = latest.get(key);
    if (
      !previous ||
      observationTimestamp(observation) >= observationTimestamp(previous)
    ) {
      latest.set(key, observation);
    }
  }

  return latest;
}

export function observationFingerprint(observation) {
  return JSON.stringify(
    stableValue({
      provider_id: observation?.provider_id ?? null,
      entity_type: observation?.entity_type ?? null,
      entity_id: observation?.entity_id ?? null,
      observation_type: observation?.observation_type ?? null,
      timestamp_observed: observation?.timestamp_observed ?? null,
      geometry: observation?.geometry ?? null,
      properties: observation?.properties ?? {},
      confidence: observation?.confidence ?? null,
      coverage: observation?.coverage ?? null,
      source_url: observation?.source_url ?? null,
    }),
  );
}

export function compareWorldSnapshots(leftObservations, rightObservations) {
  const left = latestByProviderScopedEntity(leftObservations);
  const right = latestByProviderScopedEntity(rightObservations);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();

  const result = {
    added: [],
    removed: [],
    changed: [],
    unchanged: [],
  };

  for (const key of keys) {
    const leftObservation = left.get(key) ?? null;
    const rightObservation = right.get(key) ?? null;

    if (!leftObservation) {
      result.added.push({ key, right: rightObservation });
      continue;
    }
    if (!rightObservation) {
      result.removed.push({ key, left: leftObservation });
      continue;
    }

    const entry = {
      key,
      left: leftObservation,
      right: rightObservation,
    };
    if (
      observationFingerprint(leftObservation) ===
      observationFingerprint(rightObservation)
    ) {
      result.unchanged.push(entry);
    } else {
      result.changed.push(entry);
    }
  }

  return {
    identity: 'provider-scoped-entity',
    summary: {
      added: result.added.length,
      removed: result.removed.length,
      changed: result.changed.length,
      unchanged: result.unchanged.length,
    },
    ...result,
  };
}
