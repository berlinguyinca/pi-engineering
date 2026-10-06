/**
 * The state migrations this runtime ships (spec §26).
 *
 * Schema 1 is the format `.pi-eng` state had when versioning was introduced,
 * so there is nothing to migrate yet. A future change to persisted state adds
 * `vN-vN+1.ts` here, bumps `piEngineering.stateSchema` in package.json and
 * RUNTIME_STATE_SCHEMA, and adds a test that runs the migration on a fixture
 * store.
 *
 * The updater loads this module from the CANDIDATE runtime: the code that
 * knows how to reach a new schema is the code that introduced it.
 */

import type { StateMigration } from "./framework.ts";

export const migrations: readonly StateMigration[] = [];
