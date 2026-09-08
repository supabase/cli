import { Command } from "effect/unstable/cli";

import {
  TEST_DB_DESCRIPTION,
  TEST_DB_SHORT,
  runTestDbCommand,
  testDbConfig,
} from "../../../command-internal/test-db.command-handler.ts";
import { testDbRuntimeLayer } from "../../../command-internal/test-db.layers.ts";

/**
 * `db test` is a hidden alias for `test db` (registered hidden by the
 * parent, `../db.command.ts`'s `dbTestCommand.pipe(Command.unlisted)`).
 *
 * `db test` and `test db` share one implementation, registered as two
 * separate commands with identical flags and Short text. The native TS port
 * mirrors that: both this file and `../../test/db/db.command.ts` import the
 * shared config/handler/runtime-layer from `command-internal/legacy-test-db.*`
 * instead of either command owning the implementation directly —
 * `commands/<family>/` files may not import another family's
 * internals (`code-structure.unit.test.ts`), so the implementation lives
 * outside `commands/` entirely.
 */
export const dbTestCommand = Command.make("test", testDbConfig).pipe(
  Command.withDescription(TEST_DB_DESCRIPTION),
  Command.withShortDescription(TEST_DB_SHORT),
  Command.withHandler(runTestDbCommand),
  // `["db", "test"]`, not `["test", "db"]`: the `cli_command_executed`
  // telemetry records the actual invoked command path, which differs by
  // entry point even though the handler is identical — see
  // `testDbRuntimeLayer`'s doc comment.
  Command.provide(testDbRuntimeLayer(["db", "test"])),
);
