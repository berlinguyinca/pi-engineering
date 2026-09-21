# 14 — Migration and Rollback
0 inventory overlaps; 1 put legacy runtime behind AgentRuntime and pass contracts; 2 add Herdr behind feature flag; 3 parity/shadow/canary with no deletion; 4 selected Herdr workloads; 5 Herdr default after gates; 6 remove duplicate legacy runtime only after rollback drill and telemetry window. Keep DB migrations backward-compatible during dual-runtime operation.
