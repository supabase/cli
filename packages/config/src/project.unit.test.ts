import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, FileSystem, Path, Redacted, Scope } from "effect";
import { findProjectRootFor, loadProjectEnvironmentFor } from "./bun.ts";
import { loadProjectEnvironmentFor as loadProjectEnvironmentForNode } from "./node.ts";
import { ProjectConfigParseError, ProjectEnvParseError } from "./errors.ts";
import { vi } from "vitest";
import {
  findProjectPaths,
  loadProjectConfig,
  loadProjectEnvironment,
  resolveProjectSubtree,
  resolveProjectValue,
} from "./index.ts";
function runConfigProgram<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Effect.Effect<A, E> {
  return effect.pipe(Effect.provide(BunServices.layer));
}
const live = <A, E>(
  name: string,
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
) => it.effect(name, () => effect.pipe(Effect.provide(BunServices.layer)));
describe("project discovery and lazy env resolution", () => {
  live(
    "does not read ambient environment when the core loader has no baseEnv",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-core-env-",
      });
      yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "supabase", "config.toml"), 'project_id = "test"\n');

      const key = "SUPABASE_CONFIG_CORE_ENV_TEST";
      vi.stubEnv(key, "ambient-only");
      try {
        const projectEnv = yield* runConfigProgram(loadProjectEnvironment({ cwd }));
        expect(projectEnv?.values[key]).toBeUndefined();
        expect(projectEnv?.sources[key]).toBeUndefined();
      } finally {
        vi.unstubAllEnvs();
      }
    }),
  );

  live(
    "preserves an explicitly empty process environment value in Bun and Node facades",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-empty-env-",
      });
      yield* fs.makeDirectory(path.join(cwd, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(cwd, "supabase", "config.toml"), 'project_id = "test"\n');
      const key = "SUPABASE_CONFIG_EMPTY_ENV_TEST";
      yield* fs.writeFileString(path.join(cwd, "supabase", ".env"), `${key}=from-file\n`);

      vi.stubEnv(key, "");
      try {
        const [fromBun, fromNode] = yield* Effect.all([
          Effect.promise(() => loadProjectEnvironmentFor({ cwd })),
          Effect.promise(() => loadProjectEnvironmentForNode({ cwd })),
        ]);
        expect(fromBun?.values[key]).toBe("");
        expect(fromBun?.sources[key]).toBe("ambient");
        expect(fromNode?.values[key]).toBe("");
        expect(fromNode?.sources[key]).toBe("ambient");
      } finally {
        vi.unstubAllEnvs();
      }
    }),
  );

  live(
    "finds the nearest Supabase project upward",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const repoRoot = path.join(cwd, "repo");
      const packageRoot = path.join(repoRoot, "apps", "web");
      const nestedCwd = path.join(packageRoot, "src", "components");
      yield* fs.makeDirectory(path.join(repoRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(packageRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.makeDirectory(nestedCwd, {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(repoRoot, "supabase", "config.toml"),
        'project_id = "repo"\n',
      );
      yield* fs.writeFileString(
        path.join(packageRoot, "supabase", "config.toml"),
        'project_id = "web"\n',
      );
      const paths = yield* runConfigProgram(findProjectPaths(nestedCwd));
      expect(paths?.projectRoot).toBe(packageRoot);
      expect(paths?.supabaseDir).toBe(path.join(packageRoot, "supabase"));
      expect(paths?.configPath).toBe(path.join(packageRoot, "supabase", "config.toml"));
      expect(yield* Effect.promise(() => findProjectRootFor(nestedCwd))).toBe(packageRoot);
    }),
  );
  live(
    "search: false only checks cwd itself, matching Go's exact-workdir resolution",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Mirrors Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:238-257`):
      // an explicit workdir is used exactly as given, with no ancestor climb —
      // callers that already hold a Go-equivalent project root (e.g. the legacy
      // `stop`/`status` ports' `cliConfig.workdir`) pass `search: false` to avoid
      // picking up an unrelated ancestor project.
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const repoRoot = path.join(cwd, "repo");
      const packageRoot = path.join(repoRoot, "apps", "web");
      const nestedCwd = path.join(packageRoot, "src", "components");
      yield* fs.makeDirectory(path.join(repoRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.makeDirectory(nestedCwd, {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(repoRoot, "supabase", "config.toml"),
        'project_id = "repo"\n',
      );

      // nestedCwd has no supabase/ of its own; only an ancestor (repoRoot) does.
      const searched = yield* runConfigProgram(findProjectPaths(nestedCwd));
      expect(searched?.projectRoot).toBe(repoRoot);
      const unsearched = yield* runConfigProgram(
        findProjectPaths(nestedCwd, {
          search: false,
        }),
      );
      expect(unsearched).toBeNull();
      const configAtRepoRoot = yield* runConfigProgram(
        findProjectPaths(repoRoot, {
          search: false,
        }),
      );
      expect(configAtRepoRoot?.projectRoot).toBe(repoRoot);
      expect(
        yield* runConfigProgram(
          loadProjectConfig(nestedCwd, {
            search: false,
          }),
        ),
      ).toBeNull();
      expect(
        yield* runConfigProgram(
          loadProjectEnvironment({
            cwd: nestedCwd,
            search: false,
          }),
        ),
      ).toBeNull();
    }),
  );
  live(
    "climbs past a FILE named `supabase` in the starting directory instead of failing with ENOTDIR",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Go's getProjectRoot keeps climbing on any stat error
      // (apps/cli-go/internal/utils/misc.go:216-231) — a stray FILE named
      // `supabase` (not a directory) must read as "no config here", not crash.
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const nestedCwd = path.join(cwd, "child");
      yield* fs.makeDirectory(nestedCwd, {
        recursive: true,
      });
      yield* fs.writeFileString(path.join(nestedCwd, "supabase"), "not a directory\n");
      const paths = yield* runConfigProgram(findProjectPaths(nestedCwd));
      expect(paths).toBeNull();
    }),
  );
  live(
    "returns the parent's project when the starting directory has a FILE named `supabase` but the parent has a real config",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const child = path.join(cwd, "child");
      yield* fs.makeDirectory(path.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fs.makeDirectory(child, {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(cwd, "supabase", "config.toml"),
        'project_id = "parent"\n',
      );
      yield* fs.writeFileString(path.join(child, "supabase"), "not a directory\n");
      const paths = yield* runConfigProgram(findProjectPaths(child));
      expect(paths?.projectRoot).toBe(cwd);
      expect(paths?.configPath).toBe(path.join(cwd, "supabase", "config.toml"));
    }),
  );
  live(
    "loads env from the discovered supabase directory with the right precedence",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const repoRoot = path.join(cwd, "repo");
      const packageRoot = path.join(repoRoot, "apps", "web");
      const nestedCwd = path.join(packageRoot, "src");
      yield* fs.makeDirectory(path.join(repoRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.makeDirectory(path.join(packageRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.makeDirectory(nestedCwd, {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(repoRoot, "supabase", "config.toml"),
        'project_id = "repo"\n',
      );
      yield* fs.writeFileString(path.join(repoRoot, "supabase", ".env"), "ROOT_ONLY=repo\n");
      yield* fs.writeFileString(
        path.join(packageRoot, "supabase", "config.toml"),
        'project_id = "web"\n',
      );
      yield* fs.writeFileString(
        path.join(packageRoot, "supabase", ".env"),
        "SHARED_ONLY=from-env\nOVERRIDE_ME=from-env\n",
      );
      yield* fs.writeFileString(
        path.join(packageRoot, "supabase", ".env.local"),
        "LOCAL_ONLY=from-local\nOVERRIDE_ME=from-local\n",
      );
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: nestedCwd,
          baseEnv: {
            OVERRIDE_ME: "from-ambient",
            AMBIENT_ONLY: "from-ambient",
          },
        }),
      );
      expect(projectEnv).not.toBeNull();
      expect(projectEnv?.values.SHARED_ONLY).toBe("from-env");
      expect(projectEnv?.values.LOCAL_ONLY).toBe("from-local");
      expect(projectEnv?.values.AMBIENT_ONLY).toBe("from-ambient");
      expect(projectEnv?.values.OVERRIDE_ME).toBe("from-ambient");
      expect(projectEnv?.values.ROOT_ONLY).toBeUndefined();
      expect(projectEnv?.sources.OVERRIDE_ME).toBe("ambient");
      expect(projectEnv?.loadedPaths).toEqual([
        path.join(packageRoot, "supabase", ".env"),
        path.join(packageRoot, "supabase", ".env.local"),
      ]);
      const fromBun = yield* Effect.promise(() =>
        loadProjectEnvironmentFor({
          cwd: nestedCwd,
          baseEnv: {
            OVERRIDE_ME: "from-ambient",
          },
        }),
      );
      expect(fromBun?.paths.projectRoot).toBe(packageRoot);
    }),
  );
  live(
    "parses a multiline double-quoted .env value (godotenv/Go parity)",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      yield* fs.makeDirectory(path.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(cwd, "supabase", "config.toml"),
        'project_id = "ref_123"\n',
      );
      yield* fs.writeFileString(
        path.join(cwd, "supabase", ".env"),
        [
          'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
          "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumga",
          '-----END RSA PRIVATE KEY-----"',
          "OTHER=value",
          "",
        ].join("\n"),
      );
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd,
        }),
      );
      expect(projectEnv).not.toBeNull();
      expect(projectEnv?.values.PRIVATE_KEY).toBe(
        [
          "-----BEGIN RSA PRIVATE KEY-----",
          "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumga",
          "-----END RSA PRIVATE KEY-----",
        ].join("\n"),
      );
      expect(projectEnv?.values.OTHER).toBe("value");
    }),
  );
  live(
    "parses a multiline single-quoted .env value followed by a trailing comment",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      yield* fs.makeDirectory(path.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(cwd, "supabase", "config.toml"),
        'project_id = "ref_123"\n',
      );
      yield* fs.writeFileString(
        path.join(cwd, "supabase", ".env"),
        ["MULTI='line one", "line two' # trailing comment", "AFTER=ok", ""].join("\n"),
      );
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd,
        }),
      );
      expect(projectEnv).not.toBeNull();
      expect(projectEnv?.values.MULTI).toBe(["line one", "line two"].join("\n"));
      expect(projectEnv?.values.AFTER).toBe("ok");
    }),
  );
  live(
    "still fails a genuinely malformed .env line (not a multiline quote)",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      yield* fs.makeDirectory(path.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(cwd, "supabase", "config.toml"),
        'project_id = "ref_123"\n',
      );
      yield* fs.writeFileString(path.join(cwd, "supabase", ".env"), "!!!not-a-valid-line\n");
      const failure = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd,
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(failure)).toBe(true);
      if (Exit.isFailure(failure)) {
        expect(Cause.squash(failure.cause)).toBeInstanceOf(ProjectEnvParseError);
      }
    }),
  );
  live(
    "skipEnvLocal ignores .env.local entirely, matching Go's SUPABASE_ENV=test gate",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Go's `loadDefaultEnv` (`apps/cli-go/pkg/config/config.go:1243-1250`) omits
      // `.env.local` from its candidate filename list whenever `SUPABASE_ENV=test`,
      // so a malformed `.env.local` is invisible to Go in that mode. Callers that
      // reproduce this gate (`status`/`stop` handlers) pass `skipEnvLocal: true`.
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      yield* fs.makeDirectory(path.join(cwd, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(cwd, "supabase", "config.toml"),
        'project_id = "ref_123"\n',
      );
      yield* fs.writeFileString(path.join(cwd, "supabase", ".env"), "FROM_ENV=1\n");
      // Malformed — would normally throw ProjectEnvParseError.
      yield* fs.writeFileString(path.join(cwd, "supabase", ".env.local"), "!!!not-a-valid-line\n");
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd,
          skipEnvLocal: true,
        }),
      );
      expect(projectEnv).not.toBeNull();
      expect(projectEnv?.values.FROM_ENV).toBe("1");
      expect(projectEnv?.loadedPaths).toEqual([path.join(cwd, "supabase", ".env")]);

      // Without the flag, the same malformed file still fails as before.
      const failure = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd,
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(failure)).toBe(true);
      if (Exit.isFailure(failure)) {
        expect(Cause.squash(failure.cause)).toBeInstanceOf(ProjectEnvParseError);
      }
    }),
  );
  live(
    "leaves [api].auto_expose_new_tables unset by default and round-trips an explicit value",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"\n`,
      );
      const defaultLoaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      // Field is intentionally optional today so the implicit default can flip on 2026-05-30
      // without losing track of users who explicitly opted in either direction.
      expect(defaultLoaded!.config.api.auto_expose_new_tables).toBeUndefined();
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"\n\n[api]\nauto_expose_new_tables = false\n`,
      );
      const explicitFalse = yield* runConfigProgram(loadProjectConfig(projectRoot));
      expect(explicitFalse!.config.api.auto_expose_new_tables).toBe(false);
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"\n\n[api]\nauto_expose_new_tables = true\n`,
      );
      const explicitTrue = yield* runConfigProgram(loadProjectConfig(projectRoot));
      expect(explicitTrue!.config.api.auto_expose_new_tables).toBe(true);
    }),
  );
  live(
    "loads raw config without resolving explicit env() references",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(AUTH_JWT_SECRET)"

[auth.sms.twilio]
enabled = false
auth_token = "env(TWILIO_AUTH_TOKEN)"
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: projectRoot,
        }),
      );
      expect(loaded!.config.auth.jwt_secret).toBe("env(AUTH_JWT_SECRET)");
      expect(loaded!.config.auth.sms.twilio.auth_token).toBe("env(TWILIO_AUTH_TOKEN)");
      expect(projectEnv?.values.AUTH_JWT_SECRET).toBeUndefined();
    }),
  );
  live(
    "resolveProjectValue resolves explicit env() and redacts secret leaves",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(AUTH_JWT_SECRET)"
`,
      );
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", ".env"),
        "AUTH_JWT_SECRET=super-secret\n",
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: projectRoot,
        }),
      );
      const resolved = yield* runConfigProgram(
        resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret"),
      );
      expect(Redacted.isRedacted(resolved)).toBe(true);
      if (!Redacted.isRedacted(resolved)) {
        throw new Error("Expected auth.jwt_secret to be redacted.");
      }
      expect(Redacted.value(resolved)).toBe("super-secret");
    }),
  );
  live(
    "resolveProjectSubtree resolves nested records and remotes lazily",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[edge_runtime.secrets]
api_key = "env(EDGE_API_KEY)"

[remotes.preview]
project_id = "previewrefaaaaaaaaaa"

[remotes.preview.auth]
jwt_secret = "env(PREVIEW_JWT_SECRET)"
`,
      );
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", ".env"),
        "EDGE_API_KEY=edge-secret\nPREVIEW_JWT_SECRET=preview-secret\n",
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: projectRoot,
        }),
      );
      const edgeRuntime = yield* runConfigProgram(
        resolveProjectSubtree(loaded!.config.edge_runtime, projectEnv!, "edge_runtime"),
      );
      const previewRemote = yield* runConfigProgram(
        resolveProjectSubtree(loaded!.config.remotes.preview, projectEnv!, "remotes.preview"),
      );
      const edgeSecret = edgeRuntime.secrets?.api_key;
      expect(Redacted.isRedacted(edgeSecret)).toBe(true);
      if (!Redacted.isRedacted(edgeSecret)) {
        throw new Error("Expected edge_runtime.secrets.api_key to be redacted.");
      }
      expect(Redacted.value(edgeSecret)).toBe("edge-secret");
      const previewSecret = previewRemote!.auth.jwt_secret;
      expect(Redacted.isRedacted(previewSecret)).toBe(true);
      if (!Redacted.isRedacted(previewSecret)) {
        throw new Error("Expected remotes.preview.auth.jwt_secret to be redacted.");
      }
      expect(Redacted.value(previewSecret)).toBe("preview-secret");
    }),
  );
  live(
    "resolveProjectValue preserves env() literal when the env var is missing (Go parity)",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(MISSING_SECRET)"
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: projectRoot,
        }),
      );
      const resolved = yield* runConfigProgram(
        resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret"),
      );

      // Secret paths are normally redacted, but unresolved env() literals pass
      // through as plain strings so callers can see the missing reference.
      expect(Redacted.isRedacted(resolved)).toBe(false);
      expect(resolved).toBe("env(MISSING_SECRET)");
    }),
  );

  // Go's `LoadEnvHook` (`apps/cli-go/pkg/config/decode_hooks.go:19-24`) only
  // substitutes a non-empty env var (`len(env) > 0`) — a present-but-empty
  // dotenv line (`EMPTY_SECRET=`) is treated the same as an unset var, so the
  // literal `env(...)` reference is preserved rather than resolved to `""`.
  live(
    "resolveProjectValue preserves env() literal when the env var is present but empty (Go parity)",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[edge_runtime.secrets]
foo = "env(EMPTY_SECRET)"
`,
      );
      yield* fs.writeFileString(path.join(projectRoot, "supabase", ".env"), "EMPTY_SECRET=\n");
      const loaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: projectRoot,
        }),
      );
      const resolved = yield* runConfigProgram(
        resolveProjectValue(
          loaded!.config.edge_runtime.secrets!.foo,
          projectEnv!,
          "edge_runtime.secrets.foo",
        ),
      );
      expect(Redacted.isRedacted(resolved)).toBe(false);
      expect(resolved).toBe("env(EMPTY_SECRET)");
    }),
  );
  live(
    "resolveProjectSubtree preserves env() literals nested inside the selected subtree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth.sms.twilio]
enabled = false
auth_token = "env(MISSING_SECRET)"
`,
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: projectRoot,
        }),
      );
      const resolved = yield* runConfigProgram(
        resolveProjectSubtree(loaded!.config.auth.sms.twilio, projectEnv!, "auth.sms.twilio"),
      );
      expect(resolved.auth_token).toBe("env(MISSING_SECRET)");
    }),
  );
  live(
    "raw config validation still enforces enabled feature requirements",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth.sms.twilio]
enabled = true
account_sid = "AC123"
`,
      );
      const failure = yield* runConfigProgram(loadProjectConfig(projectRoot)).pipe(Effect.exit);
      expect(Exit.isFailure(failure)).toBe(true);
      if (Exit.isFailure(failure)) {
        expect(Cause.squash(failure.cause)).toBeInstanceOf(ProjectConfigParseError);
      }
    }),
  );

  // Pins the pre-PR-#5765 strict SCREAMING_SNAKE_CASE `env()` matcher as the
  // default for `resolveProjectValue`/`resolveProjectSubtree`, since `next/`
  // and `packages/stack` call these without ever passing `goViperCompat`.
  live(
    "resolveProjectValue does not resolve a lowercase-named env() reference by default",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(lowercase_secret)"
`,
      );
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", ".env"),
        "lowercase_secret=super-secret\n",
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: projectRoot,
        }),
      );
      const resolved = yield* runConfigProgram(
        resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret"),
      );
      expect(Redacted.isRedacted(resolved)).toBe(true);
      if (!Redacted.isRedacted(resolved)) {
        throw new Error("Expected auth.jwt_secret to be redacted.");
      }
      expect(Redacted.value(resolved)).toBe("env(lowercase_secret)");
    }),
  );
  live(
    "resolveProjectValue resolves a lowercase-named env() reference when goViperCompat is true",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({
        prefix: "supabase-project-config-",
      });
      const projectRoot = path.join(cwd, "repo");
      yield* fs.makeDirectory(path.join(projectRoot, "supabase"), {
        recursive: true,
      });
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(lowercase_secret)"
`,
      );
      yield* fs.writeFileString(
        path.join(projectRoot, "supabase", ".env"),
        "lowercase_secret=super-secret\n",
      );
      const loaded = yield* runConfigProgram(loadProjectConfig(projectRoot));
      const projectEnv = yield* runConfigProgram(
        loadProjectEnvironment({
          cwd: projectRoot,
        }),
      );
      const resolved = yield* runConfigProgram(
        resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret", {
          goViperCompat: true,
        }),
      );
      expect(Redacted.isRedacted(resolved)).toBe(true);
      if (!Redacted.isRedacted(resolved)) {
        throw new Error("Expected auth.jwt_secret to be redacted.");
      }
      expect(Redacted.value(resolved)).toBe("super-secret");
    }),
  );
});
