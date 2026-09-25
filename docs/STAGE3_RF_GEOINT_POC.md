# Stage 3 PoC — RF Spatial Sensing + GEOINT

## RF Spatial Sensing
- RuView-compatible CSI frame validation for amplitude/phase, timestamp, node ID and RSSI.
- Deterministic 56-subcarrier simulated CSI generator.
- Conversion to privacy-bounded ARGUS observation records.
- No person identification, biometric inference, or raw CSI retention in the V0 observation.
- Live/biometric claims remain gated until real controlled-room calibration.

## GEOINT
- Optional Python sidecar invokes GeoCLIP and returns top-k coordinate candidates.
- JavaScript adapter normalizes candidates into ARGUS records.
- Results are candidate-only and must be corroborated with authorized map/satellite/user-provided context.
- Do not use the PoC to identify or track private persons.
