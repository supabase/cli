import { Effect, FileSystem, Option, Path } from "effect";

import { resolveAgentMode } from "../../../../../command-internal/agent-mode.ts";
import { emitManagementApiRows } from "../../../../../command-internal/db/query-output.ts";
import { resolveQueryFormat, sqlPreview } from "../../../../../command-internal/db/query.format.ts";
import { AgentFlag, OutputFlag } from "../../../../../command-internal/global-flags.ts";
import { requireTargetMutationConsent } from "../../../../../command-internal/hosted-consent/hosted-consent.ts";
import type { TargetFlagValues } from "../../../../../command-internal/target/target-flags.ts";
import { CommandSettings } from "../../../../../config/command-settings.service.ts";
import { Output } from "../../../../../shared/output/output.service.ts";
import { Stdin } from "../../../../../shared/runtime/stdin.service.ts";
import { AiTool } from "../../../../../shared/telemetry/ai-tool.service.ts";
import { TelemetryOutputFormat } from "../../../../../telemetry/telemetry-output-format.service.ts";
import { SparkApiError } from "../../spark-project.ts";
import { SparkTarget, withSparkTarget } from "../../spark-target.ts";

/** `supabase db query`: runs SQL on the local Spark server or a linked Spark project. */
export const sparkDbQuery = Effect.fn("spark.db.query")(function* (
  flags: TargetFlagValues & {
    readonly sql: Option.Option<string>;
    readonly file: Option.Option<string>;
    readonly readOnly: boolean;
  },
) {
  const output = yield* Output;
  const stdin = yield* Stdin;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* CommandSettings;
  const agentFlag = yield* AgentFlag;
  const outputFlag = yield* OutputFlag;
  const aiTool = yield* AiTool;
  const telemetryOutputFormat = yield* TelemetryOutputFormat;

  if (Option.isSome(flags.file) && Option.isSome(flags.sql)) {
    return yield* new SparkApiError({
      message: "Pass SQL as an argument or with --file, not both.",
    });
  }

  yield* withSparkTarget(flags, (target) =>
    Effect.gen(function* () {
      const spark = yield* SparkTarget;
      const sql = yield* Effect.gen(function* () {
        if (Option.isSome(flags.file)) {
          const filePath = path.resolve(settings.workdir, flags.file.value);
          return yield* fs.readFileString(filePath).pipe(
            Effect.mapError(
              (cause) =>
                new SparkApiError({
                  message: `failed to read SQL file: ${cause.message}`,
                  cause,
                }),
            ),
          );
        }
        if (Option.isSome(flags.sql)) return flags.sql.value;
        if (!stdin.isTTY) {
          const piped = yield* stdin.readPipedText;
          if (Option.isNone(piped)) {
            return yield* new SparkApiError({ message: "no SQL provided via stdin" });
          }
          return piped.value;
        }
        return yield* new SparkApiError({
          message: "no SQL query provided. Pass SQL as an argument, via --file, or pipe to stdin",
        });
      });

      const agentMode = resolveAgentMode(agentFlag, aiTool.name);
      const format = resolveQueryFormat(
        Option.getOrUndefined(outputFlag),
        output.format,
        agentMode,
      );
      // Mirrors the resolved format onto the global telemetry reads, or instrumentation would
      // report the table default as `text`.
      yield* telemetryOutputFormat.set(format);
      yield* Effect.annotateCurrentSpan({
        "db.conn_type": target.kind,
        "query.format": format,
        "query.agent_mode": agentMode,
        "query.read_only": flags.readOnly,
      });

      // No client-side read-only keyword check: Spark owns SQL semantics, so its parser decides
      // and the server answers 25006 for a write.
      if (!flags.readOnly)
        yield* requireTargetMutationConsent(target, {
          action: "Run a SQL statement",
          readOnlyAlternative: true,
          details: [`sql: ${sqlPreview(sql)}`],
        });
      const body = yield* spark.runQuery(sql, flags.readOnly);
      yield* emitManagementApiRows(
        body,
        format,
        agentMode,
        (message) => new SparkApiError({ message }),
      );
    }),
  );
});
