/** Read-only Matrix-3D Gaussian-splat .ply intake contract for ARGUS.
 * This does not run model inference or render PLY; it validates genuine
 * exported PLY bytes so later loaders cannot treat a synthetic scene as
 * observed geolocation. Browser-compatible processing, no external downloads.
 */
export async function inspectMatrix3dPly(input, metadata) {
  if (!(input instanceof Uint8Array) || input.length < 30 || input.length > 64 * 1024 * 1024) {
    throw new Error('bounded nonempty PLY bytes required');
  }
  const prefix = new TextDecoder('ascii').decode(input.subarray(0, 16400));
  const end = prefix.indexOf('end_header\n');
  if (end < 0 || end > 16384) throw new Error('invalid or unbounded PLY header');
  const header = prefix.slice(0, end + 'end_header\n'.length);
  if (!header.startsWith('ply\n')) throw new Error('PLY file signature missing');
  if (!/^format (ascii|binary_little_endian) 1\.0$/m.test(header)) {
    throw new Error('unsupported PLY encoding');
  }
  const match = header.match(/^element vertex (\d+)$/m);
  const vertices = Number(match?.[1]);
  if (!Number.isSafeInteger(vertices) || vertices <= 0 || vertices > 5_000_000) {
    throw new Error('invalid vertex count');
  }
  if (!metadata || typeof metadata !== 'object' ||
      metadata.origin !== 'SkyworkAI/Matrix-3D' ||
      metadata.scene_kind !== 'synthetic' ||
      metadata.independent_geolocation_verified !== false ||
      !/^[a-f0-9]{40}$/.test(metadata.source_commit) ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256)) {
    throw new Error('source pin, synthetic origin and checksum are required');
  }
  const digest = await globalThis.crypto.subtle.digest('SHA-256', input);
  const actualHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  if (actualHash !== metadata.sha256) throw new Error('PLY content checksum mismatch');
  return Object.freeze({
    contract: 'argus-matrix3d-ply-synthetic-receiver-v1',
    source: metadata.origin,
    source_commit: metadata.source_commit,
    sha256: actualHash,
    vertices,
    header_format: header.includes('binary_little_endian') ? 'binary_little_endian' : 'ascii',
    scene_kind: 'synthetic',
    independently_observed: false,
    geolocation_available: false,
    map_observation_layer_allowed: false,
    local_ply_validated: true,
    model_inference_verified: false,
    render_e2e_verified: false,
    receiver_verified: false,
  });
}
