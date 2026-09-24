import {
  haversineDistanceKm,
  normalizeWorldPoint,
} from '../worldOperations.js';

function collectCoordinatePairs(value, output) {
  if (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(Number(value[0])) &&
    Number.isFinite(Number(value[1]))
  ) {
    output.push([Number(value[0]), Number(value[1])]);
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) collectCoordinatePairs(child, output);
  }
}

function pointOnSegment(point, left, right, epsilon = 1e-12) {
  const [x, y] = point;
  const [x1, y1] = left;
  const [x2, y2] = right;
  const deltaX = x2 - x1;
  const deltaY = y2 - y1;
  const squaredLength = deltaX ** 2 + deltaY ** 2;
  if (squaredLength <= epsilon) {
    return Math.abs(x - x1) <= epsilon && Math.abs(y - y1) <= epsilon;
  }

  const cross = (y - y1) * deltaX - (x - x1) * deltaY;
  if (Math.abs(cross) > epsilon) return false;

  const dot = (x - x1) * deltaX + (y - y1) * deltaY;
  if (dot < -epsilon) return false;
  return dot <= squaredLength + epsilon;
}

function pointInRing(point, ring) {
  let inside = false;

  for (
    let index = 0, previous = ring.length - 1;
    index < ring.length;
    previous = index++
  ) {
    const left = ring[previous];
    const right = ring[index];
    if (pointOnSegment(point, left, right)) return true;

    const [x, y] = point;
    const [x1, y1] = left;
    const [x2, y2] = right;
    const intersects =
      y1 > y !== y2 > y && x < ((x2 - x1) * (y - y1)) / (y2 - y1) + x1;
    if (intersects) inside = !inside;
  }

  return inside;
}

export function geometryDistanceKm(left, right) {
  return haversineDistanceKm(
    normalizeWorldPoint(left),
    normalizeWorldPoint(right),
  );
}

export function geometryBbox(geometry) {
  if (!geometry || typeof geometry !== 'object') {
    throw new TypeError('geometry must be a GeoJSON-like object');
  }

  const coordinates = [];
  collectCoordinatePairs(geometry.coordinates, coordinates);
  if (coordinates.length === 0) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [longitude, latitude] of coordinates) {
    west = Math.min(west, longitude);
    south = Math.min(south, latitude);
    east = Math.max(east, longitude);
    north = Math.max(north, latitude);
  }

  return [west, south, east, north];
}

export function geometryPointInPolygon(point, polygon) {
  const normalizedPoint = normalizeWorldPoint(point);
  if (
    !polygon ||
    polygon.type !== 'Polygon' ||
    !Array.isArray(polygon.coordinates) ||
    polygon.coordinates.length === 0
  ) {
    throw new TypeError('polygon must be a GeoJSON Polygon');
  }

  const rings = polygon.coordinates;
  if (!pointInRing(normalizedPoint, rings[0])) return false;
  return !rings.slice(1).some((ring) => pointInRing(normalizedPoint, ring));
}

export function geometryBboxesIntersect(left, right) {
  if (
    !Array.isArray(left) ||
    left.length !== 4 ||
    !Array.isArray(right) ||
    right.length !== 4
  ) {
    throw new TypeError('bbox must be [west, south, east, north]');
  }

  return !(
    Number(left[2]) < Number(right[0]) ||
    Number(left[0]) > Number(right[2]) ||
    Number(left[3]) < Number(right[1]) ||
    Number(left[1]) > Number(right[3])
  );
}