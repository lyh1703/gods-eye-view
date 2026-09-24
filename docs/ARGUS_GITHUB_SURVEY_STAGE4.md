# ARGUS GitHub Capability Survey — Stage 4

## Scope

Stage 4 covers **Streaming / Detection / Event Fusion / Observability**.

Reviewed:
NATS/JetStream, Kafka, Pulsar, RabbitMQ, Flink/CEP, Redpanda, RisingWave, Materialize, Bytewax, Bento, CloudEvents, AsyncAPI, River, PyOD, Merlion, ruptures, OpenTelemetry Collector, Prometheus, Alertmanager, Grafana, Pandera, Evidently, Soda Core, plus the current ARGUS/GEV async/polling patterns.

## Current gap

The existing GEV layers already handle polling, freshness, stale/degraded states, retries, local feed lifecycles and provider-specific caches.

What is still missing is a shared institution-grade path for:

- durable event transport
- cross-provider event correlation
- common event revision semantics
- detector lifecycle/versioning
- cross-project event fan-out
- common traces/metrics/logs
- system-level alerting

## Core decisions

| Capability | Decision | ARGUS role |
| --- | --- | --- |
| CloudEvents | ADOPT P0 | Wire/interoperability event envelope |
| AsyncAPI | ADOPT P1 | Async contract documentation |
| NATS + JetStream | ADOPT P1 | Initial internal event bus |
| Bento | OPTIONAL P1/P2 | Connector/transform sidecar |
| Kafka | SCALE-OUT REFERENCE | Large distributed event log |
| Pulsar | SCALE-OUT REFERENCE | Distributed pub/sub alternative |
| RabbitMQ | REFERENCE | Mature routed messaging |
| Redpanda | REFERENCE | Kafka-compatible; BSL license gate |
| Flink / CEP | SCALE-OUT P3 | Complex event-time/stateful CEP |
| RisingWave | POC P2/P3 | Continuous SQL/materialized views |
| Bytewax | REFERENCE / SMALL POC | Python stream prototype; community-maintained |
| Materialize | REFERENCE ONLY | BSL/license constraints |
| River | ADOPT P1/P2 | Online anomaly/baseline detection |
| ruptures | ADOPT P1/P2 | Offline change-point analysis |
| PyOD | CHALLENGER P2 | Broad anomaly-detector benchmark |
| Merlion | REJECT NEW DEPENDENCY | Repository archived |
| OpenTelemetry Collector | ADOPT P1 | Traces/metrics/logs pipeline |
| Prometheus | ADOPT P1 | Operational metrics/rules |
| Alertmanager | ADOPT P1/P2 | System alerts |
| Grafana | OPTIONAL SIDECAR | Operator observability UI |
| Pandera | ADOPT P1/P2 | Python-worker data validation |
| Evidently | POC P2/P3 | Detector/model/data drift |
| Soda Core | REFERENCE ONLY | Elastic License 2.0 |

## Event semantics

ARGUS owns its **domain event model**.

```text
Observation
  -> Detector
  -> Signal
  -> Dedup
  -> Correlation
  -> Event Candidate
  -> Evidence / Confidence Aggregation
  -> Event
  -> Revision / Close
  -> Alert / Project Bridge
```

### Observation

Raw normalized evidence.

### Signal

A detector output indicating a possible change, anomaly or condition.

### Event

A correlated/fused domain event backed by one or more observations/signals.

### Alert

A decision to surface an event to a user or downstream system.

## Initial ARGUS Event Envelope

Candidate fields:

- event_id
- event_type
- event_version
- status
- started_at
- last_observed_at
- detected_at
- ended_at
- geometry
- h3_cells
- entity_ids
- observation_ids
- severity
- confidence
- detector_id
- detector_version
- fusion_method
- correlation_key
- dedup_key
- properties
- provenance
- supersedes_event_id
- ingestion_run_ids

CloudEvents is used at transport/webhook boundaries, not as a replacement for the ARGUS domain model.

## Event bus direction

Initial subject namespace:

```text
argus.observation.accepted
argus.observation.rejected
argus.signal.detected
argus.signal.retracted
argus.event.created
argus.event.updated
argus.event.closed
argus.alert.created
argus.provider.health
argus.provider.degraded
argus.memory.write
argus.bridge.gpt_brain
argus.bridge.stock
argus.bridge.adaptive_twin
argus.bridge.agri
```

NATS/JetStream is transport and bounded durable replay. PostgreSQL/PostGIS World Memory remains canonical evidence storage.

## Fusion Engine v0

Initial deterministic correlation should use:

- temporal windows
- H3 spatial overlap/adjacency
- entity overlap
- event-type compatibility
- source independence
- confidence/freshness
- explicit relation rules

Rules:

- never rewrite raw observations to fit an event
- every event must resolve back to evidence IDs
- repeated observations from the same source are not independent evidence
- use revision semantics rather than destructive overwrite
- keep AI explanation separate from deterministic evidence scoring
- persist detector/model/threshold versions

## Detection stack

### Primary

Deterministic rules + River online models.

### Historical analysis

ruptures for change-point detection over World Memory history.

### Challenger

PyOD for benchmark comparisons and selected domain detectors.

ML output produces **signals**, not final high-severity events by itself.

## Observability stack

```text
ARGUS services
  -> OpenTelemetry
  -> Prometheus metrics / trace-log backend
  -> Alertmanager for operational incidents
  -> optional Grafana operator dashboard
```

Initial metrics:

- provider_request_total
- provider_error_total
- provider_latency_seconds
- provider_freshness_seconds
- observations_ingested_total
- observations_rejected_total
- event_detection_total
- event_fusion_total
- world_memory_write_latency
- event_bus_lag
- bridge_delivery_total

Operational alerts and domain World Watch alerts remain separate.

## Immediate PoC backlog

1. ARGUS Event Envelope + validation/revision helpers
2. deterministic Fusion Engine v0
3. CloudEvents lossless mapping + round-trip tests
4. local NATS/JetStream publish/consume/replay PoC
5. detector contract
6. River online baseline/anomaly fixture benchmark
7. OpenTelemetry trace propagation
8. Prometheus initial metrics
9. Alertmanager operational-alert PoC

## Promotion gates

Streaming:
- restart/replay
- idempotent duplicate handling
- observable queue lag
- poison-message quarantine
- schema/version compatibility

Detection:
- benchmark fixture
- false-positive metric
- detector/threshold versioning
- deterministic replay
- rollback

Fusion:
- evidence traceability
- source-independence accounting
- no double counting
- revision history
- confidence decomposition

Observability:
- structured telemetry
- health vs degraded distinction
- alert-storm control
- incident replay

## Stage 4 result

**Stage 4 survey is complete.**

Primary architecture:

```text
Observation Envelope
  -> World Memory
  -> NATS/JetStream
  -> Detectors
  -> Signals
  -> ARGUS Fusion Engine
  -> Event Envelope
  -> World Memory
  -> World Watch / Project Bridges

CloudEvents + AsyncAPI at integration boundaries
OpenTelemetry + Prometheus + Alertmanager for operations
```

Next survey stage: **Prediction / Routing / Simulation / Digital Twin**.
