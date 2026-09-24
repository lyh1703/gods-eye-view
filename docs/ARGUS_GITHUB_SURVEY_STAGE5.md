# ARGUS GitHub Capability Survey — Stage 5

## Scope

Stage 5 covers **Prediction / Routing / Simulation / Digital Twin**.

Reviewed:
Darts, sktime, StatsForecast, MLForecast, NeuralForecast, GluonTS, Prophet, statsmodels, Chronos, TimesFM, Uni2TS/Moirai, OSRM, Valhalla, GraphHopper, OpenTripPlanner, VROOM, OR-Tools, PyVRP, Timefold Solver, Eclipse SUMO, CARLA, Mesa, Eclipse Ditto, Eclipse BaSyx, FIWARE Orion-LD and related candidates.

## Core decisions

| Capability | Decision | ARGUS role |
| --- | --- | --- |
| ARGUS Forecast Contract | BUILD P0/P1 | Canonical forecast interface |
| StatsForecast | ADOPT P1 | Statistical baseline |
| Darts | ADOPT P1/P2 | Experiment/backtest/ensemble harness |
| sktime | REFERENCE / POC | Time-series estimator challenger |
| NeuralForecast | CHALLENGER P2 | Neural forecasting |
| MLForecast | OPTIONAL P2 | Feature-based ML forecasting |
| GluonTS | REFERENCE / POC | Probabilistic modeling |
| Chronos / TimesFM / Uni2TS | POC P2/P3 | Foundation-model challengers |
| Valhalla | ADOPT P1 | Primary routing candidate |
| OSRM | ADOPT BENCHMARK / OPTIONAL | Fast road-routing backend |
| GraphHopper | REFERENCE / POC | Routing challenger |
| OpenTripPlanner | CONDITIONAL P2 | Transit/multimodal routing |
| OR-Tools | ADOPT P1 | Generic optimization |
| VROOM | ADOPT P1/P2 | Dynamic VRP |
| PyVRP | CHALLENGER P2 | VRP benchmark |
| Timefold Solver | REFERENCE / POC | Scheduling/constraint solver |
| SUMO | ADOPT P1/P2 | Traffic/mobility simulation |
| Mesa | ADOPT P1/P2 | Generic agent-based simulation |
| CARLA | SPECIALIZED P3 | Autonomous-driving simulation |
| ARGUS Twin Model | BUILD P1/P2 | Canonical digital-twin abstraction |
| Eclipse Ditto | REFERENCE / OPTIONAL | IoT twin pattern/sidecar |
| Eclipse BaSyx | ADOPT STANDARD/REFERENCE | Industrial AAS interoperability |
| Orion-LD / NGSI-LD | REFERENCE | Context-data interoperability |
| ARGUS Scenario Engine | BUILD P1/P2 | What-if orchestration |
| ARGUS Impact Engine | BUILD P2 | Event-to-impact propagation |

## Forecast architecture

```text
World Memory
  -> Feature Builder
  -> ARGUS Forecast Contract
     -> StatsForecast baseline
     -> Darts experiment / ensemble
     -> NeuralForecast / MLForecast challengers
     -> foundation-model challengers
  -> Forecast Registry
  -> predicted_state
```

Every forecast stores model/version, data cutoff, horizon, uncertainty, backtest metrics and provenance.

No forecast is promoted without leakage-free OOS validation against naive/seasonal-naive and statistical baselines.

## Routing architecture

```text
ARGUS Route Contract
  -> Valhalla primary
  -> OSRM benchmark/fallback
  -> OpenTripPlanner transit
  -> route-cost matrix
     -> VROOM / OR-Tools optimization
```

Routing, route optimization and prediction remain separate layers.

## Simulation architecture

```text
Current world state
  + scenario assumptions
  + intervention
  -> ARGUS Scenario Engine
     -> SUMO
     -> Mesa
     -> OR-Tools / VROOM
     -> domain-specific model / AdaptiveTwin
  -> simulated_state
  -> impact metrics
```

Simulation output is never written as actual observation.

## Digital Twin model

ARGUS owns a generic twin abstraction with separate state classes:

- actual
- desired
- derived
- predicted
- simulated

External twin systems are adapters, not the core data model.

BaSyx/AAS is a strong industrial interoperability candidate.
Ditto is useful for IoT-device twin patterns.
NGSI-LD is a smart-city/context interoperability reference.

## Immediate PoC backlog

1. Forecast Contract + Registry
2. rolling-OOS statistical baseline benchmark
3. Valhalla route adapter
4. OSRM latency/route-quality benchmark
5. OR-Tools/VROOM optimization fixtures
6. Scenario Envelope + replayable Scenario Result
7. SUMO road-closure A/B scenario
8. Mesa seeded ABM fixture
9. Twin Model v0
10. BaSyx/AAS round-trip feasibility
11. foundation-model forecast benchmark after model-weight license review

## Institution-grade gates

Prediction:
- OOS validation
- calibration
- baseline superiority
- version/cutoff provenance
- rollback

Routing:
- data timestamp/license
- backend fallback
- latency/quality benchmark
- closure/cost provenance

Optimization:
- constraint provenance
- feasibility state
- objective/optimality gap
- reproducible seed when applicable

Simulation:
- explicit assumptions
- seed/version
- calibration status
- strict separation from observations

Twin:
- state-origin classification
- revision/history
- provenance
- command path separated from read-only intelligence

## Stage 5 result

**Stage 5 survey is complete.**

Primary direction:

```text
Forecast = ARGUS contract + baseline/challenger models
Routing = Valhalla primary + OSRM benchmark
Optimization = OR-Tools + VROOM
Simulation = SUMO + Mesa
Digital Twin = ARGUS-owned twin model
Interoperability = Ditto / BaSyx / NGSI-LD adapters
```

Next survey stage: **AI / RAG / Agent / Tool Orchestration**.
