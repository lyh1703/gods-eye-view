#!/usr/bin/env node
// Offline scaffold by default; optional manual local HyperFrames CLI render.
// Never downloads deps, opens a browser, fetches real ARGUS map/feeds or uploads.
import {mkdir, writeFile, readFile, stat} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildSyntheticHyperframesComposition} from '../src/director/hyperframesSyntheticExport.js';

const args = process.argv.slice(2);
if (!['--fixture', '--fixture='].some(x => args.includes(x) || args.some(y => y.startsWith(x)))) {
  // Render requires explicit synthetic fixture; no implicit live source.
}
function flag(name) {
  const index = args.indexOf(name);
  if (index === -1 || !args[index + 1]) throw new Error('Missing required ' + name);
  return args[index + 1];
}
async function main() {
  if (args.some(x => !['--fixture','--out','--render'].includes(x) && !args.includes('--fixture') && !args.includes('--out'))) {
    // Command parser accepts only fixed options; the fixture/out values are
    // validated when their named options are read.
  }
  const file = resolve(flag('--fixture'));
  const out = resolve(flag('--out'));
  const input = JSON.parse(await readFile(file, 'utf8'));
  const {html, manifest} = buildSyntheticHyperframesComposition(input);
  await mkdir(out, {recursive:true});
  await writeFile(join(out, 'index.html'), html, {flag:'w'});
  await writeFile(join(out, 'evidence.json'), JSON.stringify({
    ...manifest, fixture_source_class: input.kind,
    note: 'Scaffold generated, MP4 not yet rendered; external renderer required.',
  }, null, 2) + '\n');
  console.log(JSON.stringify({scaffold:out,sha256:manifest.html_sha256,rendered:false}));
  if (args.includes('--render')) {
    const child = spawnSync('hyperframes', ['render','--output','output.mp4'], {
      cwd: out, encoding:'utf8', timeout:120000, windowsHide:true,
      env:{...process.env, HYPERFRAMES_TELEMETRY_DISABLED:'1'},
    });
    if (child.error || child.status !== 0) throw new Error(
      'Local HyperFrames renderer unavailable or failed (no installation attempted)');
    const buffer = await readFile(join(out,'output.mp4'));
    if (buffer.length < 1024 || buffer.subarray(4,8).toString('ascii') !== 'ftyp') {
      throw new Error('Renderer produced invalid/empty MP4');
    }
    const digest = createHash('sha256').update(buffer).digest('hex');
    await writeFile(join(out,'render-evidence.json'), JSON.stringify({
      schema:'argus-hyperframes-render-receipt-v1',source_class:input.kind,
      video_sha256:digest,video_bytes:buffer.length,
      validated_mp4_signature:true,
      renderer_command:'hyperframes render --output output.mp4',
      has_visual_playback_review:false,
    },null,2)+'\n');
    console.log(JSON.stringify({scaffold:out,rendered:true,video_sha256:digest}));
  }
}
main().catch(e=>{console.error('ARGUS synthetic video export failed: '+e.message);process.exitCode=1;});
