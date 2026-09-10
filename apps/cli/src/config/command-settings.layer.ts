import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { lastExplicitLongFlagValue } from "../shared/cli/cobra-flag-groups.ts";
import { CLI_VERSION } from "../shared/cli/version.ts";
import { ProfileFlag, WorkdirFlag } from "../command-internal/global-flags.ts";
import {
  loadProfile,
  type LoadedProfile,
  type ProfileLoadError,
} from "../command-internal/profile-load.ts";
import { DebugLogger, type DebugLoggerShape } from "../command-internal/debug-logger.service.ts";
import { RuntimeInfo } from "../shared/runtime/runtime-info.service.ts";
import { CommandSettings } from "./command-settings.service.ts";
import { profileFilePath } from "./profile-file.ts";

function unknownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves the profile: explicit `--profile` (last occurrence wins) → `SUPABASE_PROFILE` env →
 * persisted `~/.supabase/profile` file (trimmed) → `supabase`, then loads its token — failing
 * rather than silently falling back to the `supabase` profile's token.
 */
function resolveProfile(
  flagValue: string,
  explicitFlagValue: string | undefined,
  envValue: string | undefined,
  fs: FileSystem.FileSystem,
  path: Path.Path,
  homeDir: string,
  debugLogger: DebugLoggerShape,
): Effect.Effect<LoadedProfile, ProfileLoadError> {
  return Effect.gen(function* () {
    let token: string;
    if (explicitFlagValue !== undefined || flagValue !== "supabase") {
      const flag = explicitFlagValue ?? flagValue;
      yield* debugLogger.debug(`Loading profile from flag: ${flag}`);
      token = flag;
    } else if (envValue !== undefined && envValue.length > 0) {
      // Debug output can't distinguish an env value from an explicitly set flag; both log
      // the same message.
      yield* debugLogger.debug(`Loading profile from flag: ${envValue}`);
      token = envValue;
    } else {
      const filePath = profileFilePath(path, homeDir);
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

    return yield* loadProfile(token, fs);
  });
}

/**
 * Resolves `--workdir`/`SUPABASE_WORKDIR` to an absolute path: it may be given as a relative
 * string (e.g. `.`), but downstream readers such as the project-id cwd-basename fallback need
 * a real directory name, not a relative fragment that would sanitize to an empty project id.
 *
 * `explicit` is true only when the flag/env value was used verbatim, without walking up to find
 * `supabase/config.toml`; some config loads use it to skip a redundant ancestor search.
 */
export function resolveWorkdir(
  flagValue: Option.Option<string>,
  envValue: string | undefined,
  cwd: string,
  configTomlExists: (path: string) => Effect.Effect<boolean>,
  path: Path.Path,
): Effect.Effect<{ readonly workdir: string; readonly explicit: boolean }> {
  return Effect.gen(function* () {
    if (Option.isSome(flagValue) && flagValue.value.length > 0) {
      return { workdir: path.resolve(cwd, flagValue.value), explicit: true };
    }
    if (envValue !== undefined && envValue.length > 0) {
      return { workdir: path.resolve(cwd, envValue), explicit: true };
    }
    let current = cwd;
    while (true) {
      const candidate = path.join(current, "supabase", "config.toml");
      if (yield* configTomlExists(candidate)) {
        return { workdir: current, explicit: false };
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return { workdir: cwd, explicit: false };
      }
      current = parent;
    }
  });
}

export const commandSettingsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const profileFlag = yield* ProfileFlag;
    const workdirFlag = yield* WorkdirFlag;
    const debugLogger = yield* DebugLogger;

    return Layer.effect(
      CommandSettings,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtimeInfo = yield* RuntimeInfo;
        const env = process.env;

        // Optional service: tests without argv default to "not explicit". An empty command
        // path scans all of argv up to `--`, matching pflag.
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

        const { workdir, explicit: explicitWorkdir } = yield* resolveWorkdir(
          workdirFlag,
          env["SUPABASE_WORKDIR"],
          runtimeInfo.cwd,
          (filePath) => fs.exists(filePath).pipe(Effect.orElseSucceed(() => false)),
          path,
        );

        const userAgent = `SupabaseCLI/${CLI_VERSION}`;

        return CommandSettings.of({
          profile,
          apiUrl,
          projectHost,
          poolerHost,
          dashboardUrl,
          accessToken,
          projectId,
          workdir,
          explicitWorkdir,
          userAgent,
        });
      }),
    );
  }),
);
