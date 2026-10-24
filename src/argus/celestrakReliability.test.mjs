import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createCelestrakClient,
  celestrakResponse,
} from '../../server/providers/space/celestrak-client.js';
import { celestrakProxy } from '../../server/providers/space/celestrak.js';
import {
  celestrakFailure,
  CELESTRAK_TTL_MS,
  CELESTRAK_FAILURE_DELAY_MS,
} from '../data/celestrakPolicy.js';
import { createGevCelestrakSatellitesAdapter } from './providers/gevCelestrakSatellites.js';
import { createExternalProviderIngestor } from './externalProviderIngest.js';
import { createInMemoryWorldMemoryRepository } from './memory/repository.js';

const TLE = `OFFLINE ISS FIXTURE
1 25544U 98067A   26274.10000000  .00016717  00000+0  30174-3 0  9998
2 25544  51.6390 180.1234 0005000 200.0000 160.0000 15.50000000412345
`;
const START = Date.parse('2026-10-01T03:00:00Z');

async function fixture(t, fetchImpl) {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'argus-celestrak-'));
  t.after(() => rm(cacheDir, { recursive: true, force: true }));
  let time = START;
  let calls = 0;
  const options = {
    cacheDir,
    now: () => time,
    fetchImpl: async (...args) => {
      calls++;
      return fetchImpl(...args);
    },
  };
  return {
    cacheDir,
    client: createCelestrakClient(options),
    restart: () => createCelestrakClient(options),
    advance: (ms) => {
      time += ms;
    },
    calls: () => calls,
  };
}

test('single-flight, six-hour memory/disk cache and provenance survive restart', async (t) => {
  const f = await fixture(t, async (url, init) => {
    assert.equal(
      String(url),
      'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
    );
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    return new Response(TLE);
  });
  const [one, two] = await Promise.all([
    f.client.readGroup('stations'),
    f.client.readGroup('stations'),
  ]);
  assert.deepEqual(one, two);
  assert.equal(one.cache, 'MISS');
  assert.equal(f.calls(), 1);
  f.advance(CELESTRAK_TTL_MS - 1);
  const cached = await f.restart().readGroup('stations');
  assert.equal(cached.cache, 'HIT');
  assert.equal(cached.entry.at, START);
  assert.equal(cached.entry.source_url, one.entry.source_url);
  assert.equal(cached.entry.sha256, one.entry.sha256);
  assert.equal(f.calls(), 1);
  f.advance(1);
  assert.equal((await f.client.readGroup('stations')).cache, 'MISS');
  assert.equal(f.calls(), 2);
});

for (const [status, code] of [
  [403, 'ACCESS_DENIED'],
  [429, 'RATE_LIMIT'],
  [503, 'UPSTREAM_FAILURE'],
  [404, 'HTTP_FAILURE'],
]) {
  test(`HTTP ${status} persists host cooldown across groups and restart without retry`, async (t) => {
    const f = await fixture(
      t,
      async () =>
        new Response('secret upstream body', {
          status,
          headers: { 'Retry-After': '30000' },
        }),
    );
    const first = await f.client.readGroup('stations');
    assert.equal(first.diagnostic.code, code);
    assert.equal(first.diagnostic.http_status, status);
    assert.equal(first.diagnostic.retryable, false);
    assert.equal(first.diagnostic.next_attempt_at, START + 30_000_000);
    const second = await f.restart().readGroup('visual');
    assert.equal(second.diagnostic.code, code);
    assert.equal(f.calls(), 1);
    assert.doesNotMatch(JSON.stringify(second), /secret upstream/);
    f.advance(31_000_000);
    const halted = await f.restart().readGroup('stations');
    assert.equal(halted.diagnostic.requires_operator, true);
    assert.equal(
      f.calls(),
      1,
      'HTTP failures remain halted after the cooldown expires',
    );
  });
}

for (const [error, code] of [
  [new DOMException('private timeout', 'TimeoutError'), 'TIMEOUT'],
  [new DOMException('private cancel', 'AbortError'), 'ABORTED'],
  [
    new TypeError('private DNS', { cause: { code: 'ENOTFOUND' } }),
    'DNS_FAILURE',
  ],
  [
    new TypeError('private TLS', {
      cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' },
    }),
    'TLS_FAILURE',
  ],
  [
    new TypeError('private connection', {
      cause: { code: 'UND_ERR_CONNECT_TIMEOUT' },
    }),
    'CONNECT_TIMEOUT',
  ],
  [
    new TypeError('private reset', { cause: { code: 'ECONNRESET' } }),
    'CONNECTION_RESET',
  ],
]) {
  test(`${code} remains distinct and cannot trigger the ingestor timeout retry`, async (t) => {
    const f = await fixture(t, async () => {
      throw error;
    });
    const adapter = createGevCelestrakSatellitesAdapter({
      fetchImpl: async () =>
        celestrakResponse(await f.client.readGroup('stations')),
    });
    const repository = createInMemoryWorldMemoryRepository();
    const result = await createExternalProviderIngestor({
      repository,
      maxAttempts: 3,
    }).ingest(adapter);
    assert.equal(result.status, 'DEGRADED');
    assert.equal(result.attempts, 1);
    assert.equal(result.error.code, code);
    assert.equal(result.error.diagnostic.http_status, null);
    assert.doesNotMatch(JSON.stringify(result), /private/);
    await f.restart().readGroup('visual');
    assert.equal(f.calls(), 1);
    const state = JSON.parse(
      await readFile(
        path.join(f.cacheDir, 'celestrak-request-state.json'),
        'utf8',
      ),
    );
    assert.ok(state.next_attempt_at >= START + CELESTRAK_FAILURE_DELAY_MS);
  });
}

test('direct transport AbortError and TimeoutError honor explicit no-retry policy', async () => {
  for (const name of ['AbortError', 'TimeoutError']) {
    let calls = 0;
    const adapter = createGevCelestrakSatellitesAdapter({
      fetchImpl: async () => {
        calls++;
        throw new DOMException('private', name);
      },
    });
    const result = await createExternalProviderIngestor({
      repository: createInMemoryWorldMemoryRepository(),
      maxAttempts: 3,
    }).ingest(adapter);
    assert.equal(result.status, 'DEGRADED');
    assert.equal(result.error.name, name);
    assert.equal(
      result.error.code,
      name === 'AbortError' ? 'ABORTED' : 'TIMEOUT',
    );
    assert.equal(calls, 1);
  }
});

test('malformed/partial upstream never replaces a valid cache or produces fresh ingestion', async (t) => {
  let body = TLE;
  const f = await fixture(t, async () => new Response(body));
  const first = await f.client.readGroup('stations');
  f.advance(CELESTRAK_TTL_MS);
  body = TLE + 'partial-record\n1 25544';
  const stale = await f.client.readGroup('stations');
  assert.equal(stale.cache, 'STALE-ERROR');
  assert.equal(stale.diagnostic.code, 'MALFORMED_PAYLOAD');
  assert.equal(stale.entry.at, first.entry.at);
  assert.equal(stale.entry.sha256, first.entry.sha256);
  const adapter = createGevCelestrakSatellitesAdapter({
    fetchImpl: async () => celestrakResponse(stale),
  });
  const repository = createInMemoryWorldMemoryRepository();
  const result = await createExternalProviderIngestor({ repository }).ingest(
    adapter,
  );
  assert.equal(result.status, 'DEGRADED');
  assert.equal(result.error.code, 'STALE_CACHE');
  assert.equal(result.inserted, 0);
  assert.equal((await repository.queryObservations({})).length, 0);
  assert.equal((await f.restart().readGroup('stations')).cache, 'STALE-ERROR');
  assert.equal(f.calls(), 2);
});

test('corrupt hash, future timestamp, wrong group or source cache cannot be accepted', async (t) => {
  for (const mutate of [
    (e) => {
      e.sha256 = 'wrong';
    },
    (e) => {
      e.at = START + 1;
    },
    (e) => {
      e.group = 'visual';
    },
    (e) => {
      e.source_url = 'https://example.invalid';
    },
  ]) {
    const f = await fixture(t, async () => new Response(TLE));
    await f.client.readGroup('stations');
    const file = path.join(f.cacheDir, 'celestrak-stations.json');
    const entry = JSON.parse(await readFile(file, 'utf8'));
    mutate(entry);
    await writeFile(file, JSON.stringify(entry));
    const rejected = await f.restart().readGroup('stations');
    assert.equal(rejected.cache, 'NONE');
    assert.equal(rejected.diagnostic.code, 'CACHE_INTEGRITY_FAILURE');
    assert.equal(f.calls(), 1);
    f.advance(CELESTRAK_TTL_MS);
    assert.equal((await f.restart().readGroup('stations')).cache, 'MISS');
    assert.equal(f.calls(), 2);
  }
});

test('independent clients cannot download concurrently or steal a crashed lock', async (t) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let started;
  const fetching = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, async () => {
    started();
    await gate;
    return new Response(TLE);
  });
  const pending = f.client.readGroup('stations');
  await fetching;
  assert.equal(
    (await f.restart().readGroup('visual')).diagnostic.code,
    'CACHE_BUSY',
  );
  assert.equal(f.calls(), 1);
  release();
  await pending;
  await mkdir(path.join(f.cacheDir, 'celestrak-request.lock'));
  f.advance(CELESTRAK_TTL_MS);
  assert.equal(
    (await f.restart().readGroup('stations')).diagnostic.code,
    'CACHE_BUSY',
  );
  assert.equal(f.calls(), 1);
});

test('corrupt request ledger fails closed without downloading', async (t) => {
  const f = await fixture(t, async () =>
    assert.fail('corrupt ledger triggered download'),
  );
  await writeFile(
    path.join(f.cacheDir, 'celestrak-request-state.json'),
    '{broken',
  );
  await assert.rejects(f.client.readGroup('stations'), SyntaxError);
  assert.equal(f.calls(), 0);
});

test('development/preview middleware exposes cache age/provenance and safe HTTP error diagnostics', async (t) => {
  for (const preview of [false, true]) {
    const f = await fixture(t, async () => new Response(TLE));
    let handler;
    const plugin = celestrakProxy({ client: f.client });
    plugin[preview ? 'configurePreviewServer' : 'configureServer']({
      middlewares: {
        use(route, callback) {
          assert.equal(route, '/api/celestrak');
          handler = callback;
        },
      },
    });
    const res = {
      writeHead(status, headers) {
        Object.assign(this, { status, headers });
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url: '/stations', method: 'GET' }, res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tle-cache'], 'MISS');
    assert.equal(
      res.headers['x-tle-fetched-at'],
      new Date(START).toISOString(),
    );
    assert.match(res.headers['x-tle-sha256'], /^[a-f0-9]{64}$/);
    assert.equal(res.body, TLE);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
});

test('unrecognized errors expose only a fixed classification', () => {
  assert.deepEqual(celestrakFailure({ message: 'secret', code: 'secret' }), {
    code: 'NETWORK_FAILURE',
    name: 'ProviderError',
    http_status: null,
    retryable: false,
  });
});

test('fresh propagation cannot reset old orbital-element freshness', async () => {
  const received = new Date(START + 4 * 86400_000);
  const adapter = createGevCelestrakSatellitesAdapter({
    now: () => received,
    fetchImpl: async () => new Response(TLE),
  });
  const repository = createInMemoryWorldMemoryRepository({
    now: () => received,
  });
  const result = await createExternalProviderIngestor({
    repository,
    now: () => received,
    staleAfterSeconds: 24 * 3600,
  }).ingest(adapter);
  assert.equal(result.status, 'STALE');
  const [observation] = await repository.queryObservations({});
  assert.equal(observation.properties.tle_stale, true);
  assert.equal(
    observation.properties.state_basis,
    'propagated-orbital-elements',
  );
  assert.ok(observation.freshness_seconds > 72 * 3600);
});

test('future, expired or missing proxy provenance cannot establish fresh ingestion', async () => {
  for (const fetchedAt of [
    null,
    new Date(START + 1).toISOString(),
    new Date(START - CELESTRAK_TTL_MS).toISOString(),
  ]) {
    const adapter = createGevCelestrakSatellitesAdapter({
      now: () => new Date(START),
      fetchImpl: async () =>
        new Response(TLE, {
          headers: {
            'x-tle-cache': 'HIT',
            ...(fetchedAt ? { 'x-tle-fetched-at': fetchedAt } : {}),
            'x-tle-source':
              'https://celestrak.org/NORAD/elements/gp.php?GROUP=stations&FORMAT=tle',
            'x-tle-sha256': 'a'.repeat(64),
          },
        }),
    });
    await assert.rejects(
      adapter.query(),
      (error) => error.code === 'INVALID_CACHE_PROVENANCE',
    );
  }
});

test('legacy cache cannot cause early redownload or claim verified public provenance', async (t) => {
  const f = await fixture(t, async () => new Response(TLE));
  await writeFile(
    path.join(f.cacheDir, 'celestrak-stations.json'),
    JSON.stringify({ at: START, body: TLE }),
  );
  const legacy = await f.client.readGroup('stations');
  assert.equal(legacy.cache, 'STALE-ERROR');
  assert.equal(legacy.diagnostic.code, 'LEGACY_CACHE_UNVERIFIED');
  assert.equal(f.calls(), 0);
  f.advance(CELESTRAK_TTL_MS);
  assert.equal((await f.restart().readGroup('stations')).cache, 'MISS');
  assert.equal(f.calls(), 1);
});

test('parallel groups share a serial queue, and a first failure prevents later group downloads', async (t) => {
  const f = await fixture(
    t,
    async () => new Response('unavailable', { status: 503 }),
  );
  const results = await Promise.all(
    ['stations', 'visual', 'geo'].map((group) => f.client.readGroup(group)),
  );
  assert.equal(
    results.every((result) => result.diagnostic.code === 'UPSTREAM_FAILURE'),
    true,
  );
  assert.equal(f.calls(), 1);
});

test('an expired in-memory entry adopts a newer receipt written by another client', async (t) => {
  const f = await fixture(t, async () => new Response(TLE));
  const first = await f.client.readGroup('stations');
  const peer = f.restart();
  assert.equal((await peer.readGroup('stations')).entry.at, first.entry.at);
  f.advance(CELESTRAK_TTL_MS);
  const refreshed = await f.client.readGroup('stations');
  assert.equal(refreshed.cache, 'MISS');
  const adopted = await peer.readGroup('stations');
  assert.equal(adopted.cache, 'HIT');
  assert.equal(adopted.entry.at, refreshed.entry.at);
  assert.equal(adopted.diagnostic, null);
  assert.equal(
    f.calls(),
    2,
    'peer must use the new disk receipt without redownloading',
  );
});
