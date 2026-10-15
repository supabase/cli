import { Command } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { withDbTarget } from "../../../command-internal/command-permissions/model.ts";
import { dbConfig } from "../../../command-internal/db-config.layer.ts";
import {
  TEST_DB_DESCRIPTION,
  TEST_DB_SHORT,
  runTestDbCommand,
  testDbConfig,
} from "../../../command-internal/test-db.command-handler.ts";
import { testDbRuntimeLayer } from "../../../command-internal/test-db.layers.ts";
import { cliConfigValuesLayer } from "../../../config/cli-config-values.layer.ts";
import { withCliConfigFlags } from "../../../config/cli-config-flags.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

/**
 * `test db` — the visible entry point. Its hidden alias `db test` reuses the same
 * `testDbConfig`/`runTestDbCommand` implementation across two `Command` registrations.
 */
export const testDbCommand = Command.make("db", testDbConfig).pipe(
  Command.withDescription(TEST_DB_DESCRIPTION),
  Command.withShortDescription(TEST_DB_SHORT),
  withPermissions(withDbTarget(dbConfig, { default: "local" })),
  Command.withHandler(runTestDbCommand),
  Command.provide(testDbRuntimeLayer(["test", "db"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(testDbConfig),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
