# ARGUS GitHub Capability Survey — Stage 3

## Scope

Stage 3 covers **Earth Observation / Sensor / Mobility Data**.

Reviewed:
STAC, PySTAC Client, TiTiler, rio-tiler, rio-cogeo, odc-stac, EODAG, Sentinel Hub SDK, TorchGeo, SamGeo, ADS-B decoder stacks, AIS-catcher, Web RTL-SDR, SensorThings/FROST, Mosquitto, Node-RED, GTFS-Realtime, GTFS validator, GBFS, Open-Meteo, and the corresponding existing GEV layers.

## Current GEV assets already worth preserving

- NASA CMR-based HLS S30/L30 + VIIRS recent imagery catalog
- local ADS-B `aircraft.json` receiver path for dump1090/readsb/tar1090 and 978 UAT
- vessel ingestion with freshness/degraded transport state
- GTFS realtime transit ingestion
- GBFS shared-mobility ingestion
- `@jtarrio/webrtlsdr` WebUSB RTL-SDR support

Stage 3 therefore focuses on **normalizing and extending these senses**, not reimplementing them.

## Decisions

| Project / standard | Decision | ARGUS role |
| --- | --- | --- |
| STAC Specification | ADOPT P0 | Canonical EO discovery contract |
| PySTAC Client | ADOPT P1 worker | Python STAC query client |
| EODAG | POC P1/P2 | Multi-provider EO gateway |
| TiTiler | ADOPT P1/P2 | Dynamic COG/STAC/Zarr raster service |
| rio-tiler | ADOPT P1/P2 | Raster read/tile primitive |
| rio-cogeo | ADOPT P1/P2 | COG creation/validation |
| odc-stac | ADOPT P2 | STAC -> xarray/Dask EO analytics |
| stackstac | REFERENCE | Alternative STAC -> xarray path |
| Sentinel Hub Python SDK | OPTIONAL | Provider-specific adapter |
| TorchGeo | REFERENCE/POC P2/P3 | Geospatial ML datasets/models |
| SamGeo | POC P2/P3 | Remote-sensing segmentation |
| readsb / dump1090 | LOCAL SIDECAR | User-owned ADS-B decoder |
| AIS-catcher | OPTIONAL LOCAL SIDECAR | User-owned AIS SDR decoder |
| Web RTL-SDR | KEEP EXISTING | Browser-side SDR access |
| Mosquitto | ADOPT OPTIONAL P1/P2 | Local/edge MQTT sensor gateway |
| SensorThings / FROST | STANDARD REFERENCE / OPTIONAL | Sensor interoperability |
| Node-RED | REFERENCE | Edge/prototype flow tool |
| GTFS-Realtime | KEEP / NORMALIZE | Transit observation standard |
| GTFS Validator | QUALITY-GATE REFERENCE | Provider onboarding validation |
| GBFS | KEEP / NORMALIZE | Shared-mobility observations |
| Open-Meteo | REFERENCE | Multi-model weather design reference; not default commercial dependency |

## Architecture

```text
EO catalogs
  -> STAC discovery
  -> ARGUS Provider Registry
  -> optional EODAG
  -> COG / STAC assets
  -> TiTiler / rio-tiler
  -> odc-stac analysis
  -> optional EO ML
  -> ARGUS observations/events
  -> World Memory
```

```text
Local sensors
  ADS-B / AIS / IoT / SDR
  -> local sidecar or MQTT
  -> ARGUS Sensor Adapter
  -> Observation Envelope
  -> World Memory
```

## Important isolation rules

- GPL ADS-B/AIS decoders remain user-managed external processes.
- ARGUS consumes their normalized local outputs rather than copying decoder code into the application.
- Sensor brokers are transport, not canonical storage.
- EO ML outputs are derived evidence and must retain source imagery, model/version and confidence.
- Public transportation and infrastructure data must not be repurposed into private-person tracking.

## Immediate PoC backlog

1. STAC Item -> ARGUS EO asset normalization
2. read-only bridge from existing GEV recentImagery/localAdsb/vessels/transit/bikeshare to Observation Envelope
3. TiTiler/rio COG fixture benchmark
4. generic Sensor Adapter contract
5. authenticated local Mosquitto gateway PoC
6. existing ADS-B route -> ARGUS provider adapter
7. AIS-catcher sidecar feasibility
8. PySTAC/odc-stac EO time-series worker

## Stage 3 result

**Stage 3 survey is complete.**

Next survey stage: **Streaming / Detection / Event Fusion / Observability**.
