import { Command } from "effect/unstable/cli";

import {
  TEST_DB_DESCRIPTION,
  TEST_DB_SHORT,
  runTestDbCommand,
  testDbConfig,
} from "../../../command-internal/test-db.command-handler.ts";
import { testDbRuntimeLayer } from "../../../command-internal/test-db.layers.ts";

/**
 * `test db` — the visible entry point. Its hidden alias `db test`
 * (`../../db/test/test.command.ts`) reuses `testDbConfig` and
 * `runTestDbCommand` verbatim — the same implementation function
 * reused across two `Command` registrations. The implementation itself
 * lives in `command-internal/legacy-test-db.*` — see that module's doc
 * comment for why.
 */
export const testDbCommand = Command.make("db", testDbConfig).pipe(
  Command.withDescription(TEST_DB_DESCRIPTION),
  Command.withShortDescription(TEST_DB_SHORT),
  Command.withHandler(runTestDbCommand),
  Command.provide(testDbRuntimeLayer(["test", "db"])),
);
