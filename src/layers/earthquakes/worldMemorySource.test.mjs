import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from '../../argus/externalProviderIngest.js';
import { createInMemoryWorldMemoryRepository } from '../../argus/memory/repository.js';
import { createWorldMemoryQueryEngine } from '../../argus/memory/worldMemoryQuery.js';
import { createUsgsEarthquakesAdapter } from '../../argus/providers/usgsEarthquakes.js';
import { createEarthquakesLayer } from './index.js';
import { createWorldMemoryEarthquakeSource } from './worldMemorySource.js';

const observedAt = '2026-10-04T00:00:00.000Z';
const clock = { value: new Date('2026-10-04T00:00:12.000Z') };
const eventId = 'us-argus-ui-reference';
const sourceUrl = 'https://earthquake.usgs.gov/earthquakes/eventpage/' + eventId;

function feed(coords = [127.1, 37.5, 4], time = observedAt) {
  return {
    type: 'FeatureCollection',
    metadata: { generated: Date.parse(time) },
    features: [{
      type: 'Feature',
      id: eventId,
      geometry: { type: 'Point', coordinates: coords },
      properties: {
        mag: 4.1, place: 'ARGUS deterministic UI fixture',
        time: Date.parse(time), status: 'reviewed', url: sourceUrl,
      },
    }],
  };
}

function prepare() {
  let sequence = 0;
  const repository = createInMemoryWorldMemoryRepository({
    now: () => clock.value,
  });
  const ingestor = createExternalProviderIngestor({
    repository,
    now: () => clock.value,
    uuid: () =>
      '00000000-0000-4000-8000-' + (++sequence).toString(16).padStart(12, '0'),
    maxAttempts: 1,
  });
  const world = createWorldMemoryQueryEngine({
    repository, now: () => clock.value,
  });
  const source = createWorldMemoryEarthquakeSource({
    world, now: () => clock.value,
  });
  return { repository, ingestor, world, source };
}

function harness(source) {
  const dataSources = [];
  const overlays = [];
  const viewer = {
    dataSources: {
      add(ds) { dataSources.push(ds); },
      remove(ds) { dataSources.splice(dataSources.indexOf(ds), 1); },
    },
  };
  const layer = createEarthquakesLayer({
    source,
    overlayHost: {
      setVisible() {},
      clearSource() {},
      setEntries(_id, entries) { overlays.push(entries); },
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { viewer, layer, dataSources, overlays };
}

test('World Memory readback reaches actual Cesium entity, map label, rail and analyst seam', async () => {
  clock.value = new Date('2026-10-04T00:00:12.000Z');
  const { repository, ingestor, source } = prepare();
  const adapter = createUsgsEarthquakesAdapter({
    now: () => clock.value,
    fetchImpl: async () => ({ ok: true, json: async () => feed() }),
  });
  const ingest = await ingestor.ingest(adapter);
  assert.equal(ingest.inserted, 1);
  assert.equal(repository.observationCount(), 1);

  const ui = harness(source);
  try {
    assert.equal(await ui.layer.update(ui.viewer), true);
    assert.equal(ui.layer.getStats().count, 1);
    assert.equal(ui.layer.getStats().status, 'nominal');
    assert.equal(ui.layer.name, 'Stored USGS Earthquakes');
    assert.match(ui.layer.getStats().source, /PERSISTED OBSERVATION/);
    assert.match(ui.layer.getRowControls().info, /World Memory/);
    const displayed = ui.dataSources[0].entities.getById('earthquake:' + eventId);
    assert.ok(displayed);
    assert.equal(
      displayed.properties.evidenceKind.getValue(), 'OBSERVATION',
    );
    assert.equal(
      displayed.properties.evidenceMode.getValue(), 'STORED_WORLD_MEMORY',
    );
    assert.equal(
      displayed.properties.sourceUrl.getValue(), sourceUrl,
    );
    assert.equal(
      displayed.properties.timestampObserved.getValue(), observedAt,
    );
    assert.equal(
      displayed.properties.timestampReceived.getValue(),
      '2026-10-04T00:00:12.000Z',
    );
    assert.match(ui.overlays.at(-1)[0].title, /PERSISTED OBS/);
    assert.equal(displayed.properties.presentationClass.getValue(), 'PERSISTED_OBSERVATION');
    const analyst = ui.layer.getAnalystRecords();
    assert.equal(analyst.length, 1);
    assert.equal(analyst[0].evidence.source_url, sourceUrl);
    assert.equal(analyst[0].evidence.kind, 'OBSERVATION');
    assert.equal(analyst[0].evidence.stale, false);
    assert.ok(analyst[0].evidence.observation_id);
    assert.notEqual(
      analyst[0].evidence.timestamp_received,
      analyst[0].evidence.timestamp_observed,
    );
  } finally {
    ui.layer.destroy(ui.viewer);
  }
});

test('latest fetch outage retains stored evidence as DEGRADED, old observations appear STALE', async () => {
  clock.value = new Date('2026-10-04T00:00:12.000Z');
  const { repository, ingestor, world } = prepare();
  const good = createUsgsEarthquakesAdapter({
    now: () => clock.value,
    fetchImpl: async () => ({ ok: true, json: async () => feed() }),
  });
  assert.equal((await ingestor.ingest(good)).inserted, 1);
  // Distinct completion timestamps are required for latest-run ordering.
  clock.value = new Date('2026-10-04T00:00:13.000Z');
  const bad = createUsgsEarthquakesAdapter({
    now: () => clock.value,
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  assert.equal((await ingestor.ingest(bad)).status, 'DEGRADED');
  clock.value = new Date('2026-10-04T00:31:12.000Z');
  // New query engine and UI source reconstruct the reader after a restart.
  const restarted = createWorldMemoryEarthquakeSource({
    world: createWorldMemoryQueryEngine({
      repository, now: () => clock.value,
    }),
    now: () => clock.value,
  });
  const rows = await restarted.getSnapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].evidence.stale, true);
  assert.equal(rows[0].evidence.degraded, true);
  const ui = harness(restarted);
  try {
    assert.equal(await ui.layer.update(ui.viewer), true);
    assert.equal(ui.layer.getStats().status, 'degraded');
    assert.match(ui.overlays.at(-1)[0].title, /STALE REF/);
    assert.equal(ui.layer.getStats().stale, true);
    assert.equal(repository.observationCount(), 1);
  } finally {
    ui.layer.destroy(ui.viewer);
  }
  assert.ok(world);
});

test('timeouts do not erase last persisted real-format observations', async () => {
  clock.value = new Date('2026-10-04T00:00:12.000Z');
  const { repository, ingestor, source } = prepare();
  const good = createUsgsEarthquakesAdapter({
    now: () => clock.value,
    fetchImpl: async () => ({ ok: true, json: async () => feed() }),
  });
  await ingestor.ingest(good);
  clock.value = new Date('2026-10-04T00:00:13.000Z');
  const timeout = createUsgsEarthquakesAdapter({
    now: () => clock.value,
    timeoutMs: 10,
    fetchImpl: async (_url, { signal }) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener('abort', () => reject(
          Object.assign(new Error('timeout'), { name: 'AbortError' })
        ), { once: true })
      ),
  });
  const result = await ingestor.ingest(timeout);
  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.error.name, 'TimeoutError');
  assert.equal(repository.observationCount(), 1);
  assert.equal((await source.getSnapshot()).length, 1);
  assert.equal(source.getEvidenceStatus().provider_state, 'FAILED');
});

test('invalid WGS84, time reversal, spoofed provider and truncated query fail closed', async () => {
  clock.value = new Date('2026-10-04T00:00:12.000Z');
  const { ingestor, world } = prepare();
  const adapter = createUsgsEarthquakesAdapter({
    now: () => clock.value,
    fetchImpl: async () => ({ ok: true, json: async () => feed() }),
  });
  assert.equal((await ingestor.ingest(adapter)).inserted, 1);
  const snapshot = await world.query({
    provider_ids: ['usgs-earthquakes-all-hour'], type: 'earthquake',
    observation_type: 'earthquake-event', time_basis: 'observed', limit: 100,
  });
  const raw = snapshot.states[0];
  for (const change of [
    { geometry: { type: 'Point', coordinates: [200, 37] } },
    { timestamp_received: '2026-10-03T23:00:00.000Z' },
    { provider_id: 'spoof' },
    { source_url: 'https://untrusted.example/data' },
  ]) {
    const broken = { ...raw, ...change };
    const bridge = createWorldMemoryEarthquakeSource({
      world: { query: async () => ({ ...snapshot, states: [broken] }) },
      now: () => clock.value,
    });
    await assert.rejects(bridge.getSnapshot(), /World Memory/);
  }
  const truncated = createWorldMemoryEarthquakeSource({
    world: {
      query: async () => ({
        ...snapshot, candidate_truncated: true,
      }),
    },
    now: () => clock.value,
  });
  await assert.rejects(truncated.getSnapshot(), /Incomplete/);
});

test('invalid readback retains provenance but demotes old map markers to stale reference', async () => {
  clock.value = new Date('2026-10-04T00:00:12.000Z');
  const { ingestor, world } = prepare();
  await ingestor.ingest(createUsgsEarthquakesAdapter({
    now: () => clock.value,
    fetchImpl: async () => ({ ok: true, json: async () => feed() }),
  }));
  let fail = false;
  const bridge = createWorldMemoryEarthquakeSource({
    world: {
      ...world,
      query: async (...args) =>
        fail
          ? { mode: 'snapshot', states: [{}] }
          : world.query(...args),
    },
    now: () => clock.value,
  });
  const ui = harness(bridge);
  try {
    assert.equal(await ui.layer.update(ui.viewer), true);
    const oldEntries = ui.overlays.length;
    fail = true;
    assert.equal(await ui.layer.update(ui.viewer), false);
    assert.equal(ui.overlays.length, oldEntries + 1);
    assert.match(ui.overlays.at(-1)[0].title, /STALE REF/);
    assert.equal(
      ui.dataSources[0].entities.values[0].properties.presentationClass.getValue(),
      'STALE_REFERENCE',
    );
    assert.equal(ui.layer.getStats().count, 1);
    assert.match(ui.layer.getStats().error, /lineage/);
  } finally {
    ui.layer.destroy(ui.viewer);
  }
});

test('G5 refresh failure demotes displayed persisted evidence to stale reference; recovery restores classification', async () => {
  clock.value = new Date('2026-10-04T00:00:12.000Z');
  const { ingestor, source } = prepare();
  await ingestor.ingest(createUsgsEarthquakesAdapter({
    now: () => clock.value,
    fetchImpl: async () => ({ ok: true, json: async () => feed() }),
  }));
  let offline = false;
  const unreliableSource = {
    getEvidenceStatus: () => source.getEvidenceStatus(),
    getSnapshot(options) {
      if (offline) throw new Error('simulated PostGIS disconnect');
      return source.getSnapshot(options);
    },
  };
  const ui = harness(unreliableSource);
  try {
    assert.equal(await ui.layer.update(ui.viewer), true);
    let entity = ui.dataSources[0].entities.getById('earthquake:' + eventId);
    assert.equal(entity.properties.presentationClass.getValue(), 'PERSISTED_OBSERVATION');
    assert.match(ui.overlays.at(-1)[0].title, /PERSISTED OBS/);

    offline = true;
    assert.equal(await ui.layer.update(ui.viewer), false);
    entity = ui.dataSources[0].entities.getById('earthquake:' + eventId);
    assert.ok(entity, 'last persisted location remains available for reference');
    assert.equal(entity.properties.presentationClass.getValue(), 'STALE_REFERENCE');
    assert.equal(entity.properties.refreshFailedReference.getValue(), true);
    assert.match(ui.overlays.at(-1)[0].title, /STALE REF/);
    assert.match(ui.layer.getRowControls().info, /STALE REFERENCE/);
    assert.equal(ui.layer.getStats().stale, true);
    assert.equal(ui.layer.getStats().status, 'degraded');
    assert.equal(ui.layer.getStats().source, 'CACHED · STALE REFERENCE');
    const analyst = ui.layer.getAnalystRecords()[0];
    assert.equal(analyst.presentation_class, 'STALE_REFERENCE');
    assert.equal(analyst.refresh_failed_reference, true);
    assert.equal(analyst.evidence.source_url, sourceUrl);

    offline = false;
    assert.equal(await ui.layer.update(ui.viewer), true);
    entity = ui.dataSources[0].entities.getById('earthquake:' + eventId);
    assert.equal(entity.properties.presentationClass.getValue(), 'PERSISTED_OBSERVATION');
    assert.equal(entity.properties.refreshFailedReference.getValue(), false);
    assert.match(ui.overlays.at(-1)[0].title, /PERSISTED OBS/);
    assert.equal(ui.layer.getStats().status, 'nominal');
    assert.equal(ui.layer.getStats().stale, false);
  } finally {
    ui.layer.destroy(ui.viewer);
  }
});

test('G5 direct-feed mode explicitly labels observations and cached-failure references', async () => {
  let broken = false;
  const source = {
    async getSnapshot() {
      if (broken) throw new Error('USGS HTTP 503');
      return [{
        stableId: 'direct-example',
        usgsId: 'direct-example',
        lon: 127.1,
        lat: 37.5,
        depthKm: 4,
        mag: 4.1,
        place: 'Fixture - not a live observation',
        time: 1_780_531_200_000,
      }];
    },
  };
  const ui = harness(source);
  try {
    assert.equal(await ui.layer.update(ui.viewer), true);
    assert.match(ui.overlays.at(-1)[0].title, /DIRECT OBS/);
    assert.equal(
      ui.dataSources[0].entities.values[0].properties.presentationClass.getValue(),
      'DIRECT_OBSERVATION',
    );
    assert.match(ui.layer.getRowControls().info, /DIRECT OBSERVATION/);
    broken = true;
    assert.equal(await ui.layer.update(ui.viewer), false);
    assert.match(ui.overlays.at(-1)[0].title, /STALE REF/);
    assert.equal(
      ui.dataSources[0].entities.values[0].properties.presentationClass.getValue(),
      'STALE_REFERENCE',
    );
  } finally {
    ui.layer.destroy(ui.viewer);
  }
});
