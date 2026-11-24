import { Effect, Option } from "effect";
import { Argument, Command, Flag } from "effect/cli";

import { withTargetPolicy } from "../../../../../command-internal/target/target-policy.ts";
import { withJsonErrorHandling } from "../../../../../shared/output/json-error-handling.ts";
import { withCommandTelemetry } from "../../../../../telemetry/command-telemetry.ts";
import { sparkGenTypes } from "./types.handler.ts";
import { SparkApiError } from "../../spark-project.ts";
import {
  schema,
  sparkRuntimeLayer,
  sparkTargetFlags,
  withSparkTargetHelp,
} from "../../spark.flags.ts";

const genTypesConfig = {
  ...sparkTargetFlags(),
  schema,
  lang: Flag.Literals("lang", ["typescript"]).pipe(
    Flag.withDescription("Output language of the generated types."),
    Flag.withDefault("typescript"),
  ),
  language: Argument.String("language").pipe(Argument.optional),
} as const;

export const sparkGenTypesCommand = Command.make("types", genTypesConfig).pipe(
  Command.withDescription("Generates TypeScript types from the Spark project's schema."),
  Command.withShortDescription("Generate types from the Spark project"),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      if (Option.isSome(flags.language) && flags.language.value !== "typescript")
        return yield* new SparkApiError({
          message: `only typescript types are generated for a Spark project, not ${flags.language.value}`,
        });
      yield* sparkGenTypes(flags);
    }).pipe(
      withCommandTelemetry({
        flags: { lang: flags.lang, schema: flags.schema },
        aliases: { s: "schema" },
      }),
      withJsonErrorHandling,
    ),
  ),
  Command.provide(sparkRuntimeLayer(["gen", "types"])),
  withTargetPolicy({ group: "selectable", consent: "none", consentExemptReason: "read-only" }),
  withSparkTargetHelp,
);
