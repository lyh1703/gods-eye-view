import assert from 'node:assert/strict';
import test from 'node:test';

import { createExternalProviderIngestor } from '../../argus/externalProviderIngest.js';
import { createPostgresWorldMemoryRepository } from '../../argus/memory/postgresRepository.js';
import { createWorldMemoryQueryEngine } from '../../argus/memory/worldMemoryQuery.js';
import { createUsgsEarthquakesAdapter } from '../../argus/providers/usgsEarthquakes.js';
import { createEarthquakesLayer } from './index.js';
import { createWorldMemoryEarthquakeSource } from './worldMemorySource.js';

const databaseUrl = process.env.ARGUS_POSTGRES_TEST_URL;

if (!databaseUrl) {
  test(
    'USGS public GET -> isolated PostGIS -> restarted World Memory -> Cesium UI requires ARGUS_POSTGRES_TEST_URL',
    { skip: true },
    () => {},
  );
} else {
  const { Pool } = await import('pg');

  test('live USGS ingest survives new DB connection and reaches Cesium renderer with source evidence', async () => {
    const writerPool = new Pool({ connectionString: databaseUrl });
    let result;
    let liveRows;
    try {
      const repository = createPostgresWorldMemoryRepository({
        db: writerPool,
      });
      const adapter = createUsgsEarthquakesAdapter({
        timeoutMs: 15000,
      });
      // Actual public USGS GET through the existing production adapter; no
      // simulated observations in this test.
      liveRows = await adapter.query({ limit: 60 });
      assert.ok(liveRows.length > 0, 'Live public USGS feed has no observations');
      const ingestor = createExternalProviderIngestor({
        repository,
        staleAfterSeconds: 3600,
      });
      const replay = {
        metadata: adapter.metadata,
        async query() { return liveRows; },
      };
      result = await ingestor.ingest(replay);
      assert.notEqual(result.status, 'DEGRADED');
      assert.ok(result.inserted + result.duplicates > 0);
      // Replay the exact official observations; retries and restarts must
      // not create another history record for identical public evidence.
      const duplicate = await ingestor.ingest(replay);
      assert.equal(duplicate.inserted, 0);
      assert.equal(duplicate.duplicates, liveRows.length);
      // Fault injection uses a copy of an ACTUAL public USGS envelope.
      // Fail closed before persistence on impossible WGS84 coordinates.
      const invalid = structuredClone(liveRows[0]);
      invalid.geometry.coordinates[0] = 181;
      const rejected = await ingestor.ingest({
        metadata: adapter.metadata,
        async query() { return [invalid]; },
      });
      assert.equal(rejected.status, 'DEGRADED');
      assert.equal(rejected.inserted, 0);
      // A later healthy public snapshot must clear the provider failure.
      const recovered = await ingestor.ingest(replay);
      assert.notEqual(recovered.status, 'DEGRADED');
      assert.equal(recovered.inserted, 0);
    } finally {
      await writerPool.end();
    }

    // A new independent connection + query engine exercises readback after
    // writer shutdown. This is NOT a production deployment/restart claim.
    let readerPool = new Pool({ connectionString: databaseUrl });
    try {
      let repository = createPostgresWorldMemoryRepository({
        db: readerPool,
      });
      let world = createWorldMemoryQueryEngine({ repository });
      // A reconnect creates a new repository/query engine but retains the
      // same source and Cesium layer instance, with no uncommitted mutations.
      const readSwitch = {
        query: (...args) => world.query(...args),
        repository: {
          getLatestIngestionRunForProvider: (...args) =>
            repository.getLatestIngestionRunForProvider(...args),
        },
      };
      const source = createWorldMemoryEarthquakeSource({
        world: readSwitch,
        staleAfterSeconds: 900,
      });
      const rows = await source.getSnapshot();
      assert.ok(Array.isArray(rows));
      assert.ok(rows.length > 0, 'Actual stored USGS rows must reach UI source');
      assert.equal(source.getEvidenceStatus().kind, 'OBSERVATION');
      assert.equal(source.getEvidenceStatus().source_mode, 'STORED_WORLD_MEMORY');

      const sources = [];
      const visible = [];
      const viewer = {
        dataSources: {
          add(ds) { sources.push(ds); },
          remove(ds) { sources.splice(sources.indexOf(ds), 1); },
        },
      };
      const layer = createEarthquakesLayer({
        source,
        overlayHost: {
          setVisible() {},
          clearSource() {},
          setEntries(_id, entries) { visible.push(entries); },
        },
      });
      layer.init(viewer);
      layer.enable(viewer);
      try {
        assert.equal(await layer.update(viewer), true);
        assert.equal(layer.getStats().count, rows.length);
        assert.match(layer.getStats().source, /PERSISTED OBSERVATION/);
        assert.match(layer.getRowControls().info, /World Memory/);

        const publicIds = new Set(liveRows.map((x) => x.entity_id));
        const readbackIds = new Set(rows.map((x) => x.usgsId));
        // A real response with an M2.5+ quake MUST yield a visible map entity
        // unless the time-windowed current snapshot superseded it. Conversely
        // M<2.5 does not become a fake map marker just to pass a test.
        const matched = rows.filter((x) => publicIds.has(x.usgsId));
        assert.ok(
          matched.length > 0,
          'Real public USGS event did not survive PostGIS to map readback',
        );
        {
          const sample = matched[0];
          assert.ok(readbackIds.has(sample.usgsId));
          const shown = sources[0].entities.getById(
            'earthquake:' + sample.stableId,
          );
          assert.ok(shown, 'Persisted real USGS observation not rendered');
          assert.equal(
            shown.properties.sourceUrl.getValue(),
            sample.evidence.source_url,
          );
          assert.equal(
            shown.properties.evidenceKind.getValue(), 'OBSERVATION',
          );
          assert.equal(
            shown.properties.evidenceMode.getValue(),
            'STORED_WORLD_MEMORY',
          );
          assert.equal(
            shown.properties.timestampObserved.getValue(),
            sample.evidence.timestamp_observed,
          );
          assert.match(
            visible.at(-1).find((x) => x.id === sample.stableId).title,
            /OBS/,
          );
        }
        for (const entity of sources[0].entities.values) {
          const mode = entity.properties.evidenceMode.getValue();
          assert.equal(mode, 'STORED_WORLD_MEMORY');
          assert.equal(entity.properties.evidenceKind.getValue(), 'OBSERVATION');
        }
        // Real PostGIS pool disconnect, not a mocked World Memory error.
        // On failure, the existing displayed USGS entities become explicitly
        // stale references until an independent connection reads them again.
        await readerPool.end();
        assert.equal(await layer.update(viewer), false);
        assert.equal(layer.getStats().status, 'degraded');
        assert.equal(layer.getStats().stale, true);
        assert.match(layer.getRowControls().info, /STALE REFERENCE/);
        const staleEntity = sources[0].entities.getById(
          'earthquake:' + matched[0].stableId,
        );
        assert.equal(
          staleEntity.properties.presentationClass.getValue(),
          'STALE_REFERENCE',
        );
        assert.match(
          visible.at(-1).find((x) => x.id === matched[0].stableId).title,
          /STALE REF/,
        );
        readerPool = new Pool({ connectionString: databaseUrl });
        repository = createPostgresWorldMemoryRepository({ db: readerPool });
        world = createWorldMemoryQueryEngine({ repository });
        assert.equal(await layer.update(viewer), true);
        assert.equal(layer.getStats().error, null);
        assert.equal(
          sources[0].entities.getById('earthquake:' + matched[0].stableId)
            .properties.presentationClass.getValue(),
          matched[0].evidence.stale ? 'STALE_REFERENCE' : 'PERSISTED_OBSERVATION',
        );
        console.log(JSON.stringify({
          path: 'official-USGS-GET>provider-envelope>G4-ingest>PostGIS>disconnect>reconnected-pool>WorldMemory>Cesium>overlay-and-analyst',
          mode: 'real-public-source-e2e',
          public_sample_count: liveRows.length,
          stored_ui_count: rows.length,
          public_ids_rendered: matched.length,
          sample_official_url: matched[0]?.evidence.source_url ?? null,
          example_observed_at: matched[0]?.evidence.timestamp_observed ?? null,
          example_received_at: matched[0]?.evidence.timestamp_received ?? null,
          inferred_event_identity: false,
          duplicate_replay_inserted: 0,
          invalid_wgs84_rejected: true,
          disconnected_pool_demoted_to_stale_reference: true,
          fresh_pool_readback_restored: true,
        }));
      } finally {
        layer.destroy(viewer);
      }
    } finally {
      await readerPool.end();
    }
  });
}
