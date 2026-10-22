import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';

test('real Node CLI scaffolds a renderable HTML project without installing/running vendor', () => {
  const out = mkdtempSync(join(tmpdir(), 'argus-hf-'));
  try {
    const fixture = resolve('scripts/fixtures/hyperframes/synthetic-bars.json');
    const command = resolve('scripts/export-hyperframes-synthetic.mjs');
    const result = spawnSync(process.execPath,[command,'--fixture',fixture,'--out',out],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.ok(existsSync(join(out,'index.html')));
    assert.ok(!existsSync(join(out,'output.mp4')));
    const html=readFileSync(join(out,'index.html'),'utf8');
    const evidence=JSON.parse(readFileSync(join(out,'evidence.json'),'utf8'));
    assert.equal(evidence.source_class,'SYNTHETIC_ILLUSTRATION');
    assert.equal(evidence.width,1920);
    assert.equal(evidence.height,1080);
    assert.equal(evidence.duration_seconds,10);
    assert.ok(html.includes('SYNTHETIC DATA — NOT OBSERVED'));
  } finally {rmSync(out,{recursive:true,force:true});}
});

test('CLI rejects pretending observed data are synthetic', () => {
  const out = mkdtempSync(join(tmpdir(),'argus-hf-bad-'));
  try {
    const fixture = resolve('scripts/fixtures/hyperframes/synthetic-bars.json');
    const data=JSON.parse(readFileSync(fixture,'utf8'));
    data.kind='OBSERVED';
    const bad=join(out,'bad.json');writeFileSync(bad,JSON.stringify(data));
    const command=resolve('scripts/export-hyperframes-synthetic.mjs');
    const result=spawnSync(process.execPath,[command,'--fixture',bad,'--out',join(out,'export')],{encoding:'utf8'});
    assert.notEqual(result.status,0);
    assert.ok(!existsSync(join(out,'export','index.html')));
  } finally {rmSync(out,{recursive:true,force:true});}
});
