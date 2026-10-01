import { validateWorldMemoryRepository } from './memory/repository.js';

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  }
  return value;
}

async function contentHash(observation) {
  const payload = JSON.stringify(
    stableValue({
      observation_type: observation.observation_type,
      timestamp_observed: observation.timestamp_observed,
      geometry: observation.geometry ?? null,
      properties: observation.properties ?? {},
      source_url: observation.source_url,
    }),
  );
  const bytes = new TextEncoder().encode(payload);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function errorSummary(error) {
  return {
    name: error?.name ?? 'Error',
    message: error?.message ?? String(error),
    code: error?.code ?? null,
    retryable: error?.retryable === true,
  };
}

function isRetryableProviderError(error) {
  return (
    error?.retryable === true ||
    error?.name === 'AbortError' ||
    error?.name === 'TimeoutError'
  );
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function classifyObservationFreshness(
  observation,
  { now = new Date(), staleAfterSeconds = 900 } = {},
) {
  const observed = Date.parse(observation?.timestamp_observed ?? '');
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ageSeconds =
    Number.isFinite(observed) && Number.isFinite(nowMs)
      ? Math.max(0, (nowMs - observed) / 1000)
      : null;

  return {
    age_seconds: ageSeconds,
    stale:
      ageSeconds == null
        ? true
        : ageSeconds > Math.max(0, Number(staleAfterSeconds) || 0),
  };
}

export function createExternalProviderIngestor({
  repository,
  now = () => new Date(),
  uuid = () => globalThis.crypto.randomUUID(),
  staleAfterSeconds = 900,
  maxAttempts = 2,
  retryDelayMs = 0,
  sleep = defaultSleep,
} = {}) {
  const memory = validateWorldMemoryRepository(repository);
  const attemptLimit = Math.max(1, Math.floor(Number(maxAttempts) || 1));
  const retryDelay = Math.max(0, Number(retryDelayMs) || 0);

  async function ingest(adapter, query = {}) {
    if (
      !adapter?.metadata?.provider_id ||
      typeof adapter.query !== 'function'
    ) {
      throw new TypeError(
        'adapter metadata.provider_id and query() are required',
      );
    }

    const providerId = adapter.metadata.provider_id;
    const runId = uuid();
    const startedAt = now().toISOString();
    const baseRun = {
      ingestion_run_id: runId,
      provider_id: providerId,
      provider: structuredClone(adapter.metadata),
      status: 'RUNNING',
      started_at: startedAt,
      completed_at: null,
      records_seen: null,
      records_accepted: null,
      records_rejected: null,
      request_scope: query.scope ?? {},
      request_time: query.time ?? {},
      request_filters: query.filters ?? {},
      metadata: { source_url: adapter.metadata.source_url },
    };

    await memory.saveIngestionRun(baseRun);

    let observations;
    let attemptsUsed = 0;
    try {
      for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
        attemptsUsed = attempt;
        try {
          observations = await adapter.query({
            ...query,
            ingestionRunId: runId,
          });
          if (!Array.isArray(observations)) {
            throw new TypeError(
              'provider query must return an observation array',
            );
          }
          break;
        } catch (error) {
          if (attempt >= attemptLimit || !isRetryableProviderError(error)) {
            throw error;
          }
          if (retryDelay > 0) {
            await sleep(retryDelay);
          }
        }
      }
    } catch (error) {
      const completedAt = now().toISOString();
      await memory.saveIngestionRun({
        ...baseRun,
        status: 'FAILED',
        completed_at: completedAt,
        metadata: {
          ...baseRun.metadata,
          degraded: true,
          phase: 'fetch-normalize',
          attempts: attemptsUsed,
          retry_count: Math.max(0, attemptsUsed - 1),
          error: errorSummary(error),
        },
      });
      return {
        status: 'DEGRADED',
        provider_id: providerId,
        ingestion_run_id: runId,
        inserted: 0,
        duplicates: 0,
        revisions: 0,
        attempts: attemptsUsed,
        error: errorSummary(error),
      };
    }

    const accepted = [];
    let duplicates = 0;
    let revisions = 0;

    for (const observation of observations) {
      const hash = await contentHash(observation);
      const history = await memory.getEntityHistory({
        provider_ids: [providerId],
        entity_type: observation.entity_type,
        provider_entity_id: observation.entity_id,
        observation_type: observation.observation_type,
        order: 'desc',
        limit: 1,
        time_basis: 'ingested',
      });
      const previous = history[0] ?? null;

      if (previous?.content_hash === hash) {
        duplicates += 1;
        continue;
      }

      accepted.push({
        ...observation,
        observation_id: uuid(),
        ingestion_run_id: runId,
        ingested_at: now().toISOString(),
        content_hash: hash,
        supersedes_observation_id: previous?.observation_id ?? null,
      });
      if (previous) revisions += 1;
    }

    try {
      const persisted = await memory.appendObservations(accepted, {
        recorded_at: now().toISOString(),
      });
      const completedAt = now().toISOString();
      const freshness = observations.map((observation) =>
        classifyObservationFreshness(observation, {
          now: completedAt,
          staleAfterSeconds,
        }),
      );
      const staleCount = freshness.filter((item) => item.stale).length;

      await memory.saveIngestionRun({
        ...baseRun,
        status: 'SUCCEEDED',
        completed_at: completedAt,
        records_seen: observations.length,
        records_accepted: accepted.length,
        records_rejected: 0,
        metadata: {
          ...baseRun.metadata,
          degraded: false,
          attempts: attemptsUsed,
          retry_count: Math.max(0, attemptsUsed - 1),
          duplicates,
          revisions,
          stale_count: staleCount,
          last_normal_observation_at:
            observations
              .map((item) => item.timestamp_observed)
              .filter(Boolean)
              .sort()
              .at(-1) ?? null,
        },
      });

      return {
        status: staleCount > 0 ? 'STALE' : 'OK',
        provider_id: providerId,
        ingestion_run_id: runId,
        inserted: persisted.inserted,
        duplicates,
        revisions,
        attempts: attemptsUsed,
        stale_count: staleCount,
        last_normal_observation_at:
          observations
            .map((item) => item.timestamp_observed)
            .filter(Boolean)
            .sort()
            .at(-1) ?? null,
      };
    } catch (error) {
      try {
        await memory.saveIngestionRun({
          ...baseRun,
          status: 'FAILED',
          completed_at: now().toISOString(),
          records_seen: observations.length,
          records_accepted: 0,
          records_rejected: observations.length,
          metadata: {
            ...baseRun.metadata,
            degraded: true,
            phase: 'persist',
            error: errorSummary(error),
          },
        });
      } catch {
        // The database itself may be unavailable; preserve the write failure.
      }
      throw error;
    }
  }

  return Object.freeze({ ingest });
}
