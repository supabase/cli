import { Layer } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { QUERY_OUTPUT_FORMATS } from "../../../../../command-internal/output-formats.ts";
import { randomLayer } from "../../../../../shared/runtime/random.layer.ts";
import { stdinLayer } from "../../../../../shared/runtime/stdin.layer.ts";
import { aiToolLayer } from "../../../../../shared/telemetry/ai-tool.layer.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { telemetryOutputFormatLayer } from "../../../../../telemetry/telemetry-output-format.layer.ts";
import { targetFlags } from "../../../../../command-internal/target/target-flags.ts";
import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { sparkRuntimeLayer } from "../../spark.flags.ts";
import { sparkDbQuery } from "./query.handler.ts";

const config = {
  sql: Argument.String("sql").pipe(
    Argument.withDescription("SQL query to execute."),
    Argument.optional,
  ),
  ...targetFlags({ subject: "database", dbUrl: false }),
  file: Flag.String("file").pipe(
    Flag.withAlias("f"),
    Flag.withDescription("Path to a SQL file to execute."),
    Flag.optional,
  ),
  readOnly: Flag.Boolean("read-only").pipe(
    Flag.withDescription(
      "Asks the project to refuse any statement that writes; a linked project needs no confirmation.",
    ),
    Flag.withDefault(false),
  ),
} as const;

export const sparkDbQueryCommand = Command.make("query", config).pipe(
  Command.withDescription("Execute a SQL query against the Spark project."),
  Command.withShortDescription("Execute a SQL query against the Spark project"),
  Command.withHandler((flags) =>
    sparkDbQuery(flags).pipe(
      withCommandTelemetry({
        flags: { file: flags.file, "read-only": flags.readOnly },
        outputFormats: QUERY_OUTPUT_FORMATS,
        aliases: { f: "file" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(
    Layer.mergeAll(
      sparkRuntimeLayer(["db", "query"]),
      randomLayer,
      aiToolLayer,
      stdinLayer,
      telemetryOutputFormatLayer,
    ),
  ),
  withTargetPolicy({ group: "selectable", consent: "no" }),
);
