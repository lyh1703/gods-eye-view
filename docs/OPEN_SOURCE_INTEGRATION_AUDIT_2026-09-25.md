# ARGUS Open-Source Integration Audit — 2026-09-25

## Purpose

Record the 2026-09-25 survey of external OSINT / sensing / recon projects and convert it into a controlled ARGUS backlog without blindly merging third-party code.

ARGUS already uses the God's Eye View codebase as its spatial foundation. The current ARGUS layer already has:
- provider registry with license/commercial/attribution metadata;
- observation envelope with source/license/provenance fields;
- world query, entity, nearby and snapshot comparison operations.

Therefore the external projects below are treated as capability references, source catalogs, or isolated adapters rather than replacements for ARGUS.

## Adoption status

### World Monitor — source-catalog reference, high priority
Use as a discovery catalog for public/documented providers and capability gaps.
Do not copy AGPL application code into ARGUS core.
Candidate domains to diff against the ARGUS provider registry include:
- conflict / sanctions / geopolitical events;
- shipping, chokepoints, ports, pipelines and energy;
- aviation and military-flight context;
- disaster, weather and infrastructure;
- macro, market and cyber-risk context.

Action: periodically diff World Monitor's public source catalog against ARGUS provider coverage and evaluate providers independently.

Source: https://github.com/koala73/worldmonitor

### Crucix — sweep/delta/alert architecture reference, high priority
ARGUS already has snapshot comparison, so do not duplicate that mechanism.
Extract the missing operational concepts instead:
- scheduled multi-source sweep orchestration;
- semantic deduplication;
- severity tiers;
- source-health reporting;
- cross-source correlation;
- alert delivery policy.

Do not merge AGPL code into ARGUS core.

Source: https://github.com/calesthio/Crucix

### Fieldwatch — edge-sensor adapter candidate, high priority
Potential mobile edge sensor for receive-only Wi-Fi / BLE observations.
Integration boundary should be export/import only:
Fieldwatch export -> ARGUS normalizer -> Observation Envelope.

Important limitations:
- no Wi-Fi monitor mode;
- no cellular detection;
- no direction finding;
- location is handset location, not remote-radio location;
- detections/signatures are hypotheses, not identity findings.

Source: https://github.com/OffGridPete/Fieldwatch

### Web-Check — recon adapter candidate, high priority
Useful for passive/authorized web-asset context such as DNS, TLS, headers, hosting and technology metadata.
Implement only for owned/authorized targets and normalized observations.
Prefer an adapter boundary over embedding the whole application.

Source: https://github.com/Lissy93/web-check

### Ground Station — isolated satellite/RF sidecar, conditional
Useful only when ARGUS has an SDR/hardware track.
Keep outside ARGUS core because it has device privileges, RF dependencies and a larger security boundary.

Source: https://github.com/sgoudelis/ground-station

### PentAGI — isolated security-lab reference, conditional
Do not connect directly to general ARGUS actions.
Security-agent orchestration may be studied, but execution belongs in an explicitly authorized security lab / trust boundary.

Source: https://github.com/vxcontrol/pentagi

### Osiris — reference only
Useful for UI/source ideas but overlaps heavily with God's Eye View, World Monitor and Crucix.
No new core dependency planned.

Source: https://github.com/jukaben32/Osiris

## Adoption gates

A provider or external capability must pass all of the following before runtime integration:
1. clear source ownership and documented API/feed;
2. license and commercial-use status recorded;
3. attribution and retention requirements recorded;
4. provenance mapped into Observation Envelope;
5. rate limit and failure mode known;
6. replayable fixture or deterministic test;
7. source-health visibility;
8. no secrets committed;
9. user/privacy implications reviewed;
10. core-vs-sidecar boundary decided.

## Near-term backlog

P0
- World Monitor provider-catalog gap analysis against current ARGUS providers.
- Crucix gap analysis: identify only alert/orchestration features not already covered by ARGUS compare().
- Define a generic external-export ingestion contract for edge tools.

P1
- Fieldwatch export fixture and normalizer PoC.
- Web-Check authorized-target adapter PoC.
- Add source-health/status summary to provider execution results if missing.

P2
- Evaluate satellite/RF sidecar only after hardware/SDR need exists.
- Keep automated security tooling isolated until an authorized test environment exists.

## Non-goals

- no full replacement of ARGUS with another dashboard;
- no direct AGPL code merge into the ARGUS core;
- no unreviewed APK/tool installation;
- no active scanning or security testing against third-party systems;
- no duplicate implementation of capabilities ARGUS already has.
