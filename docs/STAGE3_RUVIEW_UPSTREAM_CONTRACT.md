# Stage 3 — RuView upstream runtime contract

ARGUS now recognizes two upstream RuView boundaries rather than relying only on its own deterministic CSI generator.

1. `RealtekCsiSnapshot` from RuView's sensing-server runtime, including `source=realtek_csi:simulated`, node/sequence/timestamp/channel/bandwidth/subcarrier/RSSI and bounded amplitude summaries.
2. `CsiData` from RuView's hardware bridge, including timestamp, node, antenna/subcarrier dimensions, amplitude/phase vectors and RF metadata.

The ARGUS adapter deliberately emits bounded observation metadata and does not retain raw CSI arrays in V0. This keeps the integration contract compatible with the Stage 3 privacy gate while allowing the next phase to connect an upstream RuView simulated runtime directly.
