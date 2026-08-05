import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";
import { hasExplicitLongFlag } from "../../shared/cli/cobra-flag-groups.ts";
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
 * Mirrors Go's `getProfileName` precedence (`profile.go:121-136`) — explicit
 * `--profile` flag → `SUPABASE_PROFILE` env → persisted `~/.supabase/profile`
 * file → `supabase` — then loads the token via `legacyLoadProfile`, failing
 * like Go's `LoadProfile` (`profile.go:94-118`) instead of falling back to
 * the built-in `supabase` profile, which silently targeted the wrong keyring
 * token and API (supabase/cli#6091).
 *
 * `flagExplicit` mirrors pflag's `Changed`: an explicitly passed `--profile
 * supabase` shadows env and file even at the default value, which the parsed
 * value alone cannot detect. The persisted file's content is trimmed — a
 * deliberate divergence from Go's raw bytes, compensated by the sso pflag
 * reconciliation (`legacy-pflag-reconcile.ts`).
 */
function resolveProfile(
  flagValue: string,
  flagExplicit: boolean,
  envValue: string | undefined,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  homeDir: string,
  debugLogger: LegacyDebugLoggerShape,
): Effect.Effect<LegacyLoadedProfile, LegacyProfileLoadError> {
  return Effect.gen(function* () {
    let token: string;
    if (flagValue !== "supabase" || flagExplicit) {
      yield* debugLogger.debug(`Loading profile from flag: ${flagValue}`);
      token = flagValue;
    } else if (envValue !== undefined && envValue.length > 0) {
      // Go reads SUPABASE_PROFILE through viper's PROFILE key, so debug output
      // cannot distinguish env from an explicitly changed flag.
      yield* debugLogger.debug(`Loading profile from flag: ${envValue}`);
      token = envValue;
    } else {
      // Lowest precedence: the persisted `~/.supabase/profile` file (Go's
      // `getProfileName` file fallback, `profile.go:129-131`).
      const filePath = legacyProfileFilePath(path, homeDir);
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
 * Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:231-250`) always
 * `os.Chdir(workdir)`s using the raw `--workdir`/`SUPABASE_WORKDIR` string,
 * which can be relative (e.g. `.`) — but every later reader of the resolved
 * workdir (including the `Config.ProjectId` cwd-basename default, `Eject`,
 * `pkg/config/config.go:561-570`, run on every `Config.Load()` via
 * `mergeDefaultValues`, `config.go:690-699`) reads `os.Getwd()`, the real
 * ABSOLUTE directory, never the raw configured string. `os.Chdir(".")` is a
 * no-op syscall-wise, so Go's `cwd` is unaffected by the flag/env value being
 * relative. This resolves the flag/env value against the real process `cwd`
 * the same way, so `LegacyCliConfig.workdir` is always absolute — matching
 * Go's invariant that basename-ing it (e.g. `legacyResolveLocalProjectId`'s
 * workdir-basename fallback) operates on a real directory name, not a
 * relative-path fragment like `.` (which would sanitize to an empty project
 * id and build a bare, all-projects-matching Docker label filter).
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
        const env = process.env;

        // `serviceOption`: tests without argv default to "not explicit". The
        // empty command path scans all of argv up to `--`, like pflag.
        const cliArgs = yield* Effect.serviceOption(CliArgs);
        const profileFlagExplicit = Option.match(cliArgs, {
          onNone: () => false,
          onSome: ({ args }) => hasExplicitLongFlag(args, [], "profile"),
        });

        const {
          name: profile,
          apiUrl,
          projectHost,
          poolerHost,
          dashboardUrl,
        } = yield* resolveProfile(
          profileFlag,
          profileFlagExplicit,
          env["SUPABASE_PROFILE"],
          fs,
          path,
          runtimeInfo.homeDir,
          debugLogger,
        );

        const rawAccessToken = env["SUPABASE_ACCESS_TOKEN"];
        const accessToken =
          rawAccessToken === undefined || rawAccessToken.length === 0
            ? Option.none<Redacted.Redacted<string>>()
            : Option.some(Redacted.make(rawAccessToken, { label: "SUPABASE_ACCESS_TOKEN" }));

        const rawProjectId = env["SUPABASE_PROJECT_ID"];
        const projectId =
          rawProjectId === undefined || rawProjectId.length === 0
            ? Option.none<string>()
            : Option.some(rawProjectId);

        const workdir = yield* resolveWorkdir(
          workdirFlag,
          env["SUPABASE_WORKDIR"],
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
