import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const manifestUrl = new URL('./research004TransferContract.json', import.meta.url);
const data = JSON.parse(readFileSync(fileURLToPath(manifestUrl), 'utf8'));

test('Research004 Stage12 environmental transfer keeps provenance and safety boundaries', () => {
  assert.equal(data.schema_version, 'research004-transfer-v1');
  assert.equal(data.transfer_id, '004-ST12-ARGUS-ENVIRONMENTAL-V1');
  assert.equal(data.source.stage9_run, 37559041532);
  assert.equal(data.receiver.canonical_branch, 'argus/main');
  assert.equal(data.receiver.direct_observation, false);
  assert.equal(data.evidence.water.stage9.gate_pass, true);
  assert.equal(data.evidence.disaster.stage9.gate_pass, true);
  assert.equal(data.evidence.water.stage11.gate_pass, true);
  assert.equal(data.evidence.disaster.stage11.gate_pass, true);
  assert.equal(data.integration_policy.classification, 'DERIVED_PROXY_EVIDENCE');
  assert.ok(data.integration_policy.must_not_label_as.includes('DIRECT_OBSERVATION'));
  assert.ok(data.integration_policy.must_not_label_as.includes('EVENT_ATTRIBUTION'));
  assert.ok(data.integration_policy.may_not_assert.includes('exhaustive_flood_detection'));
  assert.ok(data.integration_policy.may_not_assert.includes('forecast_skill'));
});
