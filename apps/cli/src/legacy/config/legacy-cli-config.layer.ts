import { Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { parse as parseYaml } from "yaml";
import { CLI_VERSION } from "../../shared/cli/version.ts";
import { LegacyProfileFlag, LegacyWorkdirFlag } from "../../shared/legacy/global-flags.ts";
import { legacyProjectHost } from "../shared/legacy-profile.ts";
import { RuntimeInfo } from "../../shared/runtime/runtime-info.service.ts";
import { LegacyCliConfig, type LegacyProfileName } from "./legacy-cli-config.service.ts";

interface ResolvedProfile {
  readonly name: string;
  readonly apiUrl: string;
  readonly projectHost: string;
}

const BUILTIN_PROFILE_API_URLS: Record<LegacyProfileName, string> = {
  supabase: "https://api.supabase.com",
  "supabase-staging": "https://api.supabase.green",
  "supabase-local": "http://localhost:8080",
  snap: "https://cloudapi.snap.com",
};

function isBuiltinProfileName(value: string): value is LegacyProfileName {
  return value in BUILTIN_PROFILE_API_URLS;
}

// `projectHost` is sourced from `legacy-profile.ts` (the single source of truth that
// mirrors Go's `allProfiles` table and is also consumed by `branches get`), so the
// per-profile host mapping is not duplicated here.
function resolvedBuiltin(name: LegacyProfileName): ResolvedProfile {
  return {
    name,
    apiUrl: BUILTIN_PROFILE_API_URLS[name],
    projectHost: legacyProjectHost(name),
  };
}

function safeParseYaml(
  text: string,
): { name?: unknown; api_url?: unknown; project_host?: unknown } | undefined {
  try {
    const value = parseYaml(text);
    return value !== null && typeof value === "object"
      ? (value as { name?: unknown; api_url?: unknown; project_host?: unknown })
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolves the profile that produces the API URL. Mirrors Go's `LoadProfile`
 * (`apps/cli-go/internal/utils/profile.go:96-118`):
 *
 * 1. If the token matches a built-in profile name, use that.
 * 2. Otherwise treat the token as a path to a YAML config file with `api_url:`.
 * 3. Fall back to the `supabase` built-in if the file is missing or malformed.
 *
 * The cli-e2e harness depends on (2) — it writes a per-test YAML profile and
 * sets `SUPABASE_PROFILE=<that-path>` so both the Go and ts-legacy binaries
 * route requests to the local replay server. YAML profiles may also carry a
 * `project_host:` key (Go's `Profile.ProjectHost`); it defaults to `supabase.co`.
 */
function resolveProfile(
  flagValue: string,
  envValue: string | undefined,
  fs: FileSystem.FileSystem,
): Effect.Effect<ResolvedProfile> {
  return Effect.gen(function* () {
    const token = flagValue !== "supabase" ? flagValue : (envValue ?? "supabase");

    if (isBuiltinProfileName(token)) {
      return resolvedBuiltin(token);
    }

    const content = yield* fs.readFileString(token).pipe(Effect.option);
    if (Option.isNone(content)) return resolvedBuiltin("supabase");

    const parsed = safeParseYaml(content.value);
    if (parsed === undefined || typeof parsed.api_url !== "string") {
      return resolvedBuiltin("supabase");
    }
    return {
      name: typeof parsed.name === "string" ? parsed.name : "supabase",
      apiUrl: parsed.api_url,
      projectHost:
        typeof parsed.project_host === "string"
          ? parsed.project_host
          : legacyProjectHost("supabase"),
    };
  });
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

        const {
          name: profile,
          apiUrl,
          projectHost,
        } = yield* resolveProfile(profileFlag, env["SUPABASE_PROFILE"], fs);

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
          accessToken,
          projectId,
          workdir,
          userAgent,
        });
      }),
    );
  }),
);
