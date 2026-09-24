# ADR — ARGUS World Memory v1 Schema Contract

Status: ACCEPTED FOR IMPLEMENTATION
Date: 2026-09-25
Scope: Micro-stage 4A only — schema/semantics contract. No database migration is introduced by this ADR.

## Decision

ARGUS World Memory will use PostgreSQL + PostGIS as the canonical persistent evidence store.

The first implementation keeps four classes of state distinct:

1. Evidence — normalized observations and their source artifacts.
2. Identity / Knowledge — canonical entities, aliases, external identifiers and relations.
3. Derived Intelligence — events and later forecasts/scenarios.
4. Operational lineage — ingestion runs and source-to-derived lineage.

GPT Brain personal/project memory is not stored in this schema. It remains a separate memory system connected only through explicit interfaces.

## Core invariants

### Evidence is append-first

Observation rows are immutable after acceptance except for governance-required hard deletion.

A correction creates a new observation row with supersedes_observation_id.

A source retraction creates an append-only observation_retractions record. The original evidence is not silently rewritten.

### Observation time is dual

Every observation stores:
- observed_at — when the real-world state was observed.
- received_at — when ARGUS received/accepted it.

Queries must not substitute one for the other.

### Provider identity and canonical identity are separate

Provider-normalized records keep provider_id, entity_type and provider_entity_id.

Canonical entity resolution is optional and later attaches canonical_entity_id.

A provider identifier is never silently promoted into a global entity identifier.

### Provenance survives every transformation

Every persisted observation must resolve back to an ingestion run and, when available, a source artifact.

Derived events/knowledge retain explicit lineage to the observations they used.

### Actual, predicted and simulated state are separate

World Memory v1 stores actual normalized observations and derived events.

Forecasts and simulation outputs use separate tables/contracts and must never be inserted into observations as if they were measured facts.

## Namespace

Initial PostgreSQL schema name: argus_world.

Application code must not rely on the default public schema for World Memory tables.

## Table set

### 1. providers

Persistent mirror of provider governance metadata.

Fields:
- provider_id text primary key
- category text not null
- geography text
- auth_mode text
- cost_class text
- update_frequency text
- latency_class text
- coverage text
- license_class text not null
- commercial_allowed boolean
- attribution_required boolean
- retention_policy text
- reliability text
- adapter_status text
- source_url text
- metadata jsonb not null default empty object
- first_seen_at timestamptz not null
- last_verified_at timestamptz
- updated_at timestamptz not null

The runtime Provider Registry remains the application-facing contract. This table is its auditable persistent mirror.

### 2. ingestion_runs

One row per provider ingestion attempt.

Fields:
- ingestion_run_id uuid primary key
- provider_id text not null references providers(provider_id)
- started_at timestamptz not null
- completed_at timestamptz
- status text not null
- request_scope jsonb not null default empty object
- request_time jsonb not null default empty object
- request_filters jsonb not null default empty object
- records_received integer
- records_accepted integer
- records_rejected integer
- error_class text
- error_message text
- trace_id text
- runtime_version text
- adapter_version text
- metadata jsonb not null default empty object

Initial status vocabulary: RUNNING, SUCCEEDED, PARTIAL, FAILED, CANCELLED.

### 3. source_artifacts

References to raw or externally stored source material.

Fields:
- source_artifact_id uuid primary key
- provider_id text not null references providers(provider_id)
- ingestion_run_id uuid references ingestion_runs(ingestion_run_id)
- artifact_type text not null
- source_url text
- observed_at timestamptz
- retrieved_at timestamptz not null
- content_hash text
- storage_ref text
- media_type text
- byte_size bigint
- license_class text
- commercial_allowed boolean
- attribution_required boolean
- retention_policy text
- metadata jsonb not null default empty object

Raw binary payloads do not need to live inside PostgreSQL. storage_ref may point to approved object/file storage.

### 4. entities

Canonical world entities only.

Fields:
- entity_id uuid primary key
- entity_type text not null
- canonical_name text
- status text not null default ACTIVE
- geometry geometry(Geometry, 4326)
- properties jsonb not null default empty object
- confidence double precision
- valid_from timestamptz
- valid_to timestamptz
- created_at timestamptz not null
- updated_at timestamptz not null

Confidence here represents identity-resolution confidence, not factual confidence of every observation.

### 5. entity_external_ids

Provider or authoritative identifiers attached to canonical entities.

Fields:
- entity_external_id_id uuid primary key
- entity_id uuid not null references entities(entity_id)
- namespace text not null
- external_id text not null
- provider_id text references providers(provider_id)
- confidence double precision
- valid_from timestamptz
- valid_to timestamptz
- source_observation_id uuid
- created_at timestamptz not null

Required uniqueness target: namespace + external_id + provider_id.

No probabilistic resolver may overwrite an existing authoritative identifier without an explicit resolution decision.

### 6. entity_aliases

Fields:
- entity_alias_id uuid primary key
- entity_id uuid not null references entities(entity_id)
- alias text not null
- alias_type text
- language text
- confidence double precision
- source_observation_id uuid
- valid_from timestamptz
- valid_to timestamptz
- created_at timestamptz not null

### 7. entity_relations

Knowledge-graph-compatible relation table.

Fields:
- relation_id uuid primary key
- subject_entity_id uuid not null references entities(entity_id)
- relation_type text not null
- object_entity_id uuid not null references entities(entity_id)
- confidence double precision
- valid_from timestamptz
- valid_to timestamptz
- source_observation_ids uuid[] not null default empty array
- properties jsonb not null default empty object
- created_at timestamptz not null

This relational representation is canonical before any Apache AGE or external graph accelerator is introduced.

### 8. observations

Canonical normalized evidence table.

Fields:
- observation_id uuid primary key
- provider_id text not null references providers(provider_id)
- provider_entity_id text not null
- entity_type text not null
- canonical_entity_id uuid references entities(entity_id)
- observation_type text not null
- observed_at timestamptz not null
- received_at timestamptz not null
- geometry geometry(Geometry, 4326)
- properties jsonb not null default empty object
- freshness_seconds bigint
- coverage text
- confidence double precision
- license_class text not null
- commercial_allowed boolean
- attribution_required boolean
- retention_policy text
- source_url text
- rate_limit_class text
- ingestion_run_id uuid not null references ingestion_runs(ingestion_run_id)
- source_artifact_id uuid references source_artifacts(source_artifact_id)
- supersedes_observation_id uuid references observations(observation_id)
- content_hash text
- created_at timestamptz not null

The normalized Observation Envelope maps to this table without losing provider identity, observed/received timestamps, geometry, properties, freshness, confidence, license/retention metadata or ingestion lineage.

### 9. observation_retractions

Append-only control record for source corrections, legal/governance retractions, or invalid evidence.

Fields:
- retraction_id uuid primary key
- observation_id uuid not null references observations(observation_id)
- reason_code text not null
- reason text
- source_artifact_id uuid references source_artifacts(source_artifact_id)
- created_at timestamptz not null
- actor_type text not null
- actor_id text

Normal queries exclude retracted observations by default but may expose them in audit/history modes.

### 10. events

Derived event records from Stage 4 semantics.

Fields:
- event_id uuid primary key
- event_type text not null
- event_version integer not null
- status text not null
- started_at timestamptz
- last_observed_at timestamptz
- detected_at timestamptz not null
- ended_at timestamptz
- geometry geometry(Geometry, 4326)
- severity text
- confidence double precision
- detector_id text
- detector_version text
- fusion_method text
- correlation_key text
- dedup_key text
- properties jsonb not null default empty object
- supersedes_event_id uuid references events(event_id)
- created_at timestamptz not null

Events are derived intelligence, not raw evidence.

### 11. event_observations

Many-to-many evidence link.

Fields:
- event_id uuid not null references events(event_id)
- observation_id uuid not null references observations(observation_id)
- evidence_role text
- weight double precision
- created_at timestamptz not null
- primary key event_id + observation_id

### 12. event_entities

Fields:
- event_id uuid not null references events(event_id)
- entity_id uuid not null references entities(entity_id)
- relation_role text
- created_at timestamptz not null
- primary key event_id + entity_id + relation_role

### 13. lineage_edges

Generic derivation lineage.

Fields:
- lineage_edge_id uuid primary key
- from_type text not null
- from_id uuid not null
- to_type text not null
- to_id uuid not null
- edge_type text not null
- process_id text
- process_version text
- ingestion_run_id uuid references ingestion_runs(ingestion_run_id)
- created_at timestamptz not null
- metadata jsonb not null default empty object

Initial edge types: INGESTED_FROM, NORMALIZED_FROM, DERIVED_FROM, SUPERSEDES, RESOLVED_TO, FUSED_INTO.

## Index contract

Micro-stage 4C chooses exact DDL, but the schema must support these query paths.

Observations logical indexes:
- provider_id + observed_at desc
- entity_type + provider_entity_id + observed_at desc
- canonical_entity_id + observed_at desc
- GIST geometry
- ingestion_run_id
- source_artifact_id
- supersedes_observation_id

An H3 cell may be added as a generated/materialized/indexed acceleration column only after benchmark evidence. It is not the spatial source of truth; PostGIS geometry remains authoritative.

Entities logical indexes:
- entity_type
- GIST geometry
- GIN properties

Events logical indexes:
- event_type + detected_at desc
- status + detected_at desc
- GIST geometry
- correlation_key
- dedup_key

## H3 decision

The newly added H3 wrapper is an acceleration primitive, not the canonical geometry model.

world.nearby currently uses:
1. provider bbox prefilter where supported
2. exact Haversine distance

This remains correct for the current in-memory/provider path.

H3 acceleration is deferred until a persistent/indexed World Memory query path exists. At that point it must be benchmarked against PostGIS spatial indexes and must preserve exact result equivalence.

This avoids introducing an in-memory H3 conversion layer that may cost more than the exact predicate it replaces.

## Partitioning decision

World Memory v1 starts unpartitioned.

Reason:
- personal-scale expected volume is initially modest
- PostgreSQL partitioning complicates unique keys and foreign-key design
- there is no measured bottleneck yet

Partitioning becomes a migration candidate only after measured evidence such as sustained write/query degradation or observation volume that justifies it.

Likely future partition key: observed_at.

The application repository contract must not expose assumptions that prevent later partitioning.

## Retention and deletion

Provider retention/license policy is data, not documentation only.

Each observation/source artifact carries its applicable retention and commercial-use metadata.

Normal lifecycle:
ACTIVE evidence → optional SUPERSEDED evidence → optional RETRACTED control record.

Governance-required hard deletion is a separate exceptional workflow and must create an audit record plus downstream lineage invalidation work.

## Transaction boundaries

One provider ingestion run may contain many source artifacts and observations.

Minimum transaction rule for 4B/4C:
- ingestion run creation may commit before provider work begins
- accepted observation batches and their lineage should commit atomically
- ingestion run completion status is updated only after batch outcome is known
- one malformed record must not roll back unrelated valid records unless the adapter contract explicitly chooses all-or-nothing behavior

## Initial query contracts enabled by this schema

4B/4D will target:
- world.history()
- repository.getEntityHistory()
- repository.queryObservations()
- repository.queryNearby()
- repository.getIngestionRun()

Existing world.query(), world.entity(), world.nearby() and world.compare() must remain usable without PostgreSQL so deterministic/unit tests do not require a live database.

## Explicit non-goals for v1

Not included in this schema stage:
- GPT Brain personal memory
- vector embeddings as source-of-truth data
- forecast tables
- scenario/simulation tables
- agent run tables
- alert/watch-rule tables
- Kafka/NATS persistence
- Apache AGE graph schema
- MobilityDB trajectory types
- Timescale-specific features
- automatic entity merges

Those are later capabilities behind evidence-driven gates.

## Next micro-stage

4B — World Memory Repository Contract.

Implement a database-independent repository interface and in-memory reference implementation first, with deterministic tests.

Only after that contract is green should 4C introduce PostgreSQL/PostGIS migration SQL.
