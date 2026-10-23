# CelesTrak request policy and verification

CelesTrak GP endpoint: <https://celestrak.org/NORAD/elements/gp.php>.
Policy reference: <https://celestrak.org/NORAD/documentation/gp-data-formats.php>.
Avoid unnecessary GP downloads and repeated requests after HTTP failures. The
implementation keeps the existing conservative six-hour catalog lifetime, makes
one attempt, waits at least two hours after failure (six hours for 403), and
honors a longer Retry-After. Every upstream HTTP failure also latches an
operator-required halt: time passing does not automatically resume downloads.
It does not infer IP blocking from 403 or timeout.
The policy page could not be fetched in the restricted development environment;
these intervals implement the supplied policy requirements, not a claim that
CelesTrak guarantees availability or prescribes these exact backoff values.

## Confirmed incident evidence

PR #29 HEAD e49b8bb99ac190884d06921f8b7db8e373973a23:
<https://github.com/lyh1703/gods-eye-view/actions/runs/39912036373>.
Node 26 job 120279045415 failed the public CelesTrak assertion after 21,269 ms.
The old assertion discarded the ingestion error. It establishes DEGRADED,
not an upstream HTTP status, DNS failure, TLS failure, or IP block. Node 24
passed its PostGIS job, but did not execute the public CelesTrak step.

Confirmed code defects were independent of the unknown network failure:

- Public E2E bypassed the application's six-hour cache and single-flight path.
- Every request after a failed refresh could immediately contact upstream again.
- The adapter conflated cancellation, timeout and network failures; the ingestor
  retried named timeout errors even when the provider explicitly vetoed retry.
- Cached fallback data lacked fetch time/source/digest at the adapter boundary.
- Propagating an old TLE at the current time could reset ingestion freshness.

## Runtime behavior

`server/providers/space/celestrak-client.js` is shared by middleware and public
E2E. Cache entries bind the original fetch timestamp, group, fixed source URL,
body SHA-256 and metadata integrity hash. Atomic writes prevent partial entries.
The separate successful-download ledger prevents a corrupt or removed cache
body from granting another download within six hours. Existing legacy cache
files without verifiable provenance are not accepted as verified source data. A
valid legacy receipt timestamp still prevents early redownload until its original
six-hour interval expires; any fallback remains explicitly unverified.

A directory lock serializes independent clients sharing the directory; same
client groups queue, and identical in-flight groups share a promise. A persisted
request reservation survives interruption; failures impose a host-wide cooldown,
including requests for other groups. After any HTTP failure an operator must
identify/correct the cause and wait out the recorded interval before explicitly
clearing the request-state file. Do not repeatedly clear a failing state.
This is coordination on one filesystem,
not a distributed limit across different hosts. Deployments sharing an outbound
IP should share the cache directory or centralize the proxy. The CI public gate
uses the runner tool cache across checkouts and runs, without changing runners.

An abandoned `celestrak-request.lock` is never stolen automatically. An operator
must establish that its owner has stopped before removing that lock. Preserve
the request ledger and its waiting interval. Malformed request ledgers and cache
write failures fail closed; repeatedly deleting caches to force retries defeats
the policy. Network-failure cooldowns expire automatically; HTTP-failure halts require
operator resolution. Normal six-hour refresh also requires the download ledger
to permit it.

Failures record fixed classifications, HTTP status where observed, elapsed time,
headers/body phase and next allowed attempt time. They omit error messages,
response bodies, proxy URLs, addresses and credentials. AbortError is cancellation;
TimeoutError is timeout. HTTP 403/429/5xx, DNS, certificate and connection failures
have distinct classifications. No alternate host, redirect, format fallback or
cache-busting request is attempted. A 20-second deadline covers headers and body.

The middleware still offers an explicitly marked STALE-ERROR response for globe
continuity. ARGUS rejects this as a new ingestion and records DEGRADED; it does
not synthesize fresh observations. Successful propagated positions retain TLE
epoch/age, original download time/cache status/digest and SGP4/state-basis labels.
The ingestor considers source freshness as well as observation age. A current
propagation timestamp cannot make old orbital elements fresh. Propagated state
is derived orbital state, not a live measured observation.

For a network requiring an HTTP(S) proxy, launch supported Node with
`NODE_USE_ENV_PROXY=1` (or `--use-env-proxy`), preserving proxy/CA settings and TLS
verification. The public CI step sets this flag. It cannot grant network access:
this development environment does not allow celestrak.org. Do not bypass policy.

## Independent gates

1. `node --test src/argus/celestrakReliability.test.mjs`: offline provider,
   cache, middleware, corruption, cooldown, retry and freshness regressions.
2. `ARGUS_POSTGRES_TEST_URL=... node --test src/argus/celestrakPersistence.postgres.test.mjs`:
   explicitly labeled offline TLE fixture, actual PostGIS persistence, closed-pool
   reconnect, NEXUS current/near queries. Runs on both CI Node versions.
3. `ARGUS_POSTGRES_TEST_URL=... node --test src/argus/celestrakPublic.postgres.test.mjs`:
   actual public source through the production client, actual PostGIS/NEXUS.
   Still required on Node 26; failure is a failing gate. No mocks or ignored errors.
   `ARGUS_CELESTRAK_CACHE_DIR` selects its durable policy directory.

The public gate reports UPSTREAM_RECEIVED only after an actual successful download.
VERIFIED_FRESH_CACHE reports reuse of a previously received, validated public
catalog within six hours; it does not claim a new network success. Source URL,
original fetched_at and SHA-256 accompany either result. Failure includes the safe
diagnostic rather than only DEGRADED. Never report offline fixture success as
public receipt. The existing USGS/MBTA/NEXUS gates remain required and unchanged.

PR #29 is integrated by a local merge into the separate reliability branch based
on argus/main (base 20d715230637ab108c6e8f13eb0ab3ff4eed82b1). This preserves its
future-date evidence validation. It does not merge or push PR #29 itself. The
new PR therefore includes that unmerged dependency until #29 lands; review the
reliability commit separately when assessing the incremental change.
