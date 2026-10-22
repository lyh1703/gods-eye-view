// Opt-in HyperFrames-compatible, editable explainer composition.
// This module never reads live ARGUS data, installs packages or renders media.
// Synthetic/illustrative classification is required, never inferred.
import { createHash } from 'node:crypto';

const MAX_ITEMS = 8;

export class HyperframesSyntheticError extends Error {}

const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

export function validateSyntheticStoryboard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || input.kind !== 'SYNTHETIC_ILLUSTRATION'
    || typeof input.title !== 'string' || !input.title.trim()
    || input.title.length > 100
    || !Array.isArray(input.bars) || input.bars.length < 2
    || input.bars.length > MAX_ITEMS) {
    throw new HyperframesSyntheticError('explicit bounded synthetic storyboard required');
  }
  const bars = input.bars.map((item) => {
    if (!item || typeof item.label !== 'string'
      || !item.label.trim() || item.label.length > 32
      || typeof item.value !== 'number' || !Number.isFinite(item.value)
      || item.value < 0 || item.value > 100) {
      throw new HyperframesSyntheticError('invalid synthetic bar');
    }
    return {label: item.label, value: item.value};
  });
  if (new Set(bars.map(x => x.label)).size !== bars.length) {
    throw new HyperframesSyntheticError('duplicate synthetic labels');
  }
  if (Object.keys(input).some(k => !['kind', 'title', 'bars'].includes(k))) {
    throw new HyperframesSyntheticError('undeclared field is forbidden');
  }
  return {kind: input.kind, title: input.title.trim(), bars};
}

export function buildSyntheticHyperframesComposition(input) {
  const data = validateSyntheticStoryboard(input);
  const bars = data.bars.map((item, i) =>
    `<div class="bar-col"><div class="bar" style="--height:${item.value}%"></div><span>${escapeHtml(item.label)}</span><strong>${item.value.toFixed(1)}%</strong></div>`
  ).join('\n');
  // Based on official HyperFrames HTML composition contract: a paused GSAP
  // timeline registered under data-composition-id with seekable animation.
  // A CDN script is required for the GSAP runtime: network policy and asset
  // licensing must be checked separately when rendering with a real browser.
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=1920, height=1080">
<title>ARGUS Synthetic Explainer</title>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:1080px;overflow:hidden;font-family:system-ui,sans-serif;background:#0c1625;color:#f9fbff}
#stage{width:1920px;height:1080px;padding:120px 140px;background:linear-gradient(145deg,#0c1625,#1f3550)}
h1{font-size:84px;letter-spacing:-.035em;margin:0 0 28px;line-height:1.12}
.mark{color:#6edccb;font-size:24px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;margin-bottom:35px}
.bars{display:flex;align-items:flex-end;gap:22px;height:535px;padding:38px 30px 0;border-top:1px solid #52697c}
.bar-col{flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;min-width:0}
.bar{height:calc(var(--height) * var(--growth,1));width:75%;min-height:0;background:#6edccb;border-radius:10px 10px 2px 2px}
.bar-col span{font-size:24px;margin-top:20px;max-width:190px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bar-col strong{font-size:27px;margin-top:9px;color:#6edccb}
.watermark{position:absolute;top:24px;right:35px;font-size:30px;letter-spacing:.13em;color:#f7c867;font-weight:800}
.clip{visibility:hidden}
</style></head><body>
<div id="stage" data-composition-id="argus-synthetic" data-width="1920" data-height="1080" data-start="0" data-duration="10">
<div class="mark">ARGUS / Editable demo</div><h1>${escapeHtml(data.title)}</h1>
<div class="watermark">SYNTHETIC DATA — NOT OBSERVED</div>
<section class="bars clip" data-start="0" data-duration="10" data-track-index="0">
${bars}
</section></div>
<script>
window.__timelines=window.__timelines||{};
const timeline=gsap.timeline({paused:true});
timeline.fromTo(".bars",{opacity:0,"--growth":0},{opacity:1,"--growth":1,duration:2,ease:"power2.out"},0.4);
timeline.set({}, {},10);
window.__timelines["argus-synthetic"]=timeline;
timeline.seek(0);
</script></body></html>\n`;
  const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
  return {
    html, manifest: {
      schema: 'argus-hyperframes-synthetic-v1',
      source_class: 'SYNTHETIC_ILLUSTRATION',
      no_observed_geodata: true,
      composition_id: 'argus-synthetic', duration_seconds: 10,
      width: 1920, height: 1080,
      html_sha256: sha256,
      output_file: 'index.html',
      renderer: 'hyperframes CLI (external, not auto-installed)',
    }
  };
}
