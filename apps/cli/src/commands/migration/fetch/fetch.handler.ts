import { Effect } from "effect";

import { runMigrationFetch } from "../../../command-internal/migration-fetch-run.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { MigrationFetchFlags } from "./fetch.command.ts";

export const migrationFetch = Effect.fn("migration.fetch")(function* (flags: MigrationFetchFlags) {
  const output = yield* Output;
  const telemetryState = yield* TelemetryState;
  const target = yield* resolveTarget(flags);
  const outcome = yield* runMigrationFetch({ target }).pipe(Effect.ensuring(telemetryState.flush));
  yield* Effect.annotateCurrentSpan({ "file.count": outcome.files.length });

  // Silent on success in text mode.
  if (output.format !== "text") {
    yield* output.success("Migration history fetched", { files: outcome.files });
  }
});
