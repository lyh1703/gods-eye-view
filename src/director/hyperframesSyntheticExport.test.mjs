import test from 'node:test';
import assert from 'node:assert/strict';
import {buildSyntheticHyperframesComposition, validateSyntheticStoryboard, HyperframesSyntheticError} from './hyperframesSyntheticExport.js';

const fixture = {
  kind: 'SYNTHETIC_ILLUSTRATION',
  title: 'Research Example',
  bars: [
    {label: 'Group A', value: 31.5},
    {label: 'Group B', value: 77},
  ],
};

test('deterministic editable HyperFrames storyboard and truthful overlay', () => {
  const a = buildSyntheticHyperframesComposition(fixture);
  const b = buildSyntheticHyperframesComposition(fixture);
  assert.equal(a.html, b.html);
  assert.equal(a.manifest.html_sha256, b.manifest.html_sha256);
  assert.equal(a.manifest.source_class, 'SYNTHETIC_ILLUSTRATION');
  assert.ok(a.html.includes('data-composition-id="argus-synthetic"'));
  assert.ok(a.html.includes('window.__timelines["argus-synthetic"]=timeline'));
  assert.ok(a.html.includes('data-duration="10"'));
  assert.ok(a.html.includes('SYNTHETIC DATA — NOT OBSERVED'));
  assert.ok(a.html.includes('Group B'));
  assert.ok(a.html.includes('77.0%'));
  assert.ok(!a.html.includes('https://maps.googleapis.com/'));
});

test('reject misleading observed data and invalid series', () => {
  const variants = [
    {...fixture, kind:'OBSERVED'},
    {...fixture, bars:[]},
    {...fixture, bars:[{label:'only',value:4}]},
    {...fixture, bars:[{label:'one',value:101},{label:'two',value:40}]},
    {...fixture, bars:[{label:'same',value:1},{label:'same',value:2}]},
    {...fixture, live: true},
  ];
  for (const x of variants) assert.throws(
    () => validateSyntheticStoryboard(x), HyperframesSyntheticError);
});

test('escape all user text; never insert executable markup', () => {
  const x = buildSyntheticHyperframesComposition({
    kind:'SYNTHETIC_ILLUSTRATION',
    title: '</h1><script>evil()</script>',
    bars:[{label:'<img src=x onerror=evil()>',value:1},{label:'ok',value:2}],
  });
  assert.ok(x.html.includes('&lt;script&gt;evil()&lt;/script&gt;'));
  assert.ok(x.html.includes('&lt;img src=x onerror=evil()&gt;'));
  assert.ok(!x.html.includes('<script>evil()'));
});
