-- ARGUS World Memory v1 migration gate
-- Fails with an exception if canonical geometry/time/provenance/supersession
-- behavior is not actually persisted in PostgreSQL/PostGIS.

\set ON_ERROR_STOP on

DO $$
DECLARE
  table_count integer;
BEGIN
  SELECT count(*)
    INTO table_count
  FROM information_schema.tables
  WHERE table_schema = 'argus_world'
    AND table_name = ANY (
      ARRAY[
        'providers',
        'ingestion_runs',
        'source_artifacts',
        'entities',
        'entity_external_ids',
        'entity_aliases',
        'entity_relations',
        'observations',
        'observation_retractions',
        'events',
        'event_observations',
        'event_entities',
        'lineage_edges'
      ]
    );

  IF table_count <> 13 THEN
    RAISE EXCEPTION 'expected 13 ARGUS World Memory tables, found %', table_count;
  END IF;
END;
$$;

INSERT INTO argus_world.providers (
  provider_id,
  category,
  geography,
  auth_mode,
  cost_class,
  update_frequency,
  latency_class,
  coverage,
  license_class,
  commercial_allowed,
  attribution_required,
  retention_policy,
  reliability,
  adapter_status,
  source_url,
  last_verified_at
) VALUES (
  'gate-usgs',
  'natural-hazards',
  'global',
  'keyless',
  'free',
  'near-real-time',
  'minutes',
  'global',
  'us-government-public-domain',
  true,
  true,
  'gate-test',
  'authoritative-government-source',
  'validated',
  'https://earthquake.usgs.gov/',
  '2026-09-28T00:00:00Z'
);

INSERT INTO argus_world.ingestion_runs (
  ingestion_run_id,
  provider_id,
  started_at,
  completed_at,
  status,
  request_scope,
  records_received,
  records_accepted,
  records_rejected,
  trace_id,
  runtime_version,
  adapter_version
) VALUES (
  '00000000-0000-4000-8000-000000000001',
  'gate-usgs',
  '2026-09-28T00:00:00Z',
  '2026-09-28T00:00:02Z',
  'SUCCEEDED',
  '{"bbox":[126.0,37.0,128.0,38.0]}'::jsonb,
  2,
  2,
  0,
  'gate-trace-1',
  'gate',
  'gate'
);

INSERT INTO argus_world.source_artifacts (
  source_artifact_id,
  provider_id,
  ingestion_run_id,
  artifact_type,
  source_url,
  observed_at,
  retrieved_at,
  content_hash,
  storage_ref,
  media_type,
  byte_size,
  license_class,
  commercial_allowed,
  attribution_required,
  retention_policy,
  metadata
) VALUES (
  '00000000-0000-4000-8000-000000000010',
  'gate-usgs',
  '00000000-0000-4000-8000-000000000001',
  'geojson',
  'https://example.test/usgs.geojson',
  '2026-09-28T00:00:00Z',
  '2026-09-28T00:00:01Z',
  'sha256:gate',
  'gate://raw/usgs',
  'application/geo+json',
  128,
  'us-government-public-domain',
  true,
  true,
  'gate-test',
  '{"fixture":true}'::jsonb
);

INSERT INTO argus_world.entities (
  entity_id,
  entity_type,
  canonical_name,
  status,
  geometry,
  properties,
  confidence,
  valid_from,
  valid_to
) VALUES
(
  '00000000-0000-4000-8000-000000000100',
  'earthquake',
  'Gate Earthquake',
  'ACTIVE',
  ST_SetSRID(ST_MakePoint(127.1, 37.5), 4326),
  '{"gate":true}'::jsonb,
  0.99,
  '2026-09-28T00:00:00Z',
  NULL
),
(
  '00000000-0000-4000-8000-000000000101',
  'region',
  'Gate Region',
  'ACTIVE',
  ST_SetSRID(ST_MakePoint(127.0, 37.4), 4326),
  '{}'::jsonb,
  1.0,
  '2026-09-28T00:00:00Z',
  NULL
);

INSERT INTO argus_world.observations (
  observation_id,
  provider_id,
  provider_entity_id,
  entity_type,
  canonical_entity_id,
  observation_type,
  observed_at,
  effective_at,
  received_at,
  ingested_at,
  geometry,
  properties,
  freshness_seconds,
  coverage,
  confidence,
  license_class,
  commercial_allowed,
  attribution_required,
  retention_policy,
  source_url,
  rate_limit_class,
  ingestion_run_id,
  source_artifact_id,
  supersedes_observation_id,
  content_hash
) VALUES
(
  '00000000-0000-4000-8000-000000001000',
  'gate-usgs',
  'gate-quake-1',
  'earthquake',
  '00000000-0000-4000-8000-000000000100',
  'state',
  '2026-09-28T00:00:00Z',
  '2026-09-28T00:00:00Z',
  '2026-09-28T00:00:01Z',
  '2026-09-28T00:00:02Z',
  ST_SetSRID(ST_MakePoint(127.1, 37.5), 4326),
  '{"magnitude":2.5,"revision":1}'::jsonb,
  1,
  'global',
  0.90,
  'us-government-public-domain',
  true,
  true,
  'gate-test',
  'https://example.test/quake/1',
  'gate',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000010',
  NULL,
  'sha256:obs1'
),
(
  '00000000-0000-4000-8000-000000001001',
  'gate-usgs',
  'gate-quake-1',
  'earthquake',
  '00000000-0000-4000-8000-000000000100',
  'state',
  '2026-09-28T00:01:00Z',
  '2026-09-28T00:01:00Z',
  '2026-09-28T00:01:01Z',
  '2026-09-28T00:01:02Z',
  ST_SetSRID(ST_MakePoint(127.1005, 37.5005), 4326),
  '{"magnitude":2.6,"revision":2}'::jsonb,
  1,
  'global',
  0.99,
  'us-government-public-domain',
  true,
  true,
  'gate-test',
  'https://example.test/quake/1',
  'gate',
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000010',
  '00000000-0000-4000-8000-000000001000',
  'sha256:obs2'
);

INSERT INTO argus_world.entity_external_ids (
  entity_external_id_id,
  entity_id,
  namespace,
  external_id,
  provider_id,
  confidence,
  valid_from,
  source_observation_id
) VALUES (
  '00000000-0000-4000-8000-000000002000',
  '00000000-0000-4000-8000-000000000100',
  'usgs-event',
  'gate-quake-1',
  'gate-usgs',
  1.0,
  '2026-09-28T00:00:00Z',
  '00000000-0000-4000-8000-000000001000'
);

INSERT INTO argus_world.entity_relations (
  relation_id,
  subject_entity_id,
  relation_type,
  object_entity_id,
  confidence,
  valid_from,
  source_observation_ids,
  properties
) VALUES (
  '00000000-0000-4000-8000-000000003000',
  '00000000-0000-4000-8000-000000000100',
  'LOCATED_IN',
  '00000000-0000-4000-8000-000000000101',
  0.99,
  '2026-09-28T00:00:00Z',
  ARRAY['00000000-0000-4000-8000-000000001000'::uuid],
  '{"gate":true}'::jsonb
);

INSERT INTO argus_world.events (
  event_id,
  event_type,
  event_version,
  status,
  started_at,
  last_observed_at,
  detected_at,
  geometry,
  severity,
  confidence,
  detector_id,
  detector_version,
  fusion_method,
  correlation_key,
  dedup_key,
  properties
) VALUES (
  '00000000-0000-4000-8000-000000004000',
  'earthquake-observed',
  1,
  'ACTIVE',
  '2026-09-28T00:00:00Z',
  '2026-09-28T00:01:00Z',
  '2026-09-28T00:01:02Z',
  ST_SetSRID(ST_MakePoint(127.1005, 37.5005), 4326),
  'LOW',
  0.99,
  'gate-detector',
  '1',
  'single-provider-gate',
  'gate-quake-1',
  'gate-quake-1-v2',
  '{"gate":true}'::jsonb
);

INSERT INTO argus_world.event_observations (
  event_id,
  observation_id,
  evidence_role,
  weight
) VALUES (
  '00000000-0000-4000-8000-000000004000',
  '00000000-0000-4000-8000-000000001001',
  'PRIMARY',
  1.0
);

INSERT INTO argus_world.event_entities (
  event_id,
  entity_id,
  relation_role
) VALUES (
  '00000000-0000-4000-8000-000000004000',
  '00000000-0000-4000-8000-000000000100',
  'SUBJECT'
);

INSERT INTO argus_world.lineage_edges (
  lineage_edge_id,
  from_type,
  from_id,
  to_type,
  to_id,
  edge_type,
  process_id,
  process_version,
  ingestion_run_id,
  metadata
) VALUES (
  '00000000-0000-4000-8000-000000005000',
  'source_artifact',
  '00000000-0000-4000-8000-000000000010',
  'observation',
  '00000000-0000-4000-8000-000000001000',
  'NORMALIZED_FROM',
  'gate-normalizer',
  '1',
  '00000000-0000-4000-8000-000000000001',
  '{"gate":true}'::jsonb
);

DO $$
DECLARE
  srid integer;
  x double precision;
  y double precision;
  observed timestamptz;
  effective timestamptz;
  ingested timestamptz;
  provenance_count integer;
  superseded uuid;
BEGIN
  SELECT
    ST_SRID(geometry),
    ST_X(geometry),
    ST_Y(geometry),
    observed_at,
    effective_at,
    ingested_at,
    supersedes_observation_id
  INTO
    srid,
    x,
    y,
    observed,
    effective,
    ingested,
    superseded
  FROM argus_world.observations
  WHERE observation_id = '00000000-0000-4000-8000-000000001001';

  IF srid <> 4326 THEN
    RAISE EXCEPTION 'geometry SRID gate failed: %', srid;
  END IF;

  IF abs(x - 127.1005) > 0.000001 OR abs(y - 37.5005) > 0.000001 THEN
    RAISE EXCEPTION 'geometry coordinate gate failed: %, %', x, y;
  END IF;

  IF observed <> '2026-09-28T00:01:00Z'::timestamptz
     OR effective <> '2026-09-28T00:01:00Z'::timestamptz
     OR ingested <> '2026-09-28T00:01:02Z'::timestamptz THEN
    RAISE EXCEPTION 'temporal gate failed';
  END IF;

  IF superseded <> '00000000-0000-4000-8000-000000001000'::uuid THEN
    RAISE EXCEPTION 'supersession gate failed: %', superseded;
  END IF;

  SELECT count(*)
  INTO provenance_count
  FROM argus_world.observations o
  JOIN argus_world.ingestion_runs r
    ON r.ingestion_run_id = o.ingestion_run_id
  JOIN argus_world.source_artifacts s
    ON s.source_artifact_id = o.source_artifact_id
  WHERE o.observation_id = '00000000-0000-4000-8000-000000001001'
    AND r.provider_id = 'gate-usgs'
    AND s.provider_id = 'gate-usgs';

  IF provenance_count <> 1 THEN
    RAISE EXCEPTION 'provenance gate failed';
  END IF;
END;
$$;

DO $$
DECLARE
  blocked boolean := false;
BEGIN
  BEGIN
    UPDATE argus_world.observations
    SET properties = '{"mutation":"forbidden"}'::jsonb
    WHERE observation_id = '00000000-0000-4000-8000-000000001000';
  EXCEPTION
    WHEN OTHERS THEN
      IF SQLERRM LIKE 'ARGUS observations are immutable%' THEN
        blocked := true;
      ELSE
        RAISE;
      END IF;
  END;

  IF NOT blocked THEN
    RAISE EXCEPTION 'immutable observation gate failed';
  END IF;
END;
$$;

SELECT
  count(*) AS observations,
  count(*) FILTER (WHERE supersedes_observation_id IS NOT NULL) AS supersessions,
  count(*) FILTER (WHERE geometry IS NOT NULL) AS spatial_observations
FROM argus_world.observations;
