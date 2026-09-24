# ARGUS GitHub Capability Survey — Stage 2

## Scope

Stage 2 covers **Spatiotemporal Storage / Entity / Knowledge**.

## Decisions

| Project | Decision | ARGUS role |
| --- | --- | --- |
| PostgreSQL + PostGIS | ADOPT P0/P1 | Canonical World Memory spatial store |
| MobilityDB | CONDITIONAL ADOPT P1/P2 | Moving-object trajectories |
| DuckDB + duckdb-spatial | ADOPT P1 | Offline analytics / replay |
| Apache Sedona | REFERENCE P3 | Distributed geospatial scale-out |
| TimescaleDB | CONDITIONAL / REFERENCE | Time-series optimization after license/perf evidence |
| Apache AGE | POC P1/P2 | Property-graph queries inside PostgreSQL |
| Neo4j | REFERENCE | Mature graph ecosystem; not initial core |
| Memgraph | REFERENCE / REJECT INITIAL | Real-time graph benchmark; license/ops overhead |
| Oxigraph | OPTIONAL POC | RDF/SPARQL semantic graph |
| pgvector | ADOPT P1/P2 | Semantic retrieval beside canonical evidence |
| Qdrant | REFERENCE / SCALE-OUT | Dedicated vector DB if pgvector is insufficient |
| Splink | POC P1/P2 | Probabilistic entity resolution |
| dedupe | REFERENCE | Entity-resolution challenger |
| OpenLineage | ADOPT CONCEPT/SCHEMA P1 | Ingestion/data lineage |

## Canonical architecture

```text
PostgreSQL
  + PostGIS
  + ARGUS entity/event relational model
  + pgvector (optional semantic index)
  + OpenLineage-compatible lineage metadata

DuckDB + spatial -> replay / analysis / batch inspection

Conditional:
  + MobilityDB -> trajectory workloads
  + Apache AGE -> graph traversal
  + Splink -> batch entity resolution

Scale-out only after evidence:
  + Apache Sedona
  + Qdrant
  + dedicated graph DB
  + Timescale-specific features
```

## World Memory initial schema candidates

- providers
- ingestion_runs
- source_artifacts
- entities
- entity_aliases
- entity_relations
- observations
- events
- event_entities
- lineage_edges
- watch_rules

For high-volume observations/events, use time partitioning.

## Separation rules

### Canonical evidence

PostgreSQL/PostGIS stores observations, events, source references, and authoritative spatial/time metadata.

### Derived knowledge

Entity relationships, summaries, graph edges, and derived event links remain traceable to canonical evidence.

### Semantic index

Embeddings never replace evidence. Vector results must resolve back to entity/event/source identifiers.

### Personal memory

GPT Brain personal/project memory remains logically and physically separated from ARGUS World Memory.

### Replay/research

DuckDB/GeoParquet and fixtures are used for fast local replay and data-quality experiments.

## Immediate PoC backlog

1. World Memory schema ADR
2. PostGIS-backed `world.history()` repository contract
3. canonical entity / alias / relation model
4. pgvector embedding boundary
5. Splink entity-resolution fixture benchmark
6. Apache AGE feasibility test against relational edge tables

## Stage 2 result

**Stage 2 survey is complete.**

Primary decision: use **PostgreSQL + PostGIS** as the initial World Memory source of truth and add specialized extensions/services only when measured requirements justify them.

Next survey stage: **Earth Observation / Sensor / Mobility Data**.
