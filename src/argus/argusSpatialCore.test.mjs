import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  aggregateObservationsByH3Cell,
  createObservationEnvelope,
  geometryBbox,
  geometryBboxesIntersect,
  geometryDistanceKm,
  geometryPointInPolygon,
  h3CellBoundary,
  h3CellNeighbors,
  pointToH3Cell,
  polygonToH3Cells,
} from './index.js';

function observation(entityId, coordinates) {
  return createObservationEnvelope({
    provider_id: 'spatial-test',
    entity_type: 'asset',
    entity_id: entityId,
    observation_type: 'position',
    timestamp_observed: '2026-09-24T00:00:00Z',
    timestamp_received: '2026-09-24T00:00:00Z',
    geometry: { type: 'Point', coordinates },
    properties: {},
    source_url: `https://example.test/${entityId}`,
    license_class: 'test',
    commercial_allowed: false,
    attribution_required: false,
    retention_policy: 'test-only',
    rate_limit_class: 'test',
    ingestion_run_id: 'spatial-test',
  });
}

test('H3 wrapper indexes points and returns a GeoJSON boundary', () => {
  const cell = pointToH3Cell([-122.0553238, 37.3615593], 7);
  assert.match(cell, /^[0-9a-f]+$/);

  const boundary = h3CellBoundary(cell);
  assert.equal(boundary.type, 'Polygon');
  assert.equal(boundary.coordinates[0].length >= 6, true);

  const neighbors = h3CellNeighbors(cell);
  assert.equal(neighbors.includes(cell), false);
  assert.equal(neighbors.length > 0, true);
});

test('H3 wrapper converts polygons and aggregates point observations', () => {
  const polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [-122.06, 37.35],
        [-122.04, 37.35],
        [-122.04, 37.37],
        [-122.06, 37.37],
        [-122.06, 37.35],
      ],
    ],
  };

  assert.equal(polygonToH3Cells(polygon, 8).length > 0, true);

  const groups = aggregateObservationsByH3Cell(
    [
      observation('asset-1', [-122.0553, 37.3615]),
      observation('asset-2', [-122.0554, 37.3616]),
      observation('asset-3', [-121.9, 37.4]),
    ],
    { resolution: 8 },
  );

  assert.equal(
    groups.reduce((sum, group) => sum + group.count, 0),
    3,
  );
  assert.equal(
    groups.some((group) => group.count >= 2),
    true,
  );
});

test('geometry wrapper provides distance, bbox and polygon predicates', () => {
  const polygon = {
    type: 'Polygon',
    coordinates: [
      [
        [126.8, 37.4],
        [127.0, 37.4],
        [127.0, 37.6],
        [126.8, 37.6],
        [126.8, 37.4],
      ],
      [
        [126.89, 37.49],
        [126.91, 37.49],
        [126.91, 37.51],
        [126.89, 37.51],
        [126.89, 37.49],
      ],
    ],
  };

  assert.deepEqual(geometryBbox(polygon), [126.8, 37.4, 127, 37.6]);
  assert.equal(geometryPointInPolygon([126.85, 37.45], polygon), true);
  assert.equal(geometryPointInPolygon([126.9, 37.5], polygon), false);
  assert.equal(geometryPointInPolygon([127.2, 37.5], polygon), false);
  assert.equal(
    geometryBboxesIntersect(
      [126.8, 37.4, 127, 37.6],
      [126.9, 37.5, 127.1, 37.7],
    ),
    true,
  );
  assert.equal(geometryDistanceKm([126.9, 37.5], [126.9, 37.51]) > 1, true);
});
