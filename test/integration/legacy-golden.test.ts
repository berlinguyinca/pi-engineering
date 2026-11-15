/**
 * Parity gate over the legacy implementation (OMP unification, Phase 3).
 *
 * Each scenario in `scenarios` is rendered through the path named by PARITY_PATH
 * (default `legacy`; an unknown name fails loudly) and compared byte for byte with
 * test/fixtures/legacy-golden/<command>-<scenario>.golden.json.
 * UPDATE_GOLDEN=1 rewrites the files (legacy path only, never in CI); commit that
 * diff on purpose.
 */

import { resolvePath, runParity } from "../support/legacyGolden.ts";

runParity(resolvePath(process.env.PARITY_PATH));
