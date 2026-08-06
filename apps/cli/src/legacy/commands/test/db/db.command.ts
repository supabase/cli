import { Command } from "effect/unstable/cli";

import {
  LEGACY_TEST_DB_DESCRIPTION,
  LEGACY_TEST_DB_SHORT,
  legacyRunTestDbCommand,
  legacyTestDbConfig,
} from "../../../shared/legacy-test-db.command-handler.ts";
import { legacyTestDbRuntimeLayer } from "../../../shared/legacy-test-db.layers.ts";

/**
 * `test db` — the visible Go-parity entry point. Its hidden alias `db test`
 * (`../../db/test/test.command.ts`) reuses `legacyTestDbConfig` and
 * `legacyRunTestDbCommand` verbatim, mirroring Go's `cmd/test.go:19-20`
 * (`RunE: dbTestCmd.RunE`, the literal same function reused across two
 * `cobra.Command` registrations). The implementation itself lives in
 * `legacy/shared/legacy-test-db.*` — see that module's doc comment for why.
 */
export const legacyTestDbCommand = Command.make("db", legacyTestDbConfig).pipe(
  Command.withDescription(LEGACY_TEST_DB_DESCRIPTION),
  Command.withShortDescription(LEGACY_TEST_DB_SHORT),
  Command.withHandler(legacyRunTestDbCommand),
  Command.provide(legacyTestDbRuntimeLayer(["test", "db"])),
);
