import { Data, Effect, FileSystem, Predicate } from "effect";
import { parseDotEnv } from "./dotenv.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";

export class StackFunctionsEnvError extends Data.TaggedError("StackFunctionsEnvError")<{
  readonly message: string;
  readonly path: string;
  readonly cause?: unknown;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** Reads a Functions dotenv file and removes reserved Stack-provided variables. */
export const readStackFunctionsEnv = Effect.fn("StackFunctionsEnv.read")(function* (
  filePath: string,
  optional: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const contents = yield* fs.readFileString(filePath).pipe(
    Effect.catchTag("PlatformError", (error) =>
      optional && Predicate.isTagged(error.reason, "NotFound")
        ? Effect.succeed("")
        : Effect.fail(
            new StackFunctionsEnvError({
              path: filePath,
              message: `Unable to load environment file ${filePath}: ${error.message}`,
              cause: error,
            }),
          ),
    ),
  );
  const parsed = yield* Effect.try({
    try: () => parseDotEnv(contents),
    catch: (cause) =>
      new StackFunctionsEnvError({
        path: filePath,
        message: `Unable to parse environment file ${filePath}: ${cause instanceof Error ? cause.message : String(cause)}`,
        cause,
      }),
  });
  const env = Object.fromEntries(
    Object.entries(parsed).filter(([key]) => !key.startsWith("SUPABASE_")),
  );
  if (Object.keys(env).some((key) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)))
    return yield* new StackFunctionsEnvError({
      path: filePath,
      message: `Environment names in ${filePath} must start with a letter or underscore and contain only letters, digits, and underscores.`,
    });
  if (Object.values(env).some((value) => /[\0\r\n]/u.test(value)))
    return yield* new StackFunctionsEnvError({
      path: filePath,
      message: `Multiline environment values in ${filePath} are not supported by the stack backend.`,
    });
  return env;
});
