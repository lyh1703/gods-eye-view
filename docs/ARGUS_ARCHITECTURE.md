# ARGUS architecture

ARGUS extends God's Eye View without turning upstream visualization code into a project-specific monolith.

## Boundary

- **Upstream UI/Core** — globe, scene, controls, layer lifecycle, and visual rendering stay as close to upstream as practical.
- **World Data** — provider adapters normalize external observations into one envelope.
- **World Memory** — later persists normalized spatial/time-series observations and derived events.
- **Intelligence** — comparison, anomaly detection, event fusion, change detection, and prediction remain independent from rendering.
- **External Senses** — read-only interface used by the Personal GPT Brain. Personal memory and World Memory stay separate.
- **Project Bridge** — validated outputs can be consumed by other projects without giving ARGUS their action permissions.

## Phase 0 contract

The first stable contract is deliberately small:

1. provider registry
2. observation envelope
3. keyless provider adapter
4. `world.query()` aggregation
5. unit tests

History, anomaly detection, watch conditions, persistence, and project bridges are later gates.

## Observation envelope

Every normalized observation should preserve both event time and ingestion time:

- `provider_id`
- `entity_type`
- `entity_id`
- `observation_type`
- `timestamp_observed`
- `timestamp_received`
- `geometry`
- `properties`
- `freshness_seconds`
- `coverage`
- `confidence`
- `source_url`
- `license_class`
- `commercial_allowed`
- `attribution_required`
- `retention_policy`
- `rate_limit_class`
- `ingestion_run_id`
- `raw_reference`

The separation of observed and received time is mandatory so downstream code can reason about latency and stale data instead of treating every layer as equally live.

## Provider licensing gate

Provider metadata is data, not prose. Each adapter records authentication mode, cost class, update cadence, latency, coverage, license class, commercial-use status, attribution expectations, retention rules, reliability, and adapter status.

A provider can be technically usable and still be excluded from a commercial-safe path.

## First provider

The Phase 0 reference adapter uses the keyless USGS GeoJSON earthquake summary feed. USGS-produced information is generally U.S. public-domain material; ARGUS still records source and attribution metadata and must not assume that unrelated third-party material appearing on USGS properties has the same status.

## Upstream strategy

- `main` remains the upstream-sync baseline.
- `argus/main` is the ARGUS integration branch.
- experimental work should prefer `research/*` or `automation/*` branches.
- ARGUS-specific code lives under `src/argus/` unless an upstream interface must be changed.
- upstream changes are merged/rebased deliberately; ARGUS should avoid editing upstream files until an integration point is actually needed.

Pinned upstream baseline for this foundation commit:

`ce671ce500a393be27e3cbb2a08799fbca9b6e28`
