# Implementation status: pi-engineering tasks

Audited at `dcb86b1` (see `AUDIT.md`). Task ids come from the design spec section 6. "Status" is one of: `merged` (all of the task's pi-engineering issues are merged), `partial` (some are), `open` (none started; waiting on the prerequisite shown). PR and SHA columns are filled only for merged work.

| Task | Issue | Status | PR | SHA |
|---|---|---|---|---|
| T02 Verifier failure baseline | [#133](https://github.com/berlinguyinca/pi-engineering/issues/133) | merged | [#165](https://github.com/berlinguyinca/pi-engineering/pull/165) | `e0bb00e` |
| T06 local registry, cleanup, build budgets | [#142](https://github.com/berlinguyinca/pi-engineering/issues/142), [#143](https://github.com/berlinguyinca/pi-engineering/issues/143), [#144](https://github.com/berlinguyinca/pi-engineering/issues/144), [#145](https://github.com/berlinguyinca/pi-engineering/issues/145) | open (needs T08 shared protocol) | none | none |
| T10 modes, flags, recursion guard | [#136](https://github.com/berlinguyinca/pi-engineering/issues/136), [#137](https://github.com/berlinguyinca/pi-engineering/issues/137), [#138](https://github.com/berlinguyinca/pi-engineering/issues/138) | open (needs T08) | none | none |
| T11 adapter and external entry point | [#139](https://github.com/berlinguyinca/pi-engineering/issues/139), [#140](https://github.com/berlinguyinca/pi-engineering/issues/140), [#141](https://github.com/berlinguyinca/pi-engineering/issues/141) | open (needs T10) | none | none |
| T14 review, repair, merge flow | [#152](https://github.com/berlinguyinca/pi-engineering/issues/152) (done), [#153](https://github.com/berlinguyinca/pi-engineering/issues/153) | partial (reviewer family independence merged; merge-queue routing needs T02, T03, T11, T12) | [#166](https://github.com/berlinguyinca/pi-engineering/pull/166) | `dcb86b1` |
| T15 post-merge cleanup of owned resources | [#154](https://github.com/berlinguyinca/pi-engineering/issues/154) | open (needs T05, T06, T14) | none | none |
| T16 InferWeave capability mapping and qualified failover | [#155](https://github.com/berlinguyinca/pi-engineering/issues/155), [#156](https://github.com/berlinguyinca/pi-engineering/issues/156), [#157](https://github.com/berlinguyinca/pi-engineering/issues/157), [#158](https://github.com/berlinguyinca/pi-engineering/issues/158) | open (needs T27 schemas) | none | none |
| T18 saturation fault-injection test | [#159](https://github.com/berlinguyinca/pi-engineering/issues/159) | open (needs T16) | none | none |
| T24 canonical lifecycle map | [#134](https://github.com/berlinguyinca/pi-engineering/issues/134), [#135](https://github.com/berlinguyinca/pi-engineering/issues/135) | open (needs T08) | none | none |
| T25 test watchdog, quarantine, nextest, result cache | [#146](https://github.com/berlinguyinca/pi-engineering/issues/146), [#147](https://github.com/berlinguyinca/pi-engineering/issues/147), [#148](https://github.com/berlinguyinca/pi-engineering/issues/148), [#149](https://github.com/berlinguyinca/pi-engineering/issues/149) | open (needs T08) | none | none |
| T26 SHA-fenced merge queue, post-merge smoke | [#150](https://github.com/berlinguyinca/pi-engineering/issues/150), [#151](https://github.com/berlinguyinca/pi-engineering/issues/151) | open (needs T02 (merged), T24) | none | none |

## Enabling work merged alongside

| Issue | What | PR | SHA |
|---|---|---|---|
| [#160](https://github.com/berlinguyinca/pi-engineering/issues/160) | stop the `orchestrator-recovery` retry livelock | [#162](https://github.com/berlinguyinca/pi-engineering/pull/162) | `87ed91d` |
| [#131](https://github.com/berlinguyinca/pi-engineering/issues/131) | green `npm test` baseline | [#163](https://github.com/berlinguyinca/pi-engineering/pull/163) | `0a7bfbf` |
