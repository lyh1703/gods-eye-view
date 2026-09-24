# ARGUS GitHub Capability Survey — Stage 1

## Scope

Stage 1 covers **Spatial / Rendering / Geospatial Core**.

The survey is a bounded exhaustive review for ARGUS-relevant capabilities, not a claim that every GitHub repository was enumerated.

Reviewed projects include:

- CesiumJS
- MapLibre GL JS
- deck.gl
- Kepler.gl
- H3 / h3-js
- Turf
- Proj4js
- RBush
- Supercluster
- PMTiles
- GeoTIFF.js
- GDAL
- GeoPandas
- Rasterio
- Shapely
- NASA 3DTilesRendererJS

## Current repository reality

ARGUS currently sits inside the God’s Eye View fork, whose runtime already depends heavily on Cesium:

- `package.json` includes `cesium`
- `src/app/viewer.js` creates `Cesium.Viewer`
- `src/maps/controller.js` manages Cesium imagery/tileset lifecycles
- `src/maps/google3d.js` manages Google Photorealistic 3D Tiles and Cesium ion fallback

Therefore Stage 1 does **not** recommend replacing the renderer now.

## Decisions

| Project | Decision | ARGUS role |
| --- | --- | --- |
| CesiumJS | KEEP / ADOPT EXISTING | Primary 3D renderer |
| h3-js | ADOPT P0 | Hierarchical spatial indexing / aggregation |
| Turf | ADOPT SELECTIVE P0/P1 | GeoJSON spatial operations |
| Proj4js | ADOPT SELECTIVE P1 | CRS normalization |
| RBush | ADOPT P1 | In-memory bbox spatial index |
| Supercluster | ADOPT CONDITIONAL P1 | High-density point visualization clustering |
| PMTiles | ADOPT P1/P2 | Static/offline/serverless tile archive |
| GeoTIFF.js | ADOPT P2 | Lightweight browser/Node raster reading |
| GDAL | ADOPT AS SERVICE/TOOL | Ingestion, conversion, reprojection |
| Rasterio | OPTIONAL PYTHON WORKER | Raster processing |
| Shapely | OPTIONAL PYTHON WORKER | Geometry processing |
| GeoPandas | REFERENCE / OPTIONAL WORKER | Geospatial analytics/ETL |
| MapLibre GL JS | REFERENCE P2 | Future lightweight 2D renderer |
| deck.gl | REFERENCE / POC P2 | Massive GPU analytical overlays |
| NASA 3DTilesRendererJS | REFERENCE P3 | Future non-Cesium 3D Tiles renderer |
| Kepler.gl | REJECT CORE / REFERENCE UX | Exploratory geospatial UX patterns |

## Immediate architecture direction

Near-term ARGUS spatial stack:

```text
Cesium
  + h3-js
  + selective Turf modules
  + Proj4js when a non-WGS84 provider requires it
  + RBush for ephemeral in-memory queries
  + Supercluster only for proven rendering bottlenecks
  + PMTiles for regional/offline/static tile distribution
```

Server-side / analysis path:

```text
GDAL -> ingestion / normalization worker
Rasterio + Shapely + GeoPandas -> optional Python analysis worker
GeoTIFF.js -> lightweight raster access in Node/browser
```

## P0 / P1 PoC backlog

### P0-A — H3 wrapper

Create an ARGUS-owned H3 API instead of spreading direct `h3-js` calls through the codebase.

Candidate operations:

- point to cell
- cell to boundary
- neighbor cells
- polygon to cells
- observation aggregation by cell

### P0-B — geometry wrapper

Use only required Turf modules behind an ARGUS-owned geometry interface.

First operations:

- distance
- bbox
- point-in-polygon
- spatial predicates required by `world.nearby` / `world.entity`

### P1-C — CRS adapter

Add a provider normalization boundary for source CRS -> canonical ARGUS CRS.

Proj4js is enabled only when a provider actually needs non-WGS84 transformation.

### P1-D — renderer capability contract

Do not perform a large renderer rewrite yet.

Define capability metadata first so a future MapLibre or Three/Babylon frontend can be added without redefining ARGUS core contracts.

### P1-E — PMTiles feasibility

Benchmark PMTiles for:

- regional offline packs
- static vector event layers
- low-cost object-storage distribution

Do not treat PMTiles as World Memory.

## Stage 1 result

**Stage 1 is complete.**

The highest-value next integration candidates are:

1. h3-js
2. selective Turf modules
3. Proj4js
4. RBush
5. PMTiles

Renderer replacement is intentionally deferred.

Next survey stage: **Spatiotemporal Storage / Entity / Knowledge**.
