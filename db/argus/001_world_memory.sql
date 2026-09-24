-- ARGUS World Memory v0
-- Canonical evidence store target: PostgreSQL + PostGIS.
-- This schema is intentionally separate from GPT Brain personal/project memory.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE SCHEMA IF NOT EXISTS argus;

CREATE TABLE IF NOT EXISTS argus.providers (
  provider_id text PRIMARY KEY,
  category text NOT NULL,
  geography text NOT NULL,
  license_class text NOT NULL,
  commercial_allowed boolean,
  attribution_required boolean NOT NULL DEFAULT false,
  retention_policy text NOT NULL,
  source_url text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS argus.ingestion_runs (
  ingestion_run_id text PRIMARY KEY,
  provider_id text REFERENCES argus.providers(provider_id),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text NOT NULL,
  error text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS argus.source_artifacts (
  source_artifact_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text REFERENCES argus.providers(provider_id),
  ingestion_run_id text REFERENCES argus.ingestion_runs(ingestion_run_id),
  source_url text NOT NULL,
  raw_reference text,
  content_type text,
  observed_at timestamptz,
  received_at timestamptz NOT NULL,
  checksum text,
  storage_reference text,
  license_class text NOT NULL,
  retention_policy text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS argus.entities (
  entity_pk bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type text NOT NULL,
  canonical_key text UNIQUE,
  display_name text,
  geometry geometry(Geometry, 4326),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS argus.entity_aliases (
  provider_id text NOT NULL REFERENCES argus.providers(provider_id),
  entity_type text NOT NULL,
  external_entity_id text NOT NULL,
  entity_pk bigint REFERENCES argus.entities(entity_pk),
  confidence double precision CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  valid_from timestamptz,
  valid_to timestamptz,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (provider_id, entity_type, external_entity_id)
);

CREATE TABLE IF NOT EXISTS argus.entity_relations (
  relation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_entity_pk bigint NOT NULL REFERENCES argus.entities(entity_pk),
  target_entity_pk bigint NOT NULL REFERENCES argus.entities(entity_pk),
  relation_type text NOT NULL,
  confidence double precision CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  valid_from timestamptz,
  valid_to timestamptz,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (
    source_entity_pk,
    target_entity_pk,
    relation_type,
    valid_from
  )
);

CREATE TABLE IF NOT EXISTS argus.observations (
  observation_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id text NOT NULL REFERENCES argus.providers(provider_id),
  entity_pk bigint REFERENCES argus.entities(entity_pk),
  entity_type text NOT NULL,
  external_entity_id text NOT NULL,
  observation_type text NOT NULL,
  timestamp_observed timestamptz NOT NULL,
  timestamp_received timestamptz NOT NULL,
  geometry geometry(Geometry, 4326),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  freshness_seconds double precision NOT NULL CHECK (freshness_seconds >= 0),
  coverage text,
  confidence double precision CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  source_url text NOT NULL,
  license_class text NOT NULL,
  commercial_allowed boolean,
  attribution_required boolean NOT NULL DEFAULT false,
  retention_policy text NOT NULL,
  rate_limit_class text NOT NULL,
  ingestion_run_id text REFERENCES argus.ingestion_runs(ingestion_run_id),
  raw_reference text,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS observations_geometry_gix
  ON argus.observations USING gist (geometry);
CREATE INDEX IF NOT EXISTS observations_entity_history_idx
  ON argus.observations (
    entity_type,
    external_entity_id,
    timestamp_observed DESC
  );
CREATE INDEX IF NOT EXISTS observations_provider_time_idx
  ON argus.observations (provider_id, timestamp_observed DESC);
CREATE INDEX IF NOT EXISTS observations_observed_brin
  ON argus.observations USING brin (timestamp_observed);

CREATE TABLE IF NOT EXISTS argus.events (
  event_id text PRIMARY KEY,
  event_type text NOT NULL,
  event_version integer NOT NULL DEFAULT 1 CHECK (event_version > 0),
  status text NOT NULL,
  started_at timestamptz,
  last_observed_at timestamptz,
  detected_at timestamptz NOT NULL,
  ended_at timestamptz,
  geometry geometry(Geometry, 4326),
  severity text,
  confidence double precision CHECK (
    confidence IS NULL OR (confidence >= 0 AND confidence <= 1)
  ),
  detector_id text,
  detector_version text,
  fusion_method text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  supersedes_event_id text REFERENCES argus.events(event_id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS events_geometry_gix
  ON argus.events USING gist (geometry);
CREATE INDEX IF NOT EXISTS events_time_idx
  ON argus.events (detected_at DESC);

CREATE TABLE IF NOT EXISTS argus.event_entities (
  event_id text NOT NULL REFERENCES argus.events(event_id),
  entity_pk bigint NOT NULL REFERENCES argus.entities(entity_pk),
  role text,
  PRIMARY KEY (event_id, entity_pk)
);

CREATE TABLE IF NOT EXISTS argus.lineage_edges (
  lineage_edge_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_kind text NOT NULL,
  source_id text NOT NULL,
  target_kind text NOT NULL,
  target_id text NOT NULL,
  relation_type text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lineage_source_idx
  ON argus.lineage_edges (source_kind, source_id);
CREATE INDEX IF NOT EXISTS lineage_target_idx
  ON argus.lineage_edges (target_kind, target_id);

COMMIT;
