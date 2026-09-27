-- ARGUS World Memory v1 — canonical PostgreSQL/PostGIS schema
-- Micro-stage 4C / 집중 실행 1회차
-- Source of truth for persistent world-state evidence. GPT Brain memory is separate.

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SCHEMA IF NOT EXISTS argus_world;

CREATE TABLE argus_world.providers (
  provider_id text PRIMARY KEY,
  category text NOT NULL,
  geography text,
  auth_mode text,
  cost_class text,
  update_frequency text,
  latency_class text,
  coverage text,
  license_class text NOT NULL,
  commercial_allowed boolean,
  attribution_required boolean NOT NULL DEFAULT false,
  retention_policy text,
  reliability text,
  adapter_status text,
  source_url text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE argus_world.ingestion_runs (
  ingestion_run_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL
    REFERENCES argus_world.providers(provider_id),
  started_at timestamptz NOT NULL,
  completed_at timestamptz,
  status text NOT NULL
    CHECK (status IN ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  request_scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_time jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_filters jsonb NOT NULL DEFAULT '{}'::jsonb,
  records_received integer CHECK (records_received IS NULL OR records_received >= 0),
  records_accepted integer CHECK (records_accepted IS NULL OR records_accepted >= 0),
  records_rejected integer CHECK (records_rejected IS NULL OR records_rejected >= 0),
  error_class text,
  error_message text,
  trace_id text,
  runtime_version text,
  adapter_version text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (completed_at IS NULL OR completed_at >= started_at)
);

CREATE TABLE argus_world.source_artifacts (
  source_artifact_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL
    REFERENCES argus_world.providers(provider_id),
  ingestion_run_id uuid
    REFERENCES argus_world.ingestion_runs(ingestion_run_id),
  artifact_type text NOT NULL,
  source_url text,
  observed_at timestamptz,
  retrieved_at timestamptz NOT NULL,
  content_hash text,
  storage_ref text,
  media_type text,
  byte_size bigint CHECK (byte_size IS NULL OR byte_size >= 0),
  license_class text,
  commercial_allowed boolean,
  attribution_required boolean,
  retention_policy text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE argus_world.entities (
  entity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  canonical_name text,
  status text NOT NULL DEFAULT 'ACTIVE',
  geometry geometry(Geometry, 4326),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence double precision
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE argus_world.entity_external_ids (
  entity_external_id_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL
    REFERENCES argus_world.entities(entity_id),
  namespace text NOT NULL,
  external_id text NOT NULL,
  provider_id text
    REFERENCES argus_world.providers(provider_id),
  confidence double precision
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  valid_from timestamptz,
  valid_to timestamptz,
  source_observation_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE UNIQUE INDEX entity_external_ids_provider_uidx
  ON argus_world.entity_external_ids (
    namespace,
    external_id,
    provider_id
  )
  WHERE provider_id IS NOT NULL;

CREATE UNIQUE INDEX entity_external_ids_global_uidx
  ON argus_world.entity_external_ids (
    namespace,
    external_id
  )
  WHERE provider_id IS NULL;

CREATE TABLE argus_world.entity_aliases (
  entity_alias_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_id uuid NOT NULL
    REFERENCES argus_world.entities(entity_id),
  alias text NOT NULL,
  alias_type text,
  language text,
  confidence double precision
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source_observation_id uuid,
  valid_from timestamptz,
  valid_to timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE argus_world.entity_relations (
  relation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_entity_id uuid NOT NULL
    REFERENCES argus_world.entities(entity_id),
  relation_type text NOT NULL,
  object_entity_id uuid NOT NULL
    REFERENCES argus_world.entities(entity_id),
  confidence double precision
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  valid_from timestamptz,
  valid_to timestamptz,
  source_observation_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE argus_world.observations (
  observation_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id text NOT NULL
    REFERENCES argus_world.providers(provider_id),
  provider_entity_id text NOT NULL,
  entity_type text NOT NULL,
  canonical_entity_id uuid
    REFERENCES argus_world.entities(entity_id),
  observation_type text NOT NULL,
  observed_at timestamptz NOT NULL,
  effective_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  geometry geometry(Geometry, 4326),
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  freshness_seconds bigint
    CHECK (freshness_seconds IS NULL OR freshness_seconds >= 0),
  coverage text,
  confidence double precision
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  license_class text NOT NULL,
  commercial_allowed boolean,
  attribution_required boolean NOT NULL DEFAULT false,
  retention_policy text,
  source_url text,
  rate_limit_class text,
  ingestion_run_id uuid NOT NULL
    REFERENCES argus_world.ingestion_runs(ingestion_run_id),
  source_artifact_id uuid
    REFERENCES argus_world.source_artifacts(source_artifact_id),
  supersedes_observation_id uuid
    REFERENCES argus_world.observations(observation_id),
  content_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (supersedes_observation_id IS NULL OR supersedes_observation_id <> observation_id)
);

ALTER TABLE argus_world.entity_external_ids
  ADD CONSTRAINT entity_external_ids_source_observation_fk
  FOREIGN KEY (source_observation_id)
  REFERENCES argus_world.observations(observation_id);

ALTER TABLE argus_world.entity_aliases
  ADD CONSTRAINT entity_aliases_source_observation_fk
  FOREIGN KEY (source_observation_id)
  REFERENCES argus_world.observations(observation_id);

CREATE TABLE argus_world.observation_retractions (
  retraction_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  observation_id uuid NOT NULL
    REFERENCES argus_world.observations(observation_id),
  reason_code text NOT NULL,
  reason text,
  source_artifact_id uuid
    REFERENCES argus_world.source_artifacts(source_artifact_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  actor_type text NOT NULL,
  actor_id text
);

CREATE TABLE argus_world.events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type text NOT NULL,
  event_version integer NOT NULL CHECK (event_version > 0),
  status text NOT NULL,
  started_at timestamptz,
  last_observed_at timestamptz,
  detected_at timestamptz NOT NULL,
  ended_at timestamptz,
  geometry geometry(Geometry, 4326),
  severity text,
  confidence double precision
    CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  detector_id text,
  detector_version text,
  fusion_method text,
  correlation_key text,
  dedup_key text,
  properties jsonb NOT NULL DEFAULT '{}'::jsonb,
  supersedes_event_id uuid
    REFERENCES argus_world.events(event_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);

CREATE TABLE argus_world.event_observations (
  event_id uuid NOT NULL
    REFERENCES argus_world.events(event_id),
  observation_id uuid NOT NULL
    REFERENCES argus_world.observations(observation_id),
  evidence_role text,
  weight double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, observation_id)
);

CREATE TABLE argus_world.event_entities (
  event_id uuid NOT NULL
    REFERENCES argus_world.events(event_id),
  entity_id uuid NOT NULL
    REFERENCES argus_world.entities(entity_id),
  relation_role text NOT NULL DEFAULT 'RELATED',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, entity_id, relation_role)
);

CREATE TABLE argus_world.lineage_edges (
  lineage_edge_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_type text NOT NULL,
  from_id uuid NOT NULL,
  to_type text NOT NULL,
  to_id uuid NOT NULL,
  edge_type text NOT NULL
    CHECK (
      edge_type IN (
        'INGESTED_FROM',
        'NORMALIZED_FROM',
        'DERIVED_FROM',
        'SUPERSEDES',
        'RESOLVED_TO',
        'FUSED_INTO'
      )
    ),
  process_id text,
  process_version text,
  ingestion_run_id uuid
    REFERENCES argus_world.ingestion_runs(ingestion_run_id),
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE OR REPLACE FUNCTION argus_world.prevent_observation_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'ARGUS observations are immutable; insert a superseding observation instead';
END;
$$;

CREATE TRIGGER observations_immutable_update
BEFORE UPDATE ON argus_world.observations
FOR EACH ROW
EXECUTE FUNCTION argus_world.prevent_observation_update();

CREATE INDEX observations_provider_time_idx
  ON argus_world.observations (provider_id, observed_at DESC);

CREATE INDEX observations_external_entity_time_idx
  ON argus_world.observations (
    entity_type,
    provider_entity_id,
    observed_at DESC
  );

CREATE INDEX observations_canonical_entity_time_idx
  ON argus_world.observations (canonical_entity_id, observed_at DESC)
  WHERE canonical_entity_id IS NOT NULL;

CREATE INDEX observations_geometry_gix
  ON argus_world.observations USING gist (geometry);

CREATE INDEX observations_ingestion_run_idx
  ON argus_world.observations (ingestion_run_id);

CREATE INDEX observations_source_artifact_idx
  ON argus_world.observations (source_artifact_id)
  WHERE source_artifact_id IS NOT NULL;

CREATE INDEX observations_supersedes_idx
  ON argus_world.observations (supersedes_observation_id)
  WHERE supersedes_observation_id IS NOT NULL;

CREATE INDEX observations_effective_time_idx
  ON argus_world.observations (effective_at DESC);

CREATE INDEX entities_type_idx
  ON argus_world.entities (entity_type);

CREATE INDEX entities_geometry_gix
  ON argus_world.entities USING gist (geometry);

CREATE INDEX entities_properties_gin
  ON argus_world.entities USING gin (properties);

CREATE INDEX events_type_time_idx
  ON argus_world.events (event_type, detected_at DESC);

CREATE INDEX events_status_time_idx
  ON argus_world.events (status, detected_at DESC);

CREATE INDEX events_geometry_gix
  ON argus_world.events USING gist (geometry);

CREATE INDEX events_correlation_key_idx
  ON argus_world.events (correlation_key)
  WHERE correlation_key IS NOT NULL;

CREATE INDEX events_dedup_key_idx
  ON argus_world.events (dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX lineage_from_idx
  ON argus_world.lineage_edges (from_type, from_id);

CREATE INDEX lineage_to_idx
  ON argus_world.lineage_edges (to_type, to_id);

COMMIT;
