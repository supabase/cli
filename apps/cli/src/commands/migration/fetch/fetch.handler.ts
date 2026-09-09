import { Effect } from "effect";

import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import { runMigrationFetch } from "../../../command-internal/migration-fetch-run.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { MigrationFetchFlags } from "./fetch.command.ts";

export const migrationFetch = Effect.fn("migration.fetch")(function* (flags: MigrationFetchFlags) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveDbTargetFlags(cliArgs.args);
  const outcome = yield* runMigrationFetch({ flags, target, assumeYes: undefined }).pipe(
    Effect.ensuring(telemetryState.flush),
  );

  // Silent on success in text mode.
  if (output.format !== "text") {
    yield* output.success("Migration history fetched", { files: outcome.files });
  }
});
