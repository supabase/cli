import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { explicitBooleanLongFlag } from "../../shared/cli/cobra-flag-groups.ts";
import { Output } from "../../shared/output/output.service.ts";
import { IsolatedShadowProvisioner } from "../../shared/schema/isolated-shadow.service.ts";
import { SchemaEngineError } from "../../shared/schema/schema-errors.ts";
import { wrapShadowReplayOutput } from "../../shared/schema/shadow-replay-output.ts";
import { LegacyCliConfig } from "../config/legacy-cli-config.service.ts";
import { legacyReadDbToml } from "../shared/legacy-db-config.toml-read.ts";
import {
  legacyResolvePgDeltaProjectId,
  type LegacyPgDeltaContext,
} from "../shared/legacy-pgdelta.ts";
import { LegacyPgDeltaNextShadow } from "../commands/db/shared/legacy-pgdelta-next-shadow.service.ts";
import type { LegacyPgDeltaNextShadowInput } from "../commands/db/shared/legacy-pgdelta-next-shadow.service.ts";
import type { LegacyDeclarativeShadowDbError } from "../commands/db/shared/legacy-pgdelta.errors.ts";

const LEGACY_SHADOW_DAEMON_HINT = "Start Docker Desktop or Podman, then retry.";
const LEGACY_SHADOW_RESTORE_HINT =
  "Retry the command. If it persists, delete ~/.supabase/cache/shadow-baseline and rerun.";
const LEGACY_SHADOW_RETRY_HINT = "Retry the command.";

/** True only for an existing-tar restore failure — a cold/create miss never uses these phrases. */
function isShadowBaselineRestoreFailure(message: string): boolean {
  return (
    message.includes("failed to restore shadow baseline") ||
    message.includes("failed to restore archive into container")
  );
}

export const legacyIsolatedShadowToEngineError = (error: LegacyDeclarativeShadowDbError) =>
  new SchemaEngineError({
    detail: error.message,
    suggestion:
      error.suggestion ??
      (error.docker === "daemon"
        ? LEGACY_SHADOW_DAEMON_HINT
        : isShadowBaselineRestoreFailure(error.message)
          ? LEGACY_SHADOW_RESTORE_HINT
          : LEGACY_SHADOW_RETRY_HINT),
  });

const tomlError = (cause: unknown) =>
  new SchemaEngineError({
    detail: cause instanceof Error ? cause.message : String(cause),
    suggestion: "Fix supabase/config.toml, then retry.",
  });

export const legacyDockerIsolatedShadowLayer = Layer.effect(
  IsolatedShadowProvisioner,
  Effect.gen(function* () {
    const shadows = yield* LegacyPgDeltaNextShadow;
    const output = yield* Output;
    const config = yield* LegacyCliConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const shadowInput = (): Effect.Effect<LegacyPgDeltaNextShadowInput, SchemaEngineError> =>
      Effect.gen(function* () {
        const toml = yield* legacyReadDbToml(fs, path, config.workdir, undefined, {
          validate: false,
          warnOnUnresolvedEnv: false,
        }).pipe(Effect.mapError(tomlError));
        const context: LegacyPgDeltaContext = {
          projectId: legacyResolvePgDeltaProjectId(config.projectId, toml, config.workdir),
          cwd: config.workdir,
          npmVersion: Option.getOrUndefined(toml.pgDelta.npmVersion),
          denoVersion: toml.denoVersion,
          projectEnv: toml.projectEnv,
        };
        return { context, toml } satisfies LegacyPgDeltaNextShadowInput;
      });

    return IsolatedShadowProvisioner.of({
      provision: Effect.gen(function* () {
        const opts = yield* shadowInput();
        const shadow = yield* shadows
          .provisionDeclarative(opts)
          .pipe(Effect.mapError(legacyIsolatedShadowToEngineError));
        return { url: shadow.declarativeUrl };
      }),
      provisionPlatform: Effect.gen(function* () {
        const opts = yield* shadowInput();
        const shadow = yield* shadows
          .provisionPlatform(opts)
          .pipe(Effect.mapError(legacyIsolatedShadowToEngineError));
        return { url: shadow.platformUrl };
      }),
      provisionMigrations: Effect.gen(function* () {
        const opts = yield* shadowInput();
        const wrapped = wrapShadowReplayOutput(output, {
          debug: explicitBooleanLongFlag(process.argv, "debug") === true,
        });
        // Isolated replay only; live db start / migrations apply stay unprefixed.
        const shadow = yield* shadows
          .provisionMigrations(opts, wrapped)
          .pipe(Effect.mapError(legacyIsolatedShadowToEngineError));
        return { url: shadow.migrationsUrl };
      }),
    });
  }),
);
