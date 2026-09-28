import { validateObservationEnvelope } from '../observationEnvelope.js';
import { normalizeWorldPoint } from '../worldOperations.js';
import { validateWorldMemoryRepository } from './repository.js';

const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

function assertIdentifier(value, field) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(field + ' must be a safe PostgreSQL identifier');
  }
  return value;
}

function requireString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(field + ' must be a non-empty string');
  }
  return value;
}

function normalizeTimestamp(value, field, { required = false } = {}) {
  if (value == null) {
    if (required) throw new TypeError(field + ' is required');
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(field + ' must be a valid timestamp');
  }
  return date.toISOString();
}

function normalizeLimit(value, fallback = 100) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError('limit must be a non-negative finite number');
  }
  return Math.floor(number);
}

function normalizeOrder(value) {
  const order = value ?? 'desc';
  if (order !== 'asc' && order !== 'desc') {
    throw new TypeError("order must be 'asc' or 'desc'");
  }
  return order;
}

function normalizeTimeBasis(value) {
  const basis = value ?? 'observed';
  if (!['observed', 'effective', 'received', 'ingested'].includes(basis)) {
    throw new TypeError(
      "time_basis must be 'observed', 'effective', 'received', or 'ingested'",
    );
  }
  return basis;
}

function timeColumnFor(basis) {
  return {
    observed: 'o.observed_at',
    effective: 'o.effective_at',
    received: 'o.received_at',
    ingested: 'o.ingested_at',
  }[normalizeTimeBasis(basis)];
}

function normalizeBbox(bbox) {
  if (bbox == null) return null;
  if (!Array.isArray(bbox) || bbox.length !== 4) {
    throw new TypeError('bbox must be [west, south, east, north]');
  }
  const values = bbox.map(Number);
  if (values.some((value) => !Number.isFinite(value))) {
    throw new TypeError('bbox values must be finite numbers');
  }
  const [west, south, east, north] = values;
  if (
    west < -180 ||
    west > 180 ||
    east < -180 ||
    east > 180 ||
    south < -90 ||
    south > 90 ||
    north < -90 ||
    north > 90 ||
    west > east ||
    south > north
  ) {
    throw new RangeError('bbox must be a valid non-antimeridian WGS84 bbox');
  }
  return values;
}

function toIso(value) {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function mapObservationRow(row) {
  return {
    observation_id: row.observation_id,
    provider_id: row.provider_id,
    entity_type: row.entity_type,
    entity_id: row.provider_entity_id,
    provider_entity_id: row.provider_entity_id,
    canonical_entity_id: row.canonical_entity_id,
    observation_type: row.observation_type,
    timestamp_observed: toIso(row.observed_at),
    effective_at: toIso(row.effective_at),
    timestamp_received: toIso(row.received_at),
    ingested_at: toIso(row.ingested_at),
    geometry: row.geometry ?? null,
    properties: row.properties ?? {},
    freshness_seconds:
      row.freshness_seconds == null ? null : Number(row.freshness_seconds),
    coverage: row.coverage,
    confidence: row.confidence == null ? null : Number(row.confidence),
    license_class: row.license_class,
    commercial_allowed: row.commercial_allowed,
    attribution_required: row.attribution_required,
    retention_policy: row.retention_policy,
    source_url: row.source_url,
    rate_limit_class: row.rate_limit_class,
    ingestion_run_id: row.ingestion_run_id,
    source_artifact_id: row.source_artifact_id,
    supersedes_observation_id: row.supersedes_observation_id,
    content_hash: row.content_hash,
    canonical_entity_valid_from: toIso(row.canonical_entity_valid_from),
    canonical_entity_valid_to: toIso(row.canonical_entity_valid_to),
    raw_reference: row.source_artifact_id ?? null,
  };
}

function observationColumns() {
  return `
    o.observation_id::text,
    o.provider_id,
    o.provider_entity_id,
    o.entity_type,
    o.canonical_entity_id::text,
    o.observation_type,
    o.observed_at,
    o.effective_at,
    o.received_at,
    o.ingested_at,
    CASE
      WHEN o.geometry IS NULL THEN NULL
      ELSE ST_AsGeoJSON(o.geometry)::jsonb
    END AS geometry,
    o.properties,
    o.freshness_seconds,
    o.coverage,
    o.confidence,
    o.license_class,
    o.commercial_allowed,
    o.attribution_required,
    o.retention_policy,
    o.source_url,
    o.rate_limit_class,
    o.ingestion_run_id::text,
    o.source_artifact_id::text,
    o.supersedes_observation_id::text,
    o.content_hash,
    e.valid_from AS canonical_entity_valid_from,
    e.valid_to AS canonical_entity_valid_to
  `;
}

function observationSelect(schema) {
  return `
    SELECT
      ${observationColumns()}
    FROM ${schema}.observations o
    LEFT JOIN ${schema}.entities e
      ON e.entity_id = o.canonical_entity_id
  `;
}

function buildObservationQuery(
  schema,
  {
    provider_ids,
    entity_type = null,
    provider_entity_id = null,
    canonical_entity_id = null,
    observation_type = null,
    from = null,
    to = null,
    bbox = null,
    limit = 100,
    order = 'desc',
    time_basis = 'observed',
  } = {},
) {
  const params = [];
  const conditions = [
    `NOT EXISTS (
      SELECT 1
      FROM ${schema}.observation_retractions r
      WHERE r.observation_id = o.observation_id
    )`,
  ];

  const add = (value) => {
    params.push(value);
    return '$' + params.length;
  };

  if (provider_ids != null) {
    if (!Array.isArray(provider_ids)) {
      throw new TypeError('provider_ids must be an array when provided');
    }
    if (provider_ids.length > 0) {
      conditions.push(`o.provider_id = ANY(${add(provider_ids)}::text[])`);
    }
  }
  if (entity_type != null) {
    conditions.push(
      `o.entity_type = ${add(requireString(entity_type, 'entity_type'))}`,
    );
  }
  if (provider_entity_id != null) {
    conditions.push(
      `o.provider_entity_id = ${add(
        requireString(provider_entity_id, 'provider_entity_id'),
      )}`,
    );
  }
  if (canonical_entity_id != null) {
    conditions.push(
      `o.canonical_entity_id = ${add(
        requireString(canonical_entity_id, 'canonical_entity_id'),
      )}::uuid`,
    );
  }
  if (observation_type != null) {
    conditions.push(
      `o.observation_type = ${add(
        requireString(observation_type, 'observation_type'),
      )}`,
    );
  }

  const timeColumn = timeColumnFor(time_basis);
  const fromIso = normalizeTimestamp(from, 'from');
  const toIso = normalizeTimestamp(to, 'to');
  if (fromIso && toIso && Date.parse(fromIso) > Date.parse(toIso)) {
    throw new RangeError('from must not be after to');
  }
  if (fromIso) {
    conditions.push(`${timeColumn} >= ${add(fromIso)}::timestamptz`);
  }
  if (toIso) {
    conditions.push(`${timeColumn} <= ${add(toIso)}::timestamptz`);
  }

  const normalizedBbox = normalizeBbox(bbox);
  if (normalizedBbox) {
    const [west, south, east, north] = normalizedBbox;
    conditions.push(
      `o.geometry IS NOT NULL AND ST_Intersects(
        o.geometry,
        ST_MakeEnvelope(
          ${add(west)}::double precision,
          ${add(south)}::double precision,
          ${add(east)}::double precision,
          ${add(north)}::double precision,
          4326
        )
      )`,
    );
  }

  const normalizedOrder = normalizeOrder(order).toUpperCase();
  const normalizedLimit = normalizeLimit(limit);

  return {
    text: `
      ${observationSelect(schema)}
      WHERE ${conditions.join(' AND ')}
      ORDER BY ${timeColumn} ${normalizedOrder}, o.created_at ${normalizedOrder}
      LIMIT ${add(normalizedLimit)}::integer
    `,
    values: params,
  };
}

async function withTransaction(db, callback) {
  if (typeof db.connect !== 'function') {
    throw new TypeError(
      'Postgres World Memory requires a database pool with connect()',
    );
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  } finally {
    client.release?.();
  }
}

function validateObservationBatch(observations) {
  if (!Array.isArray(observations)) {
    throw new TypeError('observations must be an array');
  }

  return observations.map((observation) => {
    const result = validateObservationEnvelope(observation);
    if (!result.ok) {
      throw new TypeError(
        'invalid observation for World Memory: ' + result.errors.join('; '),
      );
    }
    return structuredClone(observation);
  });
}

function normalizeIngestionRun(run) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) {
    throw new TypeError('ingestion run must be an object');
  }

  const allowed = new Set([
    'RUNNING',
    'SUCCEEDED',
    'PARTIAL',
    'FAILED',
    'CANCELLED',
  ]);
  const status = requireString(run.status, 'status');
  if (!allowed.has(status)) {
    throw new RangeError('status is not a supported ingestion status');
  }

  const startedAt = normalizeTimestamp(run.started_at, 'started_at', {
    required: true,
  });
  const completedAt = normalizeTimestamp(run.completed_at, 'completed_at');
  if (completedAt && Date.parse(completedAt) < Date.parse(startedAt)) {
    throw new RangeError('completed_at must not be before started_at');
  }

  return {
    ...structuredClone(run),
    ingestion_run_id: requireString(run.ingestion_run_id, 'ingestion_run_id'),
    provider_id: requireString(run.provider_id, 'provider_id'),
    status,
    started_at: startedAt,
    completed_at: completedAt,
    request_scope: structuredClone(run.request_scope ?? {}),
    request_time: structuredClone(run.request_time ?? {}),
    request_filters: structuredClone(run.request_filters ?? {}),
    metadata: structuredClone(run.metadata ?? {}),
  };
}

export function createPostgresWorldMemoryRepository({
  db,
  schema = 'argus_world',
  now = () => new Date(),
} = {}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('db.query() is required');
  }
  const safeSchema = assertIdentifier(schema, 'schema');

  async function appendObservations(observations, { recorded_at } = {}) {
    const batch = validateObservationBatch(observations);
    if (batch.length === 0) {
      const count = await db.query(
        `SELECT count(*)::integer AS count FROM ${safeSchema}.observations`,
      );
      return {
        inserted: 0,
        total: count.rows[0].count,
        observation_ids: [],
      };
    }

    const ingestedAt = normalizeTimestamp(recorded_at ?? now(), 'recorded_at', {
      required: true,
    });

    return withTransaction(db, async (client) => {
      const observationIds = [];

      for (const observation of batch) {
        const values = [
          observation.observation_id ?? null,
          observation.provider_id,
          observation.entity_id,
          observation.entity_type,
          observation.canonical_entity_id ?? null,
          observation.observation_type,
          observation.timestamp_observed,
          observation.effective_at ?? observation.timestamp_observed,
          observation.timestamp_received,
          ingestedAt,
          observation.geometry == null
            ? null
            : JSON.stringify(observation.geometry),
          observation.properties ?? {},
          observation.freshness_seconds,
          observation.coverage,
          observation.confidence,
          observation.license_class,
          observation.commercial_allowed,
          observation.attribution_required,
          observation.retention_policy,
          observation.source_url,
          observation.rate_limit_class,
          observation.ingestion_run_id,
          observation.source_artifact_id ?? null,
          observation.supersedes_observation_id ?? null,
          observation.content_hash ?? null,
        ];

        const inserted = await client.query(
          `
            INSERT INTO ${safeSchema}.observations (
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
            ) VALUES (
              COALESCE($1::uuid, gen_random_uuid()),
              $2,
              $3,
              $4,
              $5::uuid,
              $6,
              $7::timestamptz,
              $8::timestamptz,
              $9::timestamptz,
              $10::timestamptz,
              CASE
                WHEN $11::text IS NULL THEN NULL
                ELSE ST_SetSRID(ST_GeomFromGeoJSON($11::text), 4326)
              END,
              $12::jsonb,
              $13::bigint,
              $14,
              $15::double precision,
              $16,
              $17::boolean,
              $18::boolean,
              $19,
              $20,
              $21,
              $22::uuid,
              $23::uuid,
              $24::uuid,
              $25
            )
            RETURNING observation_id::text
          `,
          values,
        );
        observationIds.push(inserted.rows[0].observation_id);
      }

      const count = await client.query(
        `SELECT count(*)::integer AS count FROM ${safeSchema}.observations`,
      );

      return {
        inserted: observationIds.length,
        total: count.rows[0].count,
        observation_ids: observationIds,
      };
    });
  }

  async function queryObservations(options = {}) {
    const query = buildObservationQuery(safeSchema, options);
    const result = await db.query(query.text, query.values);
    return result.rows.map(mapObservationRow);
  }

  async function getEntityHistory({
    entity_type,
    provider_entity_id,
    ...options
  } = {}) {
    return queryObservations({
      ...options,
      entity_type: requireString(entity_type, 'entity_type'),
      provider_entity_id: requireString(
        provider_entity_id,
        'provider_entity_id',
      ),
    });
  }

  async function queryNearby({
    center,
    radius_km = 5,
    provider_ids,
    entity_type = null,
    observation_type = null,
    from = null,
    to = null,
    limit = 100,
    time_basis = 'observed',
  } = {}) {
    const [longitude, latitude] = normalizeWorldPoint(center);
    const radiusKm = Number(radius_km);
    if (!Number.isFinite(radiusKm) || radiusKm < 0) {
      throw new TypeError('radius_km must be a non-negative finite number');
    }

    const base = buildObservationQuery(safeSchema, {
      provider_ids,
      entity_type,
      observation_type,
      from,
      to,
      limit: 2147483647,
      order: 'desc',
      time_basis,
    });

    const values = base.values.slice(0, -1);
    const add = (value) => {
      values.push(value);
      return '$' + values.length;
    };
    const point = `ST_SetSRID(
      ST_MakePoint(
        ${add(longitude)}::double precision,
        ${add(latitude)}::double precision
      ),
      4326
    )`;
    const radiusMeters = add(radiusKm * 1000);
    const resultLimit = add(normalizeLimit(limit));

    const whereMatch = base.text.match(/WHERE ([\s\S]*?)ORDER BY/);
    if (!whereMatch) throw new Error('failed to build nearby query');

    const result = await db.query(
      `
        SELECT
          ${observationColumns()},
          ST_Distance(o.geometry::geography, ${point}::geography) / 1000.0
            AS distance_km
        FROM ${safeSchema}.observations o
        LEFT JOIN ${safeSchema}.entities e
          ON e.entity_id = o.canonical_entity_id
        WHERE ${whereMatch[1]}
          AND o.geometry IS NOT NULL
          AND ST_DWithin(
            o.geometry::geography,
            ${point}::geography,
            ${radiusMeters}::double precision
          )
        ORDER BY distance_km ASC, o.observed_at DESC
        LIMIT ${resultLimit}::integer
      `,
      values,
    );

    return result.rows.map((row) => ({
      distance_km: Number(row.distance_km),
      observation: mapObservationRow(row),
    }));
  }

  async function saveIngestionRun(run) {
    const normalized = normalizeIngestionRun(run);
    const result = await db.query(
      `
        INSERT INTO ${safeSchema}.ingestion_runs (
          ingestion_run_id,
          provider_id,
          started_at,
          completed_at,
          status,
          request_scope,
          request_time,
          request_filters,
          records_received,
          records_accepted,
          records_rejected,
          error_class,
          error_message,
          trace_id,
          runtime_version,
          adapter_version,
          metadata
        ) VALUES (
          $1::uuid, $2, $3::timestamptz, $4::timestamptz, $5,
          $6::jsonb, $7::jsonb, $8::jsonb,
          $9::integer, $10::integer, $11::integer,
          $12, $13, $14, $15, $16, $17::jsonb
        )
        ON CONFLICT (ingestion_run_id) DO UPDATE SET
          completed_at = EXCLUDED.completed_at,
          status = EXCLUDED.status,
          records_received = EXCLUDED.records_received,
          records_accepted = EXCLUDED.records_accepted,
          records_rejected = EXCLUDED.records_rejected,
          error_class = EXCLUDED.error_class,
          error_message = EXCLUDED.error_message,
          trace_id = EXCLUDED.trace_id,
          runtime_version = EXCLUDED.runtime_version,
          adapter_version = EXCLUDED.adapter_version,
          metadata = EXCLUDED.metadata
        RETURNING *
      `,
      [
        normalized.ingestion_run_id,
        normalized.provider_id,
        normalized.started_at,
        normalized.completed_at,
        normalized.status,
        normalized.request_scope,
        normalized.request_time,
        normalized.request_filters,
        normalized.records_received ?? null,
        normalized.records_accepted ?? null,
        normalized.records_rejected ?? null,
        normalized.error_class ?? null,
        normalized.error_message ?? null,
        normalized.trace_id ?? null,
        normalized.runtime_version ?? null,
        normalized.adapter_version ?? null,
        normalized.metadata,
      ],
    );

    return mapIngestionRun(result.rows[0]);
  }

  async function getIngestionRun(ingestionRunId) {
    const id = requireString(ingestionRunId, 'ingestion_run_id');
    const result = await db.query(
      `
        SELECT *
        FROM ${safeSchema}.ingestion_runs
        WHERE ingestion_run_id = $1::uuid
      `,
      [id],
    );
    return result.rowCount === 0 ? null : mapIngestionRun(result.rows[0]);
  }

  const repository = {
    kind: 'postgres',
    appendObservations,
    queryObservations,
    getEntityHistory,
    queryNearby,
    saveIngestionRun,
    getIngestionRun,
  };

  return Object.freeze(validateWorldMemoryRepository(repository));
}

function mapIngestionRun(row) {
  return {
    ...row,
    ingestion_run_id: String(row.ingestion_run_id),
    started_at: toIso(row.started_at),
    completed_at: toIso(row.completed_at),
    records_received:
      row.records_received == null ? null : Number(row.records_received),
    records_accepted:
      row.records_accepted == null ? null : Number(row.records_accepted),
    records_rejected:
      row.records_rejected == null ? null : Number(row.records_rejected),
    request_scope: row.request_scope ?? {},
    request_time: row.request_time ?? {},
    request_filters: row.request_filters ?? {},
    metadata: row.metadata ?? {},
  };
}