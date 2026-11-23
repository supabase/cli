import { Layer } from "effect";
import { Command } from "effect/cli";

import { targetFlags } from "../../../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { stdinLayer } from "../../../../../shared/runtime/stdin.layer.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkMigrationFetch } from "./fetch.handler.ts";
import { sparkRuntimeLayer } from "../../spark.flags.ts";

const config = { ...targetFlags({ subject: "database", dbUrl: false }) } as const;

export const sparkMigrationFetchCommand = Command.make("fetch", config).pipe(
  Command.withDescription("Fetch migration files from the Spark project's migration history."),
  Command.withShortDescription("Fetch migration files from history table"),
  Command.withHandler((flags) =>
    sparkMigrationFetch(flags).pipe(withCommandTelemetry(), withJsonErrorHandling),
  ),
  Command.provide(Layer.mergeAll(sparkRuntimeLayer(["migration", "fetch"]), stdinLayer)),
  withTargetPolicy({
    group: "selectable",
    consent: "none",
    consentExemptReason: "reads the remote migration history and writes only local migration files",
  }),
);
