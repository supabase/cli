import { Command } from "effect/cli";

import { withPermissions } from "../../../command-internal/command-permissions/command-permissions.annotation.ts";
import { compose } from "../../../command-internal/command-permissions/model.ts";
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
import { branchResolution } from "../../../command-internal/target/branch-resolution.ts";
import { withTargetPolicy } from "../../../command-internal/target/target-policy.ts";

/** Hidden alias of `test db`; the shared implementation lives in `command-internal/` because command families may not import each other's internals. */
export const dbTestCommand = Command.make("test", testDbConfig).pipe(
  Command.withDescription(TEST_DB_DESCRIPTION),
  Command.withShortDescription(TEST_DB_SHORT),
  withPermissions(compose(dbConfig, branchResolution)),
  Command.withHandler(runTestDbCommand),
  // `cli_command_executed` records the invoked path, so this entry point passes `["db", "test"]`.
  Command.provide(testDbRuntimeLayer(["db", "test"])),
  Command.provide(cliConfigValuesLayer),
  withCliConfigFlags(testDbConfig),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
