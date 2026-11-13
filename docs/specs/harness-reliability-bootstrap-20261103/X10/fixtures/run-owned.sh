#!/bin/bash
# X10 cmd2: the files this series owns, plus the seams the merge conflict touched -- one node process per file.
# main's #457 verdict test exists under both test/unit and test/integration, so both are included.
cd "$(git rev-parse --show-toplevel)" || exit 70
exec node --test --test-concurrency=1 --test-force-exit --import ./test/support/isolatedState.ts \
  test/unit/git-common-dir-repair.test.ts \
  test/unit/resilience-default-off.test.ts \
  test/integration/resilient-inference-integration.test.ts \
  test/integration/resilient-inference-wiring.test.ts \
  test/integration/worker-stream-truncation.test.ts \
  test/integration/mission-interrupt-pause.test.ts \
  test/integration/mission-merge-queue-flow.test.ts \
  test/unit/worker-error-events.test.ts \
  test/unit/worker-assistant-verdict.test.ts \
  test/integration/worker-assistant-verdict.test.ts
