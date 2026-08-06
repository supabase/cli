import { Command } from "effect/unstable/cli";

import {
  LEGACY_TEST_DB_DESCRIPTION,
  LEGACY_TEST_DB_SHORT,
  legacyRunTestDbCommand,
  legacyTestDbConfig,
} from "../../../shared/legacy-test-db.command-handler.ts";
import { legacyTestDbRuntimeLayer } from "../../../shared/legacy-test-db.layers.ts";

/**
 * `db test` is a hidden Go-parity alias for `test db` (registered hidden by
 * the parent, `../db.command.ts`'s `legacyDbTestCommand.pipe(Command.withHidden)`,
 * matching cobra's `Hidden: true` on `dbTestCmd`, `apps/cli-go/cmd/db.go:423`).
 *
 * Go itself defines `db test`'s `RunE` first (`cmd/db.go:422-429`, calling
 * `test.Run` directly) and then has `test db` borrow it verbatim
 * (`cmd/test.go:19-20`: `RunE: dbTestCmd.RunE`) — one implementation, two
 * cobra.Command registrations with identical flags and Short text. The native
 * TS port mirrors that: both this file and `../../test/db/db.command.ts`
 * import the shared config/handler/runtime-layer from
 * `legacy/shared/legacy-test-db.*` instead of either command owning the
 * implementation directly — `legacy/commands/<family>/` files may not import
 * another family's internals (`code-structure.unit.test.ts`), so the
 * implementation lives outside `legacy/commands/` entirely (CLI-1962).
 */
export const legacyDbTestCommand = Command.make("test", legacyTestDbConfig).pipe(
  Command.withDescription(LEGACY_TEST_DB_DESCRIPTION),
  Command.withShortDescription(LEGACY_TEST_DB_SHORT),
  Command.withHandler(legacyRunTestDbCommand),
  // `["db", "test"]`, not `["test", "db"]`: Go's `cli_command_executed`
  // telemetry records the actual invoked `cmd.CommandPath()`
  // (`cmd/root_analytics.go:33`), which differs by entry point even though
  // `RunE` is identical — see `legacyTestDbRuntimeLayer`'s doc comment.
  Command.provide(legacyTestDbRuntimeLayer(["db", "test"])),
);
