# ARGUS GitHub Capability Survey — Stage 6

## Scope

Stage 6 covers **AI / RAG / Agent / Tool Orchestration**.

Reviewed:
LangGraph, LlamaIndex, Haystack, PydanticAI, OpenAI Agents SDK, AutoGen, Semantic Kernel, smolagents, CrewAI, Microsoft GraphRAG, official MCP SDK/reference servers, Temporal, Prefect, Dagster, GPT Researcher, browser-use, Promptfoo, DeepEval, Guardrails AI, Phoenix, Langfuse, NVIDIA garak and related candidates.

## Core design decision

ARGUS does not adopt one agent framework as its identity.

ARGUS owns:

- Agent Run schema
- Tool Capability Manifest
- policy/authorization
- evidence references
- budget limits
- approval gates
- tracing
- replay/promotion semantics

External frameworks remain replaceable adapters.

## Primary decisions

| Capability | Decision | ARGUS role |
| --- | --- | --- |
| ARGUS Agent Runtime Contract | BUILD P0/P1 | Canonical agent-run semantics |
| ARGUS Tool Capability Manifest | BUILD P0 | Tool policy/permission contract |
| MCP | ADOPT P0/P1 | External tool/resource protocol |
| MCP Python SDK | ADOPT P1 | Initial MCP implementation |
| MCP TypeScript SDK | OPTIONAL P1/P2 | JS/server-side MCP path |
| PydanticAI | POC P1 | Typed Python agent/tool adapter |
| OpenAI Agents SDK | OPTIONAL P1/P2 | High-capability model/agent adapter |
| LangGraph | POC P1/P2 | Stateful graph workflows |
| Haystack | POC P1/P2 | Modular RAG pipeline |
| LlamaIndex | SELECTIVE REFERENCE/POC | Connector/retrieval patterns |
| GraphRAG | REFERENCE ONLY | Graph-RAG methodology; maintenance mode |
| Temporal | ADOPT P1/P2 | Durable long-running workflow |
| Prefect | CONDITIONAL P1/P2 | Python/data workflows |
| Dagster | REFERENCE / OPTIONAL | Asset-centric orchestration |
| GPT Researcher | REFERENCE / POC | Research-loop benchmark |
| browser-use | OPTIONAL SANDBOX | Browser acquisition when APIs are absent |
| Promptfoo | ADOPT P1/P2 | Agent/RAG eval + red-team CI |
| DeepEval | POC P1/P2 | LLM/RAG quality metrics |
| garak | ADOPT P1/P2 TEST TOOL | LLM vulnerability scanning |
| Guardrails AI | OPTIONAL POC | Specialized validators |
| Phoenix | REFERENCE | ELv2 license constraint |
| Langfuse | OPTIONAL | LLM tracing/eval UI; OpenTelemetry stays canonical |

## MCP direction

Initial ARGUS MCP tools:

```text
world.query
world.entity
world.nearby
world.compare
world.history
world.anomaly
world.watch
world.route
world.forecast
world.scenario
```

MCP is only the transport/interface boundary.

Authorization remains ARGUS-owned.

The MCP reference-server repository explicitly describes its servers as educational/reference implementations rather than production-ready components, so ARGUS should use the official SDKs and build its own hardened servers.

## Agent Run envelope

Candidate fields:

- agent_run_id
- agent_type
- agent_version
- model_id
- model_provider
- objective
- input_context_refs
- allowed_tool_ids
- policy_profile
- token_budget
- cost_budget
- wall_time_budget
- max_tool_calls
- tool_call_ids
- evidence_ids
- output_schema_version
- confidence
- trace_id
- parent_run_id
- status / failure_reason

## Tool Capability Manifest

Candidate fields:

- tool_id
- tool_version
- input_schema
- output_schema
- side_effect_class
- read_only
- idempotent
- auth_scope
- data_classification
- network_scope
- rate_limit
- cost_class
- timeout
- retry_policy
- requires_human_approval
- provenance_behavior
- allowed_agent_roles

Initial side-effect classes:

- READ_ONLY
- DERIVED_WRITE
- EXTERNAL_WRITE
- SENSITIVE_ACTION

## Retrieval architecture

ARGUS owns a Retrieval Contract over:

- PostGIS spatial/entity evidence
- World Memory history
- pgvector semantic retrieval
- Knowledge Graph relations
- source artifacts
- events/forecasts/scenarios

Semantic similarity is **not** factual confidence.

All RAG results must retain source/evidence identifiers.

External retrieved text is treated as **untrusted data**, never as agent policy or system instruction.

## Durable execution

```text
short query/tool run
  -> normal ARGUS runtime

long/failure-sensitive run
  -> ARGUS Workflow Contract
  -> Temporal

Python-heavy scientific/data pipeline
  -> Prefect when justified
```

Framework-internal checkpoints never replace ARGUS canonical run/evidence records.

## Agent roles

Initial bounded roles:

- World Analyst
- Research Agent
- Watch Agent
- Scenario Analyst
- Data Quality Agent
- Capability Scout
- Project Bridge Analyst

Default policy is **single agent + tools**.

Sub-agents are only introduced for independent parallel work or proven context-isolation benefits.

## Security boundaries

External web/document/API text is untrusted evidence.

A retrieved source cannot:

- change system policy
- grant itself permissions
- expose secrets
- add new tools
- trigger external writes

Required controls:

- role/tool allowlists
- explicit auth scopes
- tool schemas
- network/domain allowlists
- time/token/cost/tool-call limits
- loop detection
- result-size limits
- circuit breakers
- approval gates for side effects
- secret isolation
- audit logs

## Self-extension policy

Capability Scout may:

- discover candidates
- perform license/security audits
- create sandbox PoCs
- generate patches/branches
- benchmark
- draft ADRs
- recommend promotion

It may not autonomously:

- merge production branches
- grant new permissions
- disable security policy
- write arbitrarily to external systems
- recursively spawn unbounded agents

## Immediate PoC backlog

1. Tool Capability Manifest
2. Agent Run Envelope
3. read-only ARGUS MCP Server v0
4. PydanticAI typed world.query adapter
5. LangGraph retrieve -> verify -> synthesize comparison
6. Temporal crash/restart durable-workflow test
7. hybrid Retrieval Contract
8. prompt-injection fixture corpus
9. agent eval CI using Promptfoo/DeepEval
10. garak security baseline
11. Research Agent benchmark

## Institution-grade gates

Agent/tool promotion requires:

- least privilege
- schema/version compatibility
- deterministic fixtures
- bounded resource consumption
- evidence completeness
- unsupported-claim threshold
- prompt-injection resistance
- secret-leakage tests
- permission-escalation tests
- crash/restart recovery for durable jobs
- full audit trail

## Stage 6 result

**Stage 6 survey is complete.**

Primary architecture:

```text
User / GPT Brain
  -> ARGUS Agent Gateway
  -> Policy + Tool Manifest
  -> ARGUS Agent Runtime
     -> PydanticAI adapter
     -> OpenAI Agents adapter
     -> LangGraph adapter
  -> MCP
  -> ARGUS-owned world/retrieval/forecast/scenario/watch tools
  -> Evidence Graph + Agent Run Record

Long workflows -> Temporal
Evaluation -> Promptfoo / DeepEval
Security testing -> garak
Observability -> OpenTelemetry
```

Next survey stage: **Institution-grade Reliability / Security / Governance**.
