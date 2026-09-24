# ARGUS GitHub Capability Survey — Stage 7

## Scope

Stage 7 covers **Institution-grade Reliability / Security / Governance**.

Reviewed:
OPA, Cedar, Keycloak, Ory, Vault, SOPS, Infisical, SPIFFE/SPIRE, cert-manager, Sigstore/Cosign/Rekor/Fulcio, SLSA, in-toto, Trivy, Syft, Grype, OpenSSF Scorecard, Kyverno/Gatekeeper, Argo CD, Flux, pgBackRest, WAL-G, restic, Toxiproxy, LitmusChaos, Chaos Mesh, Falco, osquery, Headscale, Teleport and the current ARGUS/GEV CI.

## Current repository posture

The existing CI already has several good controls:

- GitHub Actions pinned to commit SHAs
- workflow permission limited to `contents: read`
- checkout uses `persist-credentials: false`
- locked dependency install
- setup policy checks
- formatting
- package-boundary checks
- tests
- production build
- separate Windows onboarding verification

Current gaps:

- no dedicated security workflow
- no SBOM
- no artifact signing/attestation
- no vulnerability/secret/IaC/license scan
- no common backup/restore drill
- no ARGUS IAM/policy/secrets control plane

## Core decisions

| Capability | Decision | ARGUS role |
| --- | --- | --- |
| Keycloak | ADOPT P1/P2 | Human/client authentication |
| OPA | ADOPT P1 | Canonical policy engine |
| Cedar | REFERENCE / POC | Fine-grained authorization challenger |
| SOPS | ADOPT P0/P1 | Initial encrypted config/secrets |
| Infisical | OPTIONAL P2 | Central secrets manager candidate |
| Vault | REFERENCE / CONDITIONAL | Strong secrets platform; BSL license gate |
| SPIFFE/SPIRE | ADOPT P2/P3 | Distributed workload identity |
| cert-manager | CONDITIONAL P3 | Kubernetes certificate lifecycle |
| Trivy | ADOPT P0/P1 | Vulnerability/secret/misconfig/license scanning |
| Syft | ADOPT P0/P1 | SPDX/CycloneDX SBOM |
| Grype | OPTIONAL CHALLENGER | Secondary SBOM vulnerability scanner |
| Cosign/Sigstore | ADOPT P1/P2 | Artifact/container signing |
| SLSA | ADOPT FRAMEWORK | Build provenance/security maturity |
| in-toto | ADOPT CONCEPT/P1/P2 | Supply-chain attestations |
| OpenSSF Scorecard | ADOPT P1 INPUT | OSS dependency security checks |
| pgBackRest | ADOPT P1 | PostgreSQL/PostGIS backup/PITR |
| restic | ADOPT P1/P2 | Non-DB artifact/config backup |
| WAL-G | REFERENCE | Cloud WAL/archive alternative |
| Toxiproxy | ADOPT P0/P1 | Deterministic resilience tests |
| Litmus/Chaos Mesh | CONDITIONAL P3 | Kubernetes chaos testing |
| Falco | CONDITIONAL P2/P3 | Runtime threat detection |
| osquery | OPTIONAL | Managed-host security telemetry |
| Argo CD / Flux | CONDITIONAL P3 | Kubernetes GitOps |
| Kyverno | CONDITIONAL P3 | Kubernetes policy-as-code |

## Policy architecture

```text
Identity token / service identity
  -> ARGUS Policy Decision Contract
  -> OPA
  -> allow / deny + reason + policy version
  -> Tool/API/Bridge enforcement
  -> Audit Event
```

Initial policy domains:

- tool authorization
- agent-role permissions
- data classification
- provider license/retention
- project-bridge access
- external-write approval
- capability promotion
- deployment environment

## Data classification

Initial classes:

- PUBLIC
- INTERNAL
- SENSITIVE
- RESTRICTED

Every tool and project bridge declares the maximum classification it may read/write.

GPT Brain personal memory does not become public ARGUS World Memory.

Private-person tracking remains outside the system's collection/fusion scope.

## Supply-chain security

Initial CI path:

```text
existing tests/build
  + Trivy repository scan
  + Syft SBOM
  + policy/security tests
  + dependency admission checks
```

Release path:

```text
verified source
  -> build
  -> SBOM
  -> vulnerability/license scan
  -> provenance/attestation
  -> Cosign signature
  -> immutable release artifact
  -> staged promotion
```

## Backup / disaster recovery

PostgreSQL/PostGIS World Memory:

- pgBackRest
- WAL archive
- full/differential/incremental backup
- remote repository
- checksum verification
- PITR
- timed restore drills

Non-DB artifacts/config:

- restic or equivalent encrypted backup

A backup is not considered verified until a restore has succeeded.

## Reliability philosophy

Subsystem state:

- HEALTHY
- DEGRADED
- UNAVAILABLE
- RECOVERING
- UNKNOWN

A provider outage must not become a total ARGUS outage.

Degraded examples:

- semantic search down -> exact spatial/time queries remain
- forecast backend down -> last verified forecast marked stale
- one EO provider down -> alternate/no-imagery state
- LLM down -> deterministic world query remains available

AI must never be the single point of failure for core world-data access.

## Fault injection

Toxiproxy is the first resilience test tool.

Initial failures:

- provider timeout / 429 / 500
- malformed/stale feed
- DNS failure
- Postgres latency/write failure
- NATS disconnect/replay/duplicate
- model timeout/bad structured output
- disk-full fixture
- worker crash mid-run
- cache corruption
- clock skew

## Audit Event

Candidate fields:

- audit_id
- timestamp
- actor type/id
- principal id
- agent run id
- action
- resource
- policy id/version
- tool id/version
- decision
- request/result hashes
- evidence refs
- approval id
- trace id
- severity

Audit logs are separate from debug logs and never store plaintext secrets.

## Immediate implementation backlog

1. Policy Decision Contract + OPA adapter
2. data-classification enforcement
3. Trivy + Syft security CI
4. SOPS secret-hygiene fixture
5. Toxiproxy failure tests
6. Audit Event schema
7. pgBackRest backup/PITR/restore PoC
8. Cosign release-signing PoC
9. Keycloak OIDC PoC
10. health/degraded/incident model
11. SPIRE/Kubernetes controls only after distributed deployment justifies them

## Level B completion gate

Institution-grade ARGUS requires:

- authenticated human/service identities
- least-privilege policy-as-code
- secret rotation/revocation
- SBOM + scan + signed/provenanced releases
- data classification/provenance/retention
- backup + verified recovery
- degraded modes and failure isolation
- metrics/traces/health/incident lifecycle
- bounded agent permissions
- security regression and audit trail

## Stage 7 result

**Stage 7 is complete.**

The seven-stage bounded exhaustive GitHub survey is now complete. Future discovery continues through the Capability Scout; completion means the initial ARGUS capability baseline is established, not that GitHub has stopped changing.
