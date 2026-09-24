# ARGUS World Memory ADR — v0

## Status

Accepted for implementation baseline.

## Decision

ARGUS World Memory uses a repository contract owned by ARGUS.

The production target is **PostgreSQL + PostGIS**, while deterministic tests use an in-memory implementation of the same contract.

World Memory is logically and physically separate from GPT Brain personal/project memory.

## Why

ARGUS needs an append-first evidence history with:

- observed time and received time preserved separately
- provider and license provenance
- spatial geometry
- provider-scoped external entity identity before entity resolution
- later canonical entity links
- replayable event and lineage paths

A database-specific API must not leak into `world.*` interfaces.

## Repository v0

Required methods:

- `appendObservations(observations, options)`
- `history(query)`

The first production PostGIS adapter must implement this contract.

## Query/write separation

`world.query()` remains a live/provider query.

It does **not** implicitly persist observations in v0.

The ingestion/Observation Bridge will explicitly call `appendObservations()`. This prevents a read API from silently becoming a write operation and keeps replay, authorization, retention, and cost behavior explicit.

`world.history()` reads World Memory and degrades cleanly when no memory backend is configured.

## Identity

Until Entity Resolution is implemented, history is queried using:

- `entity_type`
- external `entity_id`
- optional `provider_ids`

Provider identifiers are not automatically treated as globally canonical identities.

The PostGIS schema therefore stores provider-scoped aliases separately from future canonical entities.

## Data model

Initial tables:

- providers
- ingestion_runs
- source_artifacts
- entities
- entity_aliases
- entity_relations
- observations
- events
- event_entities
- lineage_edges

Observations are canonical evidence. Derived event, prediction, simulation, and AI outputs must not overwrite observation records.

## PostGIS

All persisted world geometry uses SRID 4326 at the canonical storage boundary.

Provider CRS conversion belongs in ingestion normalization before persistence.

## Versioning and corrections

v0 is append-first.

Future idempotency/revision work will add a stable source-specific observation key and explicit supersession semantics. It should not be approximated by destructive updates.

## GPT Brain boundary

ARGUS World Memory contains external/world state and derived world intelligence.

GPT Brain contains user/personal/project memory.

Cross-system use is through explicit External Senses/MCP/API interfaces, not shared tables or an implicit shared database.
