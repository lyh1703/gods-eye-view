#!/usr/bin/env node
// Real Chromium + WebGL smoke for the Cesium UI presentation labels.
// Uses a clearly labeled deterministic fixture: real public-source/PostGIS
// readback is independently tested by worldMemorySource.postgres.test.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { createServer } from 'vite';

const candidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);
const executablePath = candidates.find((candidate) => fs.existsSync(candidate));
assert.ok(executablePath, 'An installed Chromium/Chrome binary is required');

const vite = await createServer({
  server: { host: '127.0.0.1', port: 4187, strictPort: true },
});
let browser;
try {
  await vite.listen();
  browser = await puppeteer.launch({
    headless: true,
    executablePath,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--use-gl=angle',
      '--use-angle=swiftshader',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 720, deviceScaleFactor: 1 });
  const failures = [];
  page.on('pageerror', (error) => failures.push(error.message));
  await page.goto('http://127.0.0.1:4187/qa/argus-g5-browser.html', {
    waitUntil: 'domcontentloaded',
    timeout: 90_000,
  });
  await page.waitForFunction(() => Boolean(window.__g5?.layer), {
    timeout: 90_000,
  });

  const snapshot = () => page.evaluate(() => {
    const { viewer, layer } = window.__g5;
    const entity = viewer.dataSources.get(0).entities.getById('earthquake:g5-fixture');
    const label = document.querySelector('#labels span');
    const rectangle = label?.getBoundingClientRect();
    return {
      canvas: viewer.canvas.width > 0 && viewer.canvas.height > 0,
      webgl: Boolean(viewer.scene.context?._gl),
      viewerEntity: Boolean(entity),
      classification: entity?.properties.presentationClass.getValue(),
      text: label?.textContent ?? null,
      visible: Boolean(rectangle && rectangle.width > 0 && rectangle.height > 0),
      source: layer.getStats().source,
    };
  });
  let view = await snapshot();
  assert.equal(view.canvas, true, 'Cesium browser canvas is absent');
  assert.equal(view.webgl, true, 'Cesium WebGL context is absent');
  assert.equal(view.viewerEntity, true, 'real Cesium Viewer has no event entity');
  assert.equal(view.visible, true, 'DOM marker label not visibly laid out');
  assert.equal(view.classification, 'PERSISTED_OBSERVATION');
  assert.match(view.text, /PERSISTED OBS/);

  await page.evaluate(async () => {
    window.__g5.setDisconnected(true);
    await window.__g5.refresh();
  });
  view = await snapshot();
  assert.equal(view.classification, 'STALE_REFERENCE');
  assert.match(view.text, /STALE REF/);

  await page.evaluate(async () => {
    window.__g5.setDisconnected(false);
    await window.__g5.refresh();
  });
  view = await snapshot();
  assert.equal(view.classification, 'PERSISTED_OBSERVATION');
  assert.match(view.text, /PERSISTED OBS/);
  assert.deepEqual(failures, [], 'Chromium page errors');
  const shotDir = path.resolve('qa-shots/argus-g5');
  fs.mkdirSync(shotDir, { recursive: true });
  await page.screenshot({ path: path.join(shotDir, 'cesium-persisted-observation.png') });
  console.log(JSON.stringify({
    gate: 'real-chromium-cesium-webgl-dom-label',
    browser: executablePath,
    canvas: view.canvas,
    webgl: view.webgl,
    visible: view.visible,
    restored: view.classification,
    data: 'deterministic UI fixture (NOT a live event)',
  }));
} finally {
  await browser?.close();
  await vite.close();
}
