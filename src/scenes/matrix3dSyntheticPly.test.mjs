import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { inspectMatrix3dPly } from './matrix3dSyntheticPly.js';

const SHA = '3f32ef8c7de41da8ef378ec3eed32d970d73d214';
function fixture() {
  const data = Buffer.from(
    'ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n0 1 2\n',
    'ascii',
  );
  return {
    data,
    meta: {
      origin: 'SkyworkAI/Matrix-3D', source_commit: SHA,
      scene_kind: 'synthetic', independent_geolocation_verified: false,
      sha256: createHash('sha256').update(data).digest('hex'),
    },
  };
}

test('genuine PLY byte fixture checked and always synthetic', async () => {
  const { data, meta } = fixture();
  const value = await inspectMatrix3dPly(data, meta);
  assert.equal(value.vertices, 1);
  assert.equal(value.local_ply_validated, true);
  assert.equal(value.scene_kind, 'synthetic');
  assert.equal(value.map_observation_layer_allowed, false);
  assert.equal(value.independently_observed, false);
  assert.equal(value.model_inference_verified, false);
  assert.equal(value.render_e2e_verified, false);
  assert.equal(value.receiver_verified, false);
});

test('actual content tampering after audit is rejected', async () => {
  const { data, meta } = fixture();
  data[data.length - 2] = '7'.charCodeAt(0);
  await assert.rejects(() => inspectMatrix3dPly(data, meta), /checksum/);
});

test('GPS or observed claims cannot be laundered through Matrix source', async () => {
  const { data, meta } = fixture();
  for (const changed of [
    { scene_kind: 'observed' },
    { independent_geolocation_verified: true },
    { source_commit: 'unverified' },
    { origin: 'Observed Satellite' },
  ]) {
    await assert.rejects(() => inspectMatrix3dPly(data, { ...meta, ...changed }));
  }
});

test('rejects malformed or runaway metadata and fabricated PLY', async () => {
  const { data, meta } = fixture();
  for (const bad of [
    Buffer.from('not-a-ply-header', 'ascii'),
    Buffer.from('ply\nformat binary_big_endian 1.0\nelement vertex 1\nend_header\n\0'),
    Buffer.from('ply\nformat ascii 1.0\nelement vertex 5000001\nend_header\n0 0 0'),
    Buffer.from('ply\nformat ascii 1.0\nelement vertex 0\nend_header\n0 0 0'),
  ]) {
    const newMeta = { ...meta, sha256: createHash('sha256').update(bad).digest('hex') };
    await assert.rejects(() => inspectMatrix3dPly(bad, newMeta));
  }
});
