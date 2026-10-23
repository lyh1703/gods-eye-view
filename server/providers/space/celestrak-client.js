import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { celestrakTleUrl } from '../../../src/data/spaceProviderRequests.js';
import {
  readResponseTextCapped,
  coalesceProxyRequest,
} from '../../../src/sources/httpBody.js';
import {
  CELESTRAK_TTL_MS,
  CELESTRAK_FAILURE_DELAY_MS,
  celestrakFailure,
  validCelestrakTle,
} from '../../../src/data/celestrakPolicy.js';

const hash = (body) => createHash('sha256').update(body).digest('hex');
const integrity = (entry) =>
  hash(JSON.stringify([entry.group, entry.source_url, entry.at, entry.sha256]));

/** One policy-aware transport for the application proxy and public E2E.
 * Share cacheDir across processes on the same host. Atomic directory locking
 * serializes downloads; a persisted reservation survives process termination.
 * No automatic retry, alternate host, format fallback, or cache-busting query.
 */
export function createCelestrakClient({
  cacheDir = path.join(process.cwd(), '.gev-cache'),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  timeoutMs = 20_000,
} = {}) {
  const inflight = new Map();
  let serial = Promise.resolve();
  const mem = new Map();
  const gatePath = path.join(cacheDir, 'celestrak-request-state.json');
  const downloadsPath = path.join(cacheDir, 'celestrak-downloads.json');
  const lockPath = path.join(cacheDir, 'celestrak-request.lock');
  const entryPath = (group) => path.join(cacheDir, `celestrak-${group}.json`);
  const readJson = async (file, strict = false) => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return strict ? undefined : null;
      if (!strict && error instanceof SyntaxError) return null;
      throw error;
    }
  };
  async function atomicWrite(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temp, JSON.stringify(value), {
        flag: 'wx',
        mode: 0o600,
      });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true });
    }
  }
  function valid(entry, group) {
    return (
      entry?.version === 1 &&
      entry.group === group &&
      entry.source_url === celestrakTleUrl(group).toString() &&
      Number.isFinite(entry.at) &&
      entry.at >= 0 &&
      entry.at <= now() &&
      typeof entry.body === 'string' &&
      Buffer.byteLength(entry.body) <= 8_000_000 &&
      entry.sha256 === hash(entry.body) &&
      entry.integrity === integrity(entry) &&
      validCelestrakTle(entry.body)
    );
  }
  async function cached(group) {
    const memory = mem.get(group);
    if (memory && valid(memory, group)) return memory;
    const entry = await readJson(entryPath(group));
    if (valid(entry, group)) {
      mem.set(group, entry);
      return entry;
    }
    // Upgrade the previous {at, body} format conservatively. Its provenance
    // cannot establish a verified public receipt, but its timestamp still
    // forbids a needless download inside the existing six-hour interval.
    if (
      entry?.version == null &&
      Number.isFinite(entry?.at) &&
      entry.at >= 0 &&
      entry.at <= now() &&
      validCelestrakTle(entry.body)
    ) {
      return {
        ...entry,
        version: 0,
        group,
        source_url: celestrakTleUrl(group).toString(),
        sha256: hash(entry.body),
      };
    }
    return null;
  }
  function result(entry, cache, diagnostic = null) {
    return { entry, cache, diagnostic, stale: cache === 'STALE-ERROR' };
  }
  function failure(entry, diagnostic) {
    return result(entry, entry ? 'STALE-ERROR' : 'NONE', diagnostic);
  }
  async function load(group) {
    let entry = await cached(group);
    if (entry?.version === 1 && now() - entry.at < CELESTRAK_TTL_MS)
      return result(entry, 'HIT');
    await fs.mkdir(cacheDir, { recursive: true });
    try {
      await fs.mkdir(lockPath);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Do not steal another process's lock, even if it looks old. A crashed
      // owner's lock requires operator inspection; fail closed without fetching.
      return failure(entry, {
        code: 'CACHE_BUSY',
        name: 'ProviderError',
        retryable: false,
        http_status: null,
      });
    }
    try {
      entry = await cached(group);
      if (entry?.version === 1 && now() - entry.at < CELESTRAK_TTL_MS)
        return result(entry, 'HIT');
      if (entry?.version === 0 && now() - entry.at < CELESTRAK_TTL_MS) {
        return failure(entry, {
          code: 'LEGACY_CACHE_UNVERIFIED',
          name: 'ProviderError',
          retryable: false,
          http_status: null,
          next_attempt_at: entry.at + CELESTRAK_TTL_MS,
        });
      }
      const state = await readJson(gatePath, true);
      if (
        state !== undefined &&
        (!state ||
          typeof state !== 'object' ||
          !Number.isFinite(state.next_attempt_at) ||
          !state.diagnostic ||
          ![
            'REQUEST_INTERRUPTED',
            'ACCESS_DENIED',
            'RATE_LIMIT',
            'UPSTREAM_FAILURE',
            'HTTP_FAILURE',
            'TIMEOUT',
            'ABORTED',
            'DNS_FAILURE',
            'TLS_FAILURE',
            'CONNECT_TIMEOUT',
            'CONNECTION_REFUSED',
            'CONNECTION_RESET',
            'NETWORK_FAILURE',
            'MALFORMED_PAYLOAD',
            'OVERSIZED_RESPONSE',
          ].includes(state.diagnostic.code))
      ) {
        return failure(entry, {
          code: 'INVALID_REQUEST_STATE',
          name: 'ProviderError',
          retryable: false,
          http_status: null,
        });
      }
      if (
        state &&
        (state.diagnostic.requires_operator === true ||
          now() < state.next_attempt_at)
      )
        return failure(entry, {
          code: state.diagnostic.code,
          name:
            state.diagnostic.code === 'TIMEOUT'
              ? 'TimeoutError'
              : state.diagnostic.code === 'ABORTED'
                ? 'AbortError'
                : 'ProviderError',
          retryable: false,
          http_status:
            Number.isInteger(state.diagnostic.http_status) &&
            state.diagnostic.http_status >= 400 &&
            state.diagnostic.http_status <= 599
              ? state.diagnostic.http_status
              : null,
          next_attempt_at: state.next_attempt_at,
          requires_operator: state.diagnostic.requires_operator === true,
        });
      const parsedDownloads = await readJson(downloadsPath, true);
      const downloads = parsedDownloads === undefined ? {} : parsedDownloads;
      if (
        !downloads ||
        typeof downloads !== 'object' ||
        Array.isArray(downloads) ||
        Object.values(downloads).some((at) => !Number.isFinite(at) || at < 0)
      ) {
        throw new TypeError('Invalid CelesTrak download ledger');
      }
      const lastDownload = Object.hasOwn(downloads, group)
        ? downloads[group]
        : null;
      if (
        lastDownload != null &&
        (!Number.isFinite(lastDownload) ||
          now() < lastDownload + CELESTRAK_TTL_MS)
      ) {
        return failure(entry, {
          code: 'CACHE_INTEGRITY_FAILURE',
          name: 'ProviderError',
          retryable: false,
          http_status: null,
          next_attempt_at: Number.isFinite(lastDownload)
            ? lastDownload + CELESTRAK_TTL_MS
            : null,
        });
      }
      const started = now();
      let diagnostic = {
        code: 'REQUEST_INTERRUPTED',
        name: 'ProviderError',
        retryable: false,
        http_status: null,
        next_attempt_at: started + CELESTRAK_FAILURE_DELAY_MS,
      };
      await atomicWrite(gatePath, {
        next_attempt_at: diagnostic.next_attempt_at,
        diagnostic,
      });
      let fresh;
      let phase = 'headers';
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        const response = await fetchImpl(celestrakTleUrl(group), {
          signal,
          redirect: 'error',
          headers: {
            'User-Agent':
              'gods-eye-view-celestrak/2.0 (+https://github.com/lyh1703/gods-eye-view)',
          },
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          diagnostic = celestrakFailure(null, response.status);
          // CelesTrak asks clients to stop automatic downloads after HTTP
          // errors. Time passing alone must not clear this latch.
          diagnostic.requires_operator = true;
          const retryAfter = response.headers.get('retry-after');
          const seconds = retryAfter == null ? NaN : Number(retryAfter);
          const requested = Number.isFinite(seconds)
            ? now() + Math.max(0, seconds) * 1000
            : Date.parse(retryAfter);
          diagnostic.next_attempt_at = Math.max(
            started +
              (response.status === 403
                ? CELESTRAK_TTL_MS
                : CELESTRAK_FAILURE_DELAY_MS),
            Number.isFinite(requested) ? requested : 0,
          );
        } else {
          phase = 'body';
          const body = await readResponseTextCapped(
            response,
            8_000_000,
            signal,
          );
          if (!validCelestrakTle(body))
            throw Object.assign(new Error(), { code: 'MALFORMED_PAYLOAD' });
          fresh = {
            version: 1,
            group,
            source_url: celestrakTleUrl(group).toString(),
            at: now(),
            body,
            sha256: hash(body),
          };
          fresh.integrity = integrity(fresh);
        }
      } catch (error) {
        diagnostic = celestrakFailure(error);
      }
      if (!fresh) {
        diagnostic.phase = phase;
        diagnostic.elapsed_ms = Math.max(0, now() - started);
        diagnostic.next_attempt_at ??= now() + CELESTRAK_FAILURE_DELAY_MS;
        await atomicWrite(gatePath, {
          next_attempt_at: diagnostic.next_attempt_at,
          diagnostic,
        });
        return failure(entry, diagnostic);
      }
      // Cache durability is part of success: a restart must not redownload.
      // An independent ledger prevents cache corruption/deletion from granting
      // a second download within the policy interval.
      downloads[group] = fresh.at;
      await atomicWrite(downloadsPath, downloads);
      await atomicWrite(entryPath(group), fresh);
      mem.set(group, fresh);
      await fs.rm(gatePath, { force: true });
      return result(fresh, 'MISS');
    } finally {
      await fs.rmdir(lockPath);
    }
  }
  return Object.freeze({
    async readGroup(group) {
      if (!/^[a-z0-9-]{1,64}$/i.test(group))
        throw new TypeError('Invalid CelesTrak group');
      return coalesceProxyRequest(inflight, group, () => {
        const pending = serial.catch(() => {}).then(() => load(group));
        serial = pending;
        return pending;
      }).promise;
    },
  });
}

export function celestrakResponse(result) {
  const { entry, cache, diagnostic } = result;
  const headers = {
    'Content-Type': 'text/plain',
    'Cache-Control': 'no-store',
    'x-tle-cache': cache,
  };
  if (entry) {
    headers['x-tle-fetched-at'] = new Date(entry.at).toISOString();
    headers['x-tle-source'] = entry.source_url;
    headers['x-tle-sha256'] = entry.sha256;
  }
  if (diagnostic) {
    headers['x-celestrak-error'] = diagnostic.code;
    if (diagnostic.requires_operator)
      headers['x-celestrak-operator-required'] = 'true';
    if (diagnostic.http_status != null)
      headers['x-celestrak-http-status'] = String(diagnostic.http_status);
    if (diagnostic.next_attempt_at)
      headers['Retry-After'] = String(
        Math.max(
          1,
          Math.ceil((diagnostic.next_attempt_at - Date.now()) / 1000),
        ),
      );
  }
  return new Response(
    entry?.body ?? 'celestrak fetch failed and no cache available',
    { status: entry ? 200 : 502, headers },
  );
}
