export function normalizeGeoClipPredictions(predictions, opts = {}) {
  if (!Array.isArray(predictions) || predictions.length === 0)
    throw new TypeError('predictions must be a non-empty array');
  const normalized = predictions.map((p, index) => {
    const lat = Number(p.lat),
      lon = Number(p.lon),
      probability = Number(p.probability ?? p.score ?? 0);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90)
      throw new TypeError('invalid latitude');
    if (!Number.isFinite(lon) || lon < -180 || lon > 180)
      throw new TypeError('invalid longitude');
    if (!Number.isFinite(probability) || probability < 0)
      throw new TypeError('invalid probability');
    return {
      rank: index + 1,
      latitude: lat,
      longitude: lon,
      probability,
    };
  });
  const total = normalized.reduce((s, r) => s + r.probability, 0);
  return {
    kind: 'geoint_candidate_set',
    imageId: opts.imageId ?? 'unknown',
    model: opts.model ?? 'GeoCLIP',
    candidates: normalized.map((r) => ({
      ...r,
      normalizedConfidence:
        total > 0 ? r.probability / total : 1 / normalized.length,
    })),
    verification: {
      status: 'candidate_only',
      requiresIndependentCorroboration: true,
      allowedEvidence: [
        'authorized_map_imagery',
        'authorized_satellite_imagery',
        'user_provided_context',
      ],
    },
    provenance: {
      transform: 'argus.geoclip.v0',
      upstream: 'https://github.com/VicenteVivan/geo-clip',
      upstreamLicense: 'MIT',
    },
  };
}
export function buildGeoClipSidecarCommand(imagePath, opts = {}) {
  const topK = opts.topK ?? 5,
    python = opts.python ?? 'python';
  if (!imagePath || typeof imagePath !== 'string')
    throw new TypeError('imagePath is required');
  if (!Number.isInteger(topK) || topK < 1 || topK > 20)
    throw new TypeError('topK must be 1..20');
  return [python, 'scripts/geoclip-poc.py', imagePath, '--top-k', String(topK)];
}

