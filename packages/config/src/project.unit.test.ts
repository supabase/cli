import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Path, Redacted } from "effect";
import { findProjectRootFor, loadProjectEnvironmentFor } from "./bun.ts";
import { ProjectConfigParseError, ProjectEnvParseError } from "./errors.ts";
import {
  findProjectPaths,
  loadProjectConfig,
  loadProjectEnvironment,
  resolveProjectSubtree,
  resolveProjectValue,
} from "./index.ts";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-project-config-"));
}

function runConfigEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
}

describe("project discovery and lazy env resolution", () => {
  test("finds the nearest Supabase project upward", async () => {
    const cwd = makeTempProject();
    const repoRoot = join(cwd, "repo");
    const packageRoot = join(repoRoot, "apps", "web");
    const nestedCwd = join(packageRoot, "src", "components");

    try {
      await mkdir(join(repoRoot, "supabase"), { recursive: true });
      await mkdir(join(packageRoot, "supabase"), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await writeFile(join(repoRoot, "supabase", "config.toml"), 'project_id = "repo"\n');
      await writeFile(join(packageRoot, "supabase", "config.toml"), 'project_id = "web"\n');

      const paths = await runConfigEffect(findProjectPaths(nestedCwd));

      expect(paths?.projectRoot).toBe(packageRoot);
      expect(paths?.supabaseDir).toBe(join(packageRoot, "supabase"));
      expect(paths?.configPath).toBe(join(packageRoot, "supabase", "config.toml"));
      expect(await findProjectRootFor(nestedCwd)).toBe(packageRoot);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("search: false only checks cwd itself, matching Go's exact-workdir resolution", async () => {
    // Mirrors Go's `ChangeWorkDir` (`apps/cli-go/internal/utils/misc.go:231-247`):
    // an explicit workdir is used exactly as given, with no ancestor climb —
    // callers that already hold a Go-equivalent project root (e.g. the legacy
    // `stop`/`status` ports' `cliConfig.workdir`) pass `search: false` to avoid
    // picking up an unrelated ancestor project.
    const cwd = makeTempProject();
    const repoRoot = join(cwd, "repo");
    const packageRoot = join(repoRoot, "apps", "web");
    const nestedCwd = join(packageRoot, "src", "components");

    try {
      await mkdir(join(repoRoot, "supabase"), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await writeFile(join(repoRoot, "supabase", "config.toml"), 'project_id = "repo"\n');

      // nestedCwd has no supabase/ of its own; only an ancestor (repoRoot) does.
      const searched = await runConfigEffect(findProjectPaths(nestedCwd));
      expect(searched?.projectRoot).toBe(repoRoot);

      const unsearched = await runConfigEffect(findProjectPaths(nestedCwd, { search: false }));
      expect(unsearched).toBeNull();

      const configAtRepoRoot = await runConfigEffect(findProjectPaths(repoRoot, { search: false }));
      expect(configAtRepoRoot?.projectRoot).toBe(repoRoot);

      expect(await runConfigEffect(loadProjectConfig(nestedCwd, { search: false }))).toBeNull();
      expect(
        await runConfigEffect(loadProjectEnvironment({ cwd: nestedCwd, search: false })),
      ).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loads env from the discovered supabase directory with the right precedence", async () => {
    const cwd = makeTempProject();
    const repoRoot = join(cwd, "repo");
    const packageRoot = join(repoRoot, "apps", "web");
    const nestedCwd = join(packageRoot, "src");

    try {
      await mkdir(join(repoRoot, "supabase"), { recursive: true });
      await mkdir(join(packageRoot, "supabase"), { recursive: true });
      await mkdir(nestedCwd, { recursive: true });
      await writeFile(join(repoRoot, "supabase", "config.toml"), 'project_id = "repo"\n');
      await writeFile(join(repoRoot, "supabase", ".env"), "ROOT_ONLY=repo\n");
      await writeFile(join(packageRoot, "supabase", "config.toml"), 'project_id = "web"\n');
      await writeFile(
        join(packageRoot, "supabase", ".env"),
        "SHARED_ONLY=from-env\nOVERRIDE_ME=from-env\n",
      );
      await writeFile(
        join(packageRoot, "supabase", ".env.local"),
        "LOCAL_ONLY=from-local\nOVERRIDE_ME=from-local\n",
      );

      const projectEnv = await runConfigEffect(
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
        join(packageRoot, "supabase", ".env"),
        join(packageRoot, "supabase", ".env.local"),
      ]);

      const fromBun = await loadProjectEnvironmentFor({
        cwd: nestedCwd,
        baseEnv: {
          OVERRIDE_ME: "from-ambient",
        },
      });

      expect(fromBun?.paths.projectRoot).toBe(packageRoot);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses a multiline double-quoted .env value (godotenv/Go parity)", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "ref_123"\n');
      await writeFile(
        join(cwd, "supabase", ".env"),
        [
          'PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----',
          "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumga",
          '-----END RSA PRIVATE KEY-----"',
          "OTHER=value",
          "",
        ].join("\n"),
      );

      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd }));

      expect(projectEnv).not.toBeNull();
      expect(projectEnv?.values.PRIVATE_KEY).toBe(
        [
          "-----BEGIN RSA PRIVATE KEY-----",
          "MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumga",
          "-----END RSA PRIVATE KEY-----",
        ].join("\n"),
      );
      expect(projectEnv?.values.OTHER).toBe("value");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("parses a multiline single-quoted .env value followed by a trailing comment", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "ref_123"\n');
      await writeFile(
        join(cwd, "supabase", ".env"),
        ["MULTI='line one", "line two' # trailing comment", "AFTER=ok", ""].join("\n"),
      );

      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd }));

      expect(projectEnv).not.toBeNull();
      expect(projectEnv?.values.MULTI).toBe(["line one", "line two"].join("\n"));
      expect(projectEnv?.values.AFTER).toBe("ok");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("still fails a genuinely malformed .env line (not a multiline quote)", async () => {
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "ref_123"\n');
      await writeFile(join(cwd, "supabase", ".env"), "!!!not-a-valid-line\n");

      await expect(runConfigEffect(loadProjectEnvironment({ cwd }))).rejects.toBeInstanceOf(
        ProjectEnvParseError,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("skipEnvLocal ignores .env.local entirely, matching Go's SUPABASE_ENV=test gate", async () => {
    // Go's `loadDefaultEnv` (`apps/cli-go/pkg/config/config.go:1243-1250`) omits
    // `.env.local` from its candidate filename list whenever `SUPABASE_ENV=test`,
    // so a malformed `.env.local` is invisible to Go in that mode. Callers that
    // reproduce this gate (`status`/`stop` handlers) pass `skipEnvLocal: true`.
    const cwd = makeTempProject();

    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(join(cwd, "supabase", "config.toml"), 'project_id = "ref_123"\n');
      await writeFile(join(cwd, "supabase", ".env"), "FROM_ENV=1\n");
      // Malformed — would normally throw ProjectEnvParseError.
      await writeFile(join(cwd, "supabase", ".env.local"), "!!!not-a-valid-line\n");

      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd, skipEnvLocal: true }));

      expect(projectEnv).not.toBeNull();
      expect(projectEnv?.values.FROM_ENV).toBe("1");
      expect(projectEnv?.loadedPaths).toEqual([join(cwd, "supabase", ".env")]);

      // Without the flag, the same malformed file still fails as before.
      await expect(runConfigEffect(loadProjectEnvironment({ cwd }))).rejects.toBeInstanceOf(
        ProjectEnvParseError,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("leaves [api].auto_expose_new_tables unset by default and round-trips an explicit value", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(join(projectRoot, "supabase", "config.toml"), `project_id = "ref_123"\n`);

      const defaultLoaded = await runConfigEffect(loadProjectConfig(projectRoot));
      // Field is intentionally optional today so the implicit default can flip on 2026-05-30
      // without losing track of users who explicitly opted in either direction.
      expect(defaultLoaded!.config.api.auto_expose_new_tables).toBeUndefined();

      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"\n\n[api]\nauto_expose_new_tables = false\n`,
      );
      const explicitFalse = await runConfigEffect(loadProjectConfig(projectRoot));
      expect(explicitFalse!.config.api.auto_expose_new_tables).toBe(false);

      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"\n\n[api]\nauto_expose_new_tables = true\n`,
      );
      const explicitTrue = await runConfigEffect(loadProjectConfig(projectRoot));
      expect(explicitTrue!.config.api.auto_expose_new_tables).toBe(true);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("loads raw config without resolving explicit env() references", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(AUTH_JWT_SECRET)"

[auth.sms.twilio]
enabled = false
auth_token = "env(TWILIO_AUTH_TOKEN)"
`,
      );

      const loaded = await runConfigEffect(loadProjectConfig(projectRoot));
      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd: projectRoot }));

      expect(loaded!.config.auth.jwt_secret).toBe("env(AUTH_JWT_SECRET)");
      expect(loaded!.config.auth.sms.twilio.auth_token).toBe("env(TWILIO_AUTH_TOKEN)");
      expect(projectEnv?.values.AUTH_JWT_SECRET).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolveProjectValue resolves explicit env() and redacts secret leaves", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(AUTH_JWT_SECRET)"
`,
      );
      await writeFile(join(projectRoot, "supabase", ".env"), "AUTH_JWT_SECRET=super-secret\n");

      const loaded = await runConfigEffect(loadProjectConfig(projectRoot));
      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd: projectRoot }));

      const resolved = await runConfigEffect(
        resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret"),
      );

      expect(Redacted.isRedacted(resolved)).toBe(true);
      if (!Redacted.isRedacted(resolved)) {
        throw new Error("Expected auth.jwt_secret to be redacted.");
      }
      expect(Redacted.value(resolved)).toBe("super-secret");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolveProjectSubtree resolves nested records and remotes lazily", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
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
      await writeFile(
        join(projectRoot, "supabase", ".env"),
        "EDGE_API_KEY=edge-secret\nPREVIEW_JWT_SECRET=preview-secret\n",
      );

      const loaded = await runConfigEffect(loadProjectConfig(projectRoot));
      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd: projectRoot }));

      const edgeRuntime = await runConfigEffect(
        resolveProjectSubtree(loaded!.config.edge_runtime, projectEnv!, "edge_runtime"),
      );
      const previewRemote = await runConfigEffect(
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
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolveProjectValue preserves env() literal when the env var is missing (Go parity)", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(MISSING_SECRET)"
`,
      );

      const loaded = await runConfigEffect(loadProjectConfig(projectRoot));
      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd: projectRoot }));

      const resolved = await runConfigEffect(
        resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret"),
      );

      // Secret paths are normally redacted, but unresolved env() literals pass
      // through as plain strings so callers can see the missing reference.
      expect(Redacted.isRedacted(resolved)).toBe(false);
      expect(resolved).toBe("env(MISSING_SECRET)");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // Go's `LoadEnvHook` (`apps/cli-go/pkg/config/decode_hooks.go:19-24`) only
  // substitutes a non-empty env var (`len(env) > 0`) — a present-but-empty
  // dotenv line (`EMPTY_SECRET=`) is treated the same as an unset var, so the
  // literal `env(...)` reference is preserved rather than resolved to `""`.
  test("resolveProjectValue preserves env() literal when the env var is present but empty (Go parity)", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[edge_runtime.secrets]
foo = "env(EMPTY_SECRET)"
`,
      );
      await writeFile(join(projectRoot, "supabase", ".env"), "EMPTY_SECRET=\n");

      const loaded = await runConfigEffect(loadProjectConfig(projectRoot));
      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd: projectRoot }));

      const resolved = await runConfigEffect(
        resolveProjectValue(
          loaded!.config.edge_runtime.secrets!.foo,
          projectEnv!,
          "edge_runtime.secrets.foo",
        ),
      );

      expect(Redacted.isRedacted(resolved)).toBe(false);
      expect(resolved).toBe("env(EMPTY_SECRET)");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolveProjectSubtree preserves env() literals nested inside the selected subtree", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth.sms.twilio]
enabled = false
auth_token = "env(MISSING_SECRET)"
`,
      );

      const loaded = await runConfigEffect(loadProjectConfig(projectRoot));
      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd: projectRoot }));

      const resolved = await runConfigEffect(
        resolveProjectSubtree(loaded!.config.auth.sms.twilio, projectEnv!, "auth.sms.twilio"),
      );

      expect(resolved.auth_token).toBe("env(MISSING_SECRET)");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("raw config validation still enforces enabled feature requirements", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth.sms.twilio]
enabled = true
account_sid = "AC123"
`,
      );

      await expect(runConfigEffect(loadProjectConfig(projectRoot))).rejects.toBeInstanceOf(
        ProjectConfigParseError,
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  // Pins the pre-PR-#5765 strict SCREAMING_SNAKE_CASE `env()` matcher as the
  // default for `resolveProjectValue`/`resolveProjectSubtree`, since `next/`
  // and `packages/stack` call these without ever passing `goViperCompat`.
  test("resolveProjectValue does not resolve a lowercase-named env() reference by default", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(lowercase_secret)"
`,
      );
      await writeFile(join(projectRoot, "supabase", ".env"), "lowercase_secret=super-secret\n");

      const loaded = await runConfigEffect(loadProjectConfig(projectRoot));
      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd: projectRoot }));

      const resolved = await runConfigEffect(
        resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret"),
      );

      expect(Redacted.isRedacted(resolved)).toBe(true);
      if (!Redacted.isRedacted(resolved)) {
        throw new Error("Expected auth.jwt_secret to be redacted.");
      }
      expect(Redacted.value(resolved)).toBe("env(lowercase_secret)");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolveProjectValue resolves a lowercase-named env() reference when goViperCompat is true", async () => {
    const cwd = makeTempProject();
    const projectRoot = join(cwd, "repo");

    try {
      await mkdir(join(projectRoot, "supabase"), { recursive: true });
      await writeFile(
        join(projectRoot, "supabase", "config.toml"),
        `project_id = "ref_123"

[auth]
jwt_secret = "env(lowercase_secret)"
`,
      );
      await writeFile(join(projectRoot, "supabase", ".env"), "lowercase_secret=super-secret\n");

      const loaded = await runConfigEffect(loadProjectConfig(projectRoot));
      const projectEnv = await runConfigEffect(loadProjectEnvironment({ cwd: projectRoot }));

      const resolved = await runConfigEffect(
        resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret", {
          goViperCompat: true,
        }),
      );

      expect(Redacted.isRedacted(resolved)).toBe(true);
      if (!Redacted.isRedacted(resolved)) {
        throw new Error("Expected auth.jwt_secret to be redacted.");
      }
      expect(Redacted.value(resolved)).toBe("super-secret");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
