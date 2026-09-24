# ARGUS GitHub Capability Survey — Final Synthesis

## Status

**7 / 7 stages complete.**

This was a **Capability-Domain bounded exhaustive survey**, not a literal enumeration of every GitHub repository.

## Institution-grade reference stack

### Spatial / rendering

- Cesium — current primary 3D renderer
- h3-js — hierarchical spatial index
- selective Turf — GeoJSON spatial operations
- Proj4js — CRS normalization
- RBush — ephemeral in-memory spatial index
- PMTiles — static/offline tile distribution
- MapLibre/deck.gl — future optional renderer/analytical overlay

### World Memory / knowledge

- PostgreSQL + PostGIS — canonical evidence store
- pgvector — semantic index
- DuckDB spatial — replay/research
- MobilityDB — conditional trajectories
- Apache AGE — graph-query PoC
- Splink — entity-resolution PoC
- OpenLineage-compatible lineage

### Senses / Earth observation

- STAC — EO discovery contract
- TiTiler + rio stack — raster service/COG
- EODAG — multi-provider EO gateway PoC
- odc-stac — EO analytics
- existing GEV ADS-B/AIS/GTFS/GBFS/imagery bridges
- Mosquitto — local sensor gateway
- SensorThings — sensor interoperability reference

### Streaming / events

- ARGUS Event Envelope
- CloudEvents — wire interoperability
- AsyncAPI — async contracts
- NATS + JetStream — initial event bus
- ARGUS Fusion Engine
- River — online anomaly baseline
- ruptures — historical change points
- OpenTelemetry + Prometheus + Alertmanager
- Flink/RisingWave only after scale evidence

### Prediction / simulation

- ARGUS Forecast Contract
- StatsForecast baseline
- Darts experiment/ensemble
- Neural/ML/foundation models as challengers
- Valhalla primary routing
- OSRM benchmark/fallback
- OpenTripPlanner transit
- OR-Tools + VROOM optimization
- SUMO traffic simulation
- Mesa agent-based simulation
- ARGUS Twin Model
- BaSyx/AAS industrial interoperability

### AI / agents

- ARGUS Agent Run Contract
- ARGUS Tool Capability Manifest
- MCP
- PydanticAI PoC
- OpenAI Agents SDK optional adapter
- LangGraph stateful workflow PoC
- ARGUS Retrieval Contract
- Temporal durable workflows
- Promptfoo / DeepEval evaluation
- garak security tests

### Security / governance

- Keycloak authentication
- OPA policy-as-code
- SOPS initial secret management
- SPIFFE/SPIRE when distributed
- Trivy security scanning
- Syft SBOM
- Cosign/Sigstore signing
- SLSA/in-toto provenance
- OpenSSF dependency checks
- pgBackRest + restic recovery
- Toxiproxy resilience testing
- Falco/Kyverno/GitOps only when deployment scale justifies them

## Final architecture

```text
Senses / Providers / Sensors
        |
        v
Observation Envelope
        |
        +--> World Memory: PostgreSQL + PostGIS
        |
        v
NATS / Event Router
        |
        v
Detectors -> Signals -> Fusion -> Events
        |
        +--> Knowledge / Entity / History
        +--> Forecast / Route / Scenario / Twin
        +--> World Watch / Project Bridges
        |
        v
ARGUS Agent Gateway
        |
Policy + Tool Manifest
        |
MCP / typed tool adapters
        |
World Analyst / Research / Watch / Scenario / Capability Scout
        |
        v
GPT Brain / Stock / AdaptiveTwin / Agriculture / future projects
```

Cross-cutting control plane:

```text
Identity
+ Policy
+ Secrets
+ Provenance
+ Audit
+ Observability
+ Security CI
+ Backup/Recovery
+ Incident/Degraded Mode
```

## Implementation order

The survey does **not** mean all dependencies should be installed now.

Recommended implementation sequence:

1. finish current Foundation CI and live-provider validation
2. world.entity / world.nearby / world.compare
3. H3 + geometry wrapper
4. World Memory schema + PostGIS
5. existing GEV sources -> Observation bridge
6. Event Envelope + Fusion v0
7. GPT Brain External Senses / MCP read-only bridge
8. observability and security CI
9. forecast/scenario/twin contracts
10. agent/tool runtime
11. backup/recovery and identity/policy control plane
12. scale-out systems only after measured bottlenecks

## Capability acquisition rule

Every future GitHub/API/model candidate follows:

```text
DISCOVER
-> LICENSE / SECURITY / MAINTENANCE AUDIT
-> INTERFACE MAP
-> ISOLATED POC
-> BENCHMARK
-> ADOPT / REFERENCE / REJECT
-> TEST / REPLAY
-> CAPABILITY REGISTRY
-> PROMOTION GATE
```

No external repository becomes part of ARGUS merely because it is popular.

## Final survey conclusion

The open-source ecosystem is sufficient to construct a large portion of an **institution-grade, personal-scale World Intelligence Platform**.

The differentiating work is not collecting hundreds of repositories. It is the ARGUS-owned contracts and integration layer that make those capabilities replaceable, auditable, interoperable and safe.
