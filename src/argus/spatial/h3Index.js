import {
  cellToBoundary,
  gridDisk,
  latLngToCell,
  polygonToCells as h3PolygonToCells,
} from 'h3-js';

import { pointCoordinates } from '../worldOperations.js';

export const DEFAULT_H3_RESOLUTION = 8;

export function validateH3Resolution(resolution) {
  const value = Number(resolution);
  if (!Number.isInteger(value) || value < 0 || value > 15) {
    throw new RangeError('H3 resolution must be an integer between 0 and 15');
  }
  return value;
}

function normalizePoint(point) {
  if (!Array.isArray(point) || point.length < 2) {
    throw new TypeError('point must be [longitude, latitude]');
  }
  const longitude = Number(point[0]);
  const latitude = Number(point[1]);
  if (
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90
  ) {
    throw new RangeError('point must contain valid longitude and latitude');
  }
  return [longitude, latitude];
}

export function pointToH3Cell(point, resolution = DEFAULT_H3_RESOLUTION) {
  const [longitude, latitude] = normalizePoint(point);
  return latLngToCell(latitude, longitude, validateH3Resolution(resolution));
}

export function h3CellBoundary(cell) {
  if (typeof cell !== 'string' || cell.trim() === '') {
    throw new TypeError('cell must be a non-empty H3 index');
  }

  return {
    type: 'Polygon',
    coordinates: [cellToBoundary(cell, true)],
  };
}

export function h3CellNeighbors(
  cell,
  { ringSize = 1, includeOrigin = false } = {},
) {
  const size = Number(ringSize);
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError('ringSize must be a non-negative integer');
  }

  const cells = gridDisk(cell, size);
  return includeOrigin
    ? cells
    : cells.filter((candidate) => candidate !== cell);
}

export function polygonToH3Cells(geometry, resolution = DEFAULT_H3_RESOLUTION) {
  if (
    !geometry ||
    geometry.type !== 'Polygon' ||
    !Array.isArray(geometry.coordinates)
  ) {
    throw new TypeError('geometry must be a GeoJSON Polygon');
  }

  return h3PolygonToCells(
    geometry.coordinates,
    validateH3Resolution(resolution),
    true,
  );
}

export function aggregateObservationsByH3Cell(
  observations,
  { resolution = DEFAULT_H3_RESOLUTION } = {},
) {
  const normalizedResolution = validateH3Resolution(resolution);
  const groups = new Map();

  for (const observation of observations ?? []) {
    const point = pointCoordinates(observation);
    if (!point) continue;

    const cell = pointToH3Cell(point, normalizedResolution);
    let group = groups.get(cell);
    if (!group) {
      group = {
        cell,
        resolution: normalizedResolution,
        count: 0,
        provider_ids: new Set(),
        entity_ids: new Set(),
        observations: [],
      };
      groups.set(cell, group);
    }

    group.count += 1;
    group.provider_ids.add(observation.provider_id);
    group.entity_ids.add(observation.entity_id);
    group.observations.push(observation);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      provider_ids: [...group.provider_ids].sort(),
      entity_ids: [...group.entity_ids].sort(),
    }))
    .sort((left, right) => left.cell.localeCompare(right.cell));
}
