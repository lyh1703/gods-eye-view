# ARGUS → HyperFrames synthetic explainer export

Source: `heygen-com/hyperframes`, upstream Apache-2.0. The `src/director/hyperframesSyntheticExport.js` module builds an **editable HTML composition** from an explicit `SYNTHETIC_ILLUSTRATION` payload. Never inputs or auto-fetches observed ARGUS geodata, live positions, identities, camera footage or paid media.

## Real executable artifact (no install necessary for scaffold)

```sh
node scripts/export-hyperframes-synthetic.mjs \
  --fixture scripts/fixtures/hyperframes/synthetic-bars.json \
  --out /tmp/argus-hyperframes
```

Output: `index.html` and `evidence.json` (source class, dimension, 10s timeline, SHA256 of HTML). The generated HTML uses HyperFrames' `data-composition-id` and paused GSAP timeline contract, with stable bars and explicit visible **SYNTHETIC DATA — NOT OBSERVED** watermark.

## Actual MP4 (requires locally preinstalled hyperframes CLI / FFmpeg / compatible Chromium and GSAP delivery)

```sh
node scripts/export-hyperframes-synthetic.mjs \
  --fixture scripts/fixtures/hyperframes/synthetic-bars.json \
  --out /tmp/argus-hyperframes --render
```

The adapter calls `hyperframes render --output output.mp4` in the output directory. It does *not* install node modules, download sources, register/login, publish, or upload media. A minimal `ftyp` MP4 signature and SHA256 receipt are emitted if the CLI succeeds. An actual visual review of 10-second motion and media rights remains a separate gate before user-facing marketing output.

The HTML sample references a versioned GSAP CDN script; a sealed offline render must vendor/pin this dependency under a separately reviewed license and asset integrity record. This source contract never certifies a media provider's full rights.

Safety: do not replace the existing ARGUS Director, scene import, map screenshot renderer, existing UI or source provenance. Mocked/fake data must remain clearly synthetic, including every extracted still/video.

## Tests
- `node --test src/director/hyperframesSyntheticExport.test.mjs src/director/hyperframesSyntheticCli.test.mjs`
- Existing root `npm test` discovers `*.test.mjs`.
- Real HyperFrames CLI render E2E is distinct from output scaffolding; keep PENDING until a reproducible real file is validated and played back.
