import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { CLI_VERSION } from "../../shared/cli/version.ts";
import { LegacyProfileFlag, LegacyWorkdirFlag } from "../../shared/legacy/global-flags.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig, type LegacyProfileName } from "./legacy-cli-config.service.ts";

const PROFILE_API_URLS: Record<LegacyProfileName, string> = {
  supabase: "https://api.supabase.com",
  "supabase-staging": "https://api.supabase.green",
  "supabase-local": "http://localhost:8080",
};

const KNOWN_PROFILES: ReadonlySet<string> = new Set(Object.keys(PROFILE_API_URLS));

function resolveProfileName(flagValue: string, envValue: string | undefined): LegacyProfileName {
  const candidate = flagValue !== "supabase" ? flagValue : (envValue ?? "supabase");
  if (KNOWN_PROFILES.has(candidate)) {
    return candidate as LegacyProfileName;
  }
  return "supabase";
}

function resolveWorkdir(
  flagValue: Option.Option<string>,
  envValue: string | undefined,
  cwd: string,
  configTomlExists: (path: string) => Effect.Effect<boolean>,
  path: Path.Path,
): Effect.Effect<string> {
  return Effect.gen(function* () {
    if (Option.isSome(flagValue) && flagValue.value.length > 0) {
      return flagValue.value;
    }
    if (envValue !== undefined && envValue.length > 0) {
      return envValue;
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

    return Layer.effect(
      LegacyCliConfig,
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const runtimeInfo = yield* RuntimeInfo;
        const env = process.env;

        const profile = resolveProfileName(profileFlag, env["SUPABASE_PROFILE"]);
        const apiUrl = PROFILE_API_URLS[profile];

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
          accessToken,
          projectId,
          workdir,
          userAgent,
        });
      }),
    );
  }),
);
