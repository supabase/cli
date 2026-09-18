import { Command } from "effect/unstable/cli";

import {
  TEST_DB_DESCRIPTION,
  TEST_DB_SHORT,
  runTestDbCommand,
  testDbConfig,
} from "../../../command-internal/test-db.command-handler.ts";
import { testDbRuntimeLayer } from "../../../command-internal/test-db.layers.ts";

/**
 * `db test` is a hidden alias for `test db`, registered hidden by the parent
 * (`../db.command.ts`'s `dbTestCommand.pipe(Command.unlisted)`). Both commands share one
 * implementation, hoisted to `command-internal/` since `commands/<family>/` files may not
 * import another family's internals (`code-structure.unit.test.ts`).
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
