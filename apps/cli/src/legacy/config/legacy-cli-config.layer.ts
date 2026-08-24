import { Config, Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { lastExplicitLongFlagValue } from "../../shared/cli/cobra-flag-groups.ts";
import { CLI_VERSION } from "../../shared/cli/version.ts";
import { LegacyProfileFlag, LegacyWorkdirFlag } from "../../shared/legacy/global-flags.ts";
import {
  legacyLoadProfile,
  type LegacyLoadedProfile,
  type LegacyProfileLoadError,
} from "../shared/legacy-profile-load.ts";
import {
  LegacyDebugLogger,
  type LegacyDebugLoggerShape,
} from "../shared/legacy-debug-logger.service.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig } from "./legacy-cli-config.service.ts";
import { legacyProfileFilePath } from "./legacy-profile-file.ts";

function unknownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Profile resolution precedence: explicit `--profile` flag →
 * `SUPABASE_PROFILE` env → persisted `~/.supabase/profile` file →
 * `supabase` — then loads the token via `legacyLoadProfile`, failing instead
 * of falling back to the built-in `supabase` profile, which silently
 * targeted the wrong keyring token and API (supabase/cli#6091).
 *
 * `explicitFlagValue` mirrors pflag: the LAST explicit `--profile` occurrence
 * wins (the Effect parser is first-wins), and an explicit `--profile supabase`
 * shadows env and file even at the default value, which the parsed value
 * alone cannot detect. The persisted file's content is trimmed — a deliberate
 * divergence from the raw file bytes, compensated by the sso pflag
 * reconciliation (`legacy-pflag-reconcile.ts`).
 */
function resolveProfile(
  flagValue: string,
  explicitFlagValue: string | undefined,
  envValue: string | undefined,
  configuredHome: string | undefined,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  homeDir: string,
  debugLogger: LegacyDebugLoggerShape,
): Effect.Effect<LegacyLoadedProfile, LegacyProfileLoadError> {
  return Effect.gen(function* () {
    let token: string;
    if (explicitFlagValue !== undefined || flagValue !== "supabase") {
      const flag = explicitFlagValue ?? flagValue;
      yield* debugLogger.debug(`Loading profile from flag: ${flag}`);
      token = flag;
    } else if (envValue !== undefined && envValue.length > 0) {
      // Go reads SUPABASE_PROFILE through viper's PROFILE key, so debug output
      // cannot distinguish env from an explicitly changed flag.
      yield* debugLogger.debug(`Loading profile from flag: ${envValue}`);
      token = envValue;
    } else {
      // Lowest precedence: the persisted `~/.supabase/profile` file.
      const filePath = legacyProfileFilePath(path, homeDir, configuredHome);
      const content = yield* fs.readFileString(filePath).pipe(
        Effect.tap(() => debugLogger.debug(`Loading profile from file: ${filePath}`)),
        Effect.map(Option.some),
        Effect.catch((error) =>
          debugLogger.debug(unknownMessage(error)).pipe(Effect.as(Option.none<string>())),
        ),
      );
      token = Option.match(content, {
        onNone: () => "supabase",
        onSome: (value) => {
          const trimmed = value.trim();
          return trimmed.length === 0 ? "supabase" : trimmed;
        },
      });
    }

    return yield* legacyLoadProfile(token, fs);
  });
}

/**
 * `--workdir`/`SUPABASE_WORKDIR` can be a relative string (e.g. `.`), but
 * every later reader of the resolved workdir (including the
 * `Config.ProjectId` cwd-basename default, run on every config load) must
 * see the real ABSOLUTE directory, never the raw configured string. This
 * resolves the flag/env value against the real process `cwd`, so
 * `LegacyCliConfig.workdir` is always absolute — the invariant that
 * basename-ing it (e.g. `legacyResolveLocalProjectId`'s workdir-basename
 * fallback) operates on a real directory name, not a relative-path fragment
 * like `.` (which would sanitize to an empty project id and build a bare,
 * all-projects-matching Docker label filter).
 */
function resolveWorkdir(
  flagValue: Option.Option<string>,
  envValue: string | undefined,
  cwd: string,
  configTomlExists: (path: string) => Effect.Effect<boolean>,
  path: Path.Path,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    if (Option.isSome(flagValue) && flagValue.value.length > 0) {
      return path.resolve(cwd, flagValue.value);
    }
    if (envValue !== undefined && envValue.length > 0) {
      return path.resolve(cwd, envValue);
    }
    let current = cwd;
    // Walk up until we hit a directory containing supabase/config.toml or the FS root.
    while (true) {
      const candidate = path.join(current, "supabase", "config.toml");
      if (yield* configTomlExists(candidate)) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return cwd;
      }
      current = parent;
    }
  });
}

export const legacyCliConfigLayer = Layer.unwrap(
  Effect.gen(function* () {
    const profileFlag = yield* LegacyProfileFlag;
    const workdirFlag = yield* LegacyWorkdirFlag;
    const debugLogger = yield* LegacyDebugLogger;

    return Layer.effect(
      LegacyCliConfig,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtimeInfo = yield* RuntimeInfo;
        const profileEnv = yield* Config.option(Config.string("SUPABASE_PROFILE"));
        const supabaseHomeEnv = yield* Config.option(Config.string("SUPABASE_HOME"));
        const accessTokenEnv = yield* Config.option(Config.string("SUPABASE_ACCESS_TOKEN"));
        const projectIdEnv = yield* Config.option(Config.string("SUPABASE_PROJECT_ID"));
        const workdirEnv = yield* Config.option(Config.string("SUPABASE_WORKDIR"));

        // `serviceOption`: tests without argv default to "not explicit". The
        // empty command path scans all of argv up to `--`, like pflag.
        const cliArgs = yield* Effect.serviceOption(CliArgs);
        const explicitProfileFlag = Option.match(cliArgs, {
          onNone: () => undefined,
          onSome: ({ args }) => lastExplicitLongFlagValue(args, [], "profile"),
        });

        const {
          name: profile,
          apiUrl,
          projectHost,
          poolerHost,
          dashboardUrl,
        } = yield* resolveProfile(
          profileFlag,
          explicitProfileFlag,
          Option.getOrUndefined(profileEnv),
          Option.getOrUndefined(supabaseHomeEnv),
          fs,
          path,
          runtimeInfo.homeDir,
          debugLogger,
        );

        const rawAccessToken = Option.getOrUndefined(accessTokenEnv);
        const accessToken =
          rawAccessToken === undefined || rawAccessToken.length === 0
            ? Option.none<Redacted.Redacted<string>>()
            : Option.some(Redacted.make(rawAccessToken, { label: "SUPABASE_ACCESS_TOKEN" }));

        const rawProjectId = Option.getOrUndefined(projectIdEnv);
        const projectId =
          rawProjectId === undefined || rawProjectId.length === 0
            ? Option.none<string>()
            : Option.some(rawProjectId);

        const workdir = yield* resolveWorkdir(
          workdirFlag,
          Option.getOrUndefined(workdirEnv),
          runtimeInfo.cwd,
          (filePath) => fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)),
          path,
        );

        const userAgent = `SupabaseCLI/${CLI_VERSION}`;

        return LegacyCliConfig.of({
          profile,
          apiUrl,
          projectHost,
          poolerHost,
          dashboardUrl,
          accessToken,
          projectId,
          workdir,
          userAgent,
        });
      }),
    );
  }),
);
