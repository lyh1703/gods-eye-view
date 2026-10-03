import { validateObservationEnvelope } from './observationEnvelope.js';
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

    // Fail the complete snapshot closed before reading history or appending
    // anything: the claimed provider must match the adapter, and every
    // observation must satisfy the shared envelope contract.
    let evidenceError = null;
    for (const observation of observations) {
      const checked = validateObservationEnvelope(observation);
      if (!checked.ok) {
        evidenceError = new TypeError(
          `Invalid provider observation: ${checked.errors.join('; ')}`,
        );
      } else if (observation.provider_id !== providerId) {
        evidenceError = new TypeError(
          'Observation provider_id differs from the queried adapter',
        );
      }
      if (evidenceError) break;
    }
    if (evidenceError) {
      evidenceError.code = 'INVALID_OBSERVATION_EVIDENCE';
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
          phase: 'evidence-validation',
          attempts: attemptsUsed,
          retry_count: Math.max(0, attemptsUsed - 1),
          error: errorSummary(evidenceError),
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
        error: errorSummary(evidenceError),
      };
    }

    const accepted = [];
    const historyByEntity = new Map();
    let duplicates = 0;
    let revisions = 0;
    let outOfOrder = 0;

    for (const observation of observations) {
      const hash = await contentHash(observation);
      const entityKey = JSON.stringify([
        observation.entity_type,
        observation.entity_id,
        observation.observation_type,
      ]);
      if (!historyByEntity.has(entityKey)) {
        // Reverse the repository's newest-first order: an in-flight revision
        // appended below must be the final tie-breaker for equal observed_at.
        const committed = await memory.getEntityHistory({
          provider_ids: [providerId],
          entity_type: observation.entity_type,
          provider_entity_id: observation.entity_id,
          observation_type: observation.observation_type,
          order: 'desc',
          limit: 100,
          time_basis: 'ingested',
        });
        historyByEntity.set(entityKey, [...committed].reverse());
      }
      const history = historyByEntity.get(entityKey);

      if (history.some((item) => item.content_hash === hash)) {
        duplicates += 1;
        continue;
      }

      const previous = history.reduce((latest, item) => {
        if (!latest) return item;
        const latestObserved = Date.parse(latest.timestamp_observed ?? '');
        const itemObserved = Date.parse(item.timestamp_observed ?? '');
        if (!Number.isFinite(itemObserved)) return latest;
        if (!Number.isFinite(latestObserved) || itemObserved >= latestObserved) {
          return item;
        }
        return latest;
      }, null);
      const incomingObserved = Date.parse(observation.timestamp_observed ?? '');
      const previousObserved = Date.parse(previous?.timestamp_observed ?? '');
      const isOutOfOrder =
        previous &&
        Number.isFinite(incomingObserved) &&
        Number.isFinite(previousObserved) &&
        incomingObserved < previousObserved;

      const staged = {
        ...observation,
        observation_id: uuid(),
        ingestion_run_id: runId,
        ingested_at: now().toISOString(),
        content_hash: hash,
        supersedes_observation_id: isOutOfOrder
          ? null
          : (previous?.observation_id ?? null),
      };
      accepted.push(staged);
      // The original history query sees only previously committed rows.
      // Include this snapshot's accepted rows so relays/repeated items within
      // a single provider response are not counted as new observations.
      history.push(staged);
      if (isOutOfOrder) outOfOrder += 1;
      else if (previous) revisions += 1;
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
          out_of_order: outOfOrder,
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
        out_of_order: outOfOrder,
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
