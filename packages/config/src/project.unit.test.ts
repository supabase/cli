import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem, Path, Redacted, type Scope } from "effect";
import {
  findCliProjectRoot as findCliProjectRootFromBun,
  loadCliProjectEnvironment as loadCliProjectEnvironmentFromBun,
} from "./bun.ts";
import { CliConfigParseError, CliProjectEnvParseError } from "./errors.ts";
import {
  findCliProjectPaths,
  loadCliConfig,
  loadCliProjectEnvironment,
  resolveCliConfigSubtree,
  resolveCliConfigValue,
} from "./effect.ts";
import { resolveCliConfigValue as resolveCliConfigValueInternal } from "./internal.ts";

function makeTempProject() {
  return FileSystem.FileSystem.use((fs) =>
    fs.makeTempDirectoryScoped({ prefix: "supabase-project-config-" }),
  );
}

function runConfigEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | Scope.Scope>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(BunServices.layer)));
}

describe("project discovery and lazy env resolution", () => {
  test("finds the nearest Supabase project upward", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const repoRoot = join(cwd, "repo");
        const packageRoot = join(repoRoot, "apps", "web");
        const nestedCwd = join(packageRoot, "src", "components");

        yield* fs.makeDirectory(join(repoRoot, "supabase"), { recursive: true });
        yield* fs.makeDirectory(join(packageRoot, "supabase"), { recursive: true });
        yield* fs.makeDirectory(nestedCwd, { recursive: true });
        yield* fs.writeFileString(
          join(repoRoot, "supabase", "config.toml"),
          'project_id = "repo"\n',
        );
        yield* fs.writeFileString(
          join(packageRoot, "supabase", "config.toml"),
          'project_id = "web"\n',
        );

        const paths = yield* findCliProjectPaths(nestedCwd);

        expect(paths?.projectRoot).toBe(packageRoot);
        expect(paths?.supabaseDir).toBe(join(packageRoot, "supabase"));
        expect(paths?.configPath).toBe(join(packageRoot, "supabase", "config.toml"));
        expect(yield* Effect.promise(() => findCliProjectRootFromBun(nestedCwd))).toBe(packageRoot);
      }),
    ));

  test("search: false only checks cwd itself, matching Go's exact-workdir resolution", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const repoRoot = join(cwd, "repo");
        const packageRoot = join(repoRoot, "apps", "web");
        const nestedCwd = join(packageRoot, "src", "components");

        yield* fs.makeDirectory(join(repoRoot, "supabase"), { recursive: true });
        yield* fs.makeDirectory(nestedCwd, { recursive: true });
        yield* fs.writeFileString(
          join(repoRoot, "supabase", "config.toml"),
          'project_id = "repo"\n',
        );

        // nestedCwd has no supabase/ of its own; only an ancestor (repoRoot) does.
        const searched = yield* findCliProjectPaths(nestedCwd);
        expect(searched?.projectRoot).toBe(repoRoot);

        const unsearched = yield* findCliProjectPaths(nestedCwd, { search: false });
        expect(unsearched).toBeNull();

        const configAtRepoRoot = yield* findCliProjectPaths(repoRoot, { search: false });
        expect(configAtRepoRoot?.projectRoot).toBe(repoRoot);

        expect(yield* loadCliConfig(nestedCwd, { search: false })).toBeNull();
        expect(yield* loadCliProjectEnvironment({ cwd: nestedCwd, search: false })).toBeNull();
      }),
    ));

  test("climbs past a FILE named `supabase` in the starting directory instead of failing with ENOTDIR", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const nestedCwd = join(cwd, "child");

        yield* fs.makeDirectory(nestedCwd, { recursive: true });
        yield* fs.writeFileString(join(nestedCwd, "supabase"), "not a directory\n");

        const paths = yield* findCliProjectPaths(nestedCwd);

        expect(paths).toBeNull();
      }),
    ));

  test("returns the parent's project when the starting directory has a FILE named `supabase` but the parent has a real config", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const child = join(cwd, "child");

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.makeDirectory(child, { recursive: true });
        yield* fs.writeFileString(join(cwd, "supabase", "config.toml"), 'project_id = "parent"\n');
        yield* fs.writeFileString(join(child, "supabase"), "not a directory\n");

        const paths = yield* findCliProjectPaths(child);

        expect(paths?.projectRoot).toBe(cwd);
        expect(paths?.configPath).toBe(join(cwd, "supabase", "config.toml"));
      }),
    ));

  test("loads env from the discovered supabase directory with the right precedence", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const repoRoot = join(cwd, "repo");
        const packageRoot = join(repoRoot, "apps", "web");
        const nestedCwd = join(packageRoot, "src");

        yield* fs.makeDirectory(join(repoRoot, "supabase"), { recursive: true });
        yield* fs.makeDirectory(join(packageRoot, "supabase"), { recursive: true });
        yield* fs.makeDirectory(nestedCwd, { recursive: true });
        yield* fs.writeFileString(
          join(repoRoot, "supabase", "config.toml"),
          'project_id = "repo"\n',
        );
        yield* fs.writeFileString(join(repoRoot, "supabase", ".env"), "ROOT_ONLY=repo\n");
        yield* fs.writeFileString(
          join(packageRoot, "supabase", "config.toml"),
          'project_id = "web"\n',
        );
        yield* fs.writeFileString(
          join(packageRoot, "supabase", ".env"),
          "SHARED_ONLY=from-env\nOVERRIDE_ME=from-env\n",
        );
        yield* fs.writeFileString(
          join(packageRoot, "supabase", ".env.local"),
          "LOCAL_ONLY=from-local\nOVERRIDE_ME=from-local\n",
        );

        const projectEnv = yield* loadCliProjectEnvironment({
          cwd: nestedCwd,
          baseEnv: {
            OVERRIDE_ME: "from-ambient",
            AMBIENT_ONLY: "from-ambient",
          },
        });

        expect(projectEnv).not.toBeNull();
        expect(projectEnv?.values.SHARED_ONLY).toBe("from-env");
        expect(projectEnv?.values.LOCAL_ONLY).toBe("from-local");
        expect(projectEnv?.values.AMBIENT_ONLY).toBe("from-ambient");
        expect(projectEnv?.values.OVERRIDE_ME).toBe("from-ambient");
        expect(projectEnv?.values.ROOT_ONLY).toBeUndefined();
        expect(projectEnv?.sources.OVERRIDE_ME).toBe("ambient");
        expect(projectEnv?.loadedPaths).toEqual([
          join(packageRoot, "supabase", ".env"),
          join(packageRoot, "supabase", ".env.local"),
        ]);

        const fromBun = yield* Effect.promise(() =>
          loadCliProjectEnvironmentFromBun({
            cwd: nestedCwd,
            baseEnv: {
              OVERRIDE_ME: "from-ambient",
            },
          }),
        );

        expect(fromBun?.paths.projectRoot).toBe(packageRoot);
      }),
    ));

  test("parses a multiline double-quoted .env value (godotenv/Go parity)", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(join(cwd, "supabase", "config.toml"), 'project_id = "ref_123"\n');
        yield* fs.writeFileString(
          join(cwd, "supabase", ".env"),
          [
            'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
            "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumga",
            '-----END RSA PRIVATE KEY-----"',
            "OTHER=value",
            "",
          ].join("\n"),
        );

        const projectEnv = yield* loadCliProjectEnvironment({ cwd });

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
    ));

  test("parses a multiline single-quoted .env value followed by a trailing comment", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(join(cwd, "supabase", "config.toml"), 'project_id = "ref_123"\n');
        yield* fs.writeFileString(
          join(cwd, "supabase", ".env"),
          ["MULTI='line one", "line two' # trailing comment", "AFTER=ok", ""].join("\n"),
        );

        const projectEnv = yield* loadCliProjectEnvironment({ cwd });

        expect(projectEnv).not.toBeNull();
        expect(projectEnv?.values.MULTI).toBe(["line one", "line two"].join("\n"));
        expect(projectEnv?.values.AFTER).toBe("ok");
      }),
    ));

  test("still fails a genuinely malformed .env line (not a multiline quote)", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(join(cwd, "supabase", "config.toml"), 'project_id = "ref_123"\n');
        yield* fs.writeFileString(join(cwd, "supabase", ".env"), "!!!not-a-valid-line\n");

        expect(yield* Effect.flip(loadCliProjectEnvironment({ cwd }))).toBeInstanceOf(
          CliProjectEnvParseError,
        );
      }),
    ));

  test("skipEnvLocal ignores .env.local entirely, matching Go's SUPABASE_ENV=test gate", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();

        yield* fs.makeDirectory(join(cwd, "supabase"), { recursive: true });
        yield* fs.writeFileString(join(cwd, "supabase", "config.toml"), 'project_id = "ref_123"\n');
        yield* fs.writeFileString(join(cwd, "supabase", ".env"), "FROM_ENV=1\n");
        // Malformed — would normally throw CliProjectEnvParseError.
        yield* fs.writeFileString(join(cwd, "supabase", ".env.local"), "!!!not-a-valid-line\n");

        const projectEnv = yield* loadCliProjectEnvironment({ cwd, skipEnvLocal: true });

        expect(projectEnv).not.toBeNull();
        expect(projectEnv?.values.FROM_ENV).toBe("1");
        expect(projectEnv?.loadedPaths).toEqual([join(cwd, "supabase", ".env")]);

        expect(yield* Effect.flip(loadCliProjectEnvironment({ cwd }))).toBeInstanceOf(
          CliProjectEnvParseError,
        );
      }),
    ));

  test("leaves [api].auto_expose_new_tables unset by default and round-trips an explicit value", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"\n`,
        );

        const defaultLoaded = yield* loadCliConfig(projectRoot);
        expect(defaultLoaded!.config.api.auto_expose_new_tables).toBeUndefined();

        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"\n\n[api]\nauto_expose_new_tables = false\n`,
        );
        const explicitFalse = yield* loadCliConfig(projectRoot);
        expect(explicitFalse!.config.api.auto_expose_new_tables).toBe(false);

        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"\n\n[api]\nauto_expose_new_tables = true\n`,
        );
        const explicitTrue = yield* loadCliConfig(projectRoot);
        expect(explicitTrue!.config.api.auto_expose_new_tables).toBe(true);
      }),
    ));

  test("loads raw config without resolving explicit env() references", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
jwt_secret = "env(AUTH_JWT_SECRET)"

[auth.sms.twilio]
enabled = false
auth_token = "env(TWILIO_AUTH_TOKEN)"
`,
        );

        const loaded = yield* loadCliConfig(projectRoot);
        const projectEnv = yield* loadCliProjectEnvironment({ cwd: projectRoot });

        expect(loaded!.config.auth.jwt_secret).toBe("env(AUTH_JWT_SECRET)");
        expect(loaded!.config.auth.sms.twilio.auth_token).toBe("env(TWILIO_AUTH_TOKEN)");
        expect(projectEnv?.values.AUTH_JWT_SECRET).toBeUndefined();
      }),
    ));

  test("resolveCliConfigValue resolves explicit env() and redacts secret leaves", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
jwt_secret = "env(AUTH_JWT_SECRET)"
`,
        );
        yield* fs.writeFileString(
          join(projectRoot, "supabase", ".env"),
          "AUTH_JWT_SECRET=super-secret\n",
        );

        const loaded = yield* loadCliConfig(projectRoot);
        const projectEnv = yield* loadCliProjectEnvironment({ cwd: projectRoot });

        const resolved = yield* resolveCliConfigValue(
          loaded!.config.auth.jwt_secret,
          projectEnv!,
          "auth.jwt_secret",
        );

        expect(Redacted.isRedacted(resolved)).toBe(true);
        if (!Redacted.isRedacted(resolved)) {
          throw new Error("Expected auth.jwt_secret to be redacted.");
        }
        expect(Redacted.value(resolved)).toBe("super-secret");
      }),
    ));

  test("resolveCliConfigSubtree resolves nested records and remotes lazily", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
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
          join(projectRoot, "supabase", ".env"),
          "EDGE_API_KEY=edge-secret\nPREVIEW_JWT_SECRET=preview-secret\n",
        );

        const loaded = yield* loadCliConfig(projectRoot);
        const projectEnv = yield* loadCliProjectEnvironment({ cwd: projectRoot });

        const edgeRuntime = yield* resolveCliConfigSubtree(
          loaded!.config.edge_runtime,
          projectEnv!,
          "edge_runtime",
        );
        const previewRemote = yield* resolveCliConfigSubtree(
          loaded!.config.remotes.preview,
          projectEnv!,
          "remotes.preview",
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
    ));

  test("resolveCliConfigValue preserves env() literal when the env var is missing (Go parity)", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
jwt_secret = "env(MISSING_SECRET)"
`,
        );

        const loaded = yield* loadCliConfig(projectRoot);
        const projectEnv = yield* loadCliProjectEnvironment({ cwd: projectRoot });

        const resolved = yield* resolveCliConfigValue(
          loaded!.config.auth.jwt_secret,
          projectEnv!,
          "auth.jwt_secret",
        );

        expect(Redacted.isRedacted(resolved)).toBe(false);
        expect(resolved).toBe("env(MISSING_SECRET)");
      }),
    ));

  test("resolveCliConfigValue preserves env() literal when the env var is present but empty (Go parity)", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"

[edge_runtime.secrets]
foo = "env(EMPTY_SECRET)"
`,
        );
        yield* fs.writeFileString(join(projectRoot, "supabase", ".env"), "EMPTY_SECRET=\n");

        const loaded = yield* loadCliConfig(projectRoot);
        const projectEnv = yield* loadCliProjectEnvironment({ cwd: projectRoot });

        const resolved = yield* resolveCliConfigValue(
          loaded!.config.edge_runtime.secrets!.foo,
          projectEnv!,
          "edge_runtime.secrets.foo",
        );

        expect(Redacted.isRedacted(resolved)).toBe(false);
        expect(resolved).toBe("env(EMPTY_SECRET)");
      }),
    ));

  test("resolveCliConfigSubtree preserves env() literals nested inside the selected subtree", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth.sms.twilio]
enabled = false
auth_token = "env(MISSING_SECRET)"
`,
        );

        const loaded = yield* loadCliConfig(projectRoot);
        const projectEnv = yield* loadCliProjectEnvironment({ cwd: projectRoot });

        const resolved = yield* resolveCliConfigSubtree(
          loaded!.config.auth.sms.twilio,
          projectEnv!,
          "auth.sms.twilio",
        );

        expect(resolved.auth_token).toBe("env(MISSING_SECRET)");
      }),
    ));

  test("raw config validation still enforces enabled feature requirements", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth.sms.twilio]
enabled = true
account_sid = "AC123"
`,
        );

        expect(yield* Effect.flip(loadCliConfig(projectRoot))).toBeInstanceOf(CliConfigParseError);
      }),
    ));

  test("resolveCliConfigValue does not resolve a lowercase-named env() reference by default", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
jwt_secret = "env(lowercase_secret)"
`,
        );
        yield* fs.writeFileString(
          join(projectRoot, "supabase", ".env"),
          "lowercase_secret=super-secret\n",
        );

        const loaded = yield* loadCliConfig(projectRoot);
        const projectEnv = yield* loadCliProjectEnvironment({ cwd: projectRoot });

        const resolved = yield* resolveCliConfigValue(
          loaded!.config.auth.jwt_secret,
          projectEnv!,
          "auth.jwt_secret",
        );

        expect(Redacted.isRedacted(resolved)).toBe(true);
        if (!Redacted.isRedacted(resolved)) {
          throw new Error("Expected auth.jwt_secret to be redacted.");
        }
        expect(Redacted.value(resolved)).toBe("env(lowercase_secret)");
      }),
    ));

  test("resolveCliConfigValue resolves a lowercase-named env() reference when goViperCompat is true", () =>
    runConfigEffect(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { join } = yield* Path.Path;
        const cwd = yield* makeTempProject();
        const projectRoot = join(cwd, "repo");

        yield* fs.makeDirectory(join(projectRoot, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(projectRoot, "supabase", "config.toml"),
          `project_id = "ref_123"

[auth]
jwt_secret = "env(lowercase_secret)"
`,
        );
        yield* fs.writeFileString(
          join(projectRoot, "supabase", ".env"),
          "lowercase_secret=super-secret\n",
        );

        const loaded = yield* loadCliConfig(projectRoot);
        const projectEnv = yield* loadCliProjectEnvironment({ cwd: projectRoot });

        const resolved = yield* resolveCliConfigValueInternal(
          loaded!.config.auth.jwt_secret,
          projectEnv!,
          "auth.jwt_secret",
          { goViperCompat: true },
        );

        expect(Redacted.isRedacted(resolved)).toBe(true);
        if (!Redacted.isRedacted(resolved)) {
          throw new Error("Expected auth.jwt_secret to be redacted.");
        }
        expect(Redacted.value(resolved)).toBe("super-secret");
      }),
    ));
});
