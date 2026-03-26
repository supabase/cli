import { describe, expect, test } from "bun:test";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, FileSystem, Path, Redacted } from "effect";
import { findProjectRootFor, loadProjectEnvironmentFor } from "./bun.ts";
import { ProjectConfigParseError } from "./errors.ts";
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

  test("resolveProjectValue fails when an explicit env() reference is missing", async () => {
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

      await expect(
        runConfigEffect(
          resolveProjectValue(loaded!.config.auth.jwt_secret, projectEnv!, "auth.jwt_secret"),
        ),
      ).rejects.toMatchObject({
        _tag: "MissingProjectEnvVarError",
        configPath: "auth.jwt_secret",
        envName: "MISSING_SECRET",
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("resolveProjectSubtree fails when the selected subtree contains a missing env()", async () => {
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

      await expect(
        runConfigEffect(
          resolveProjectSubtree(loaded!.config.auth.sms.twilio, projectEnv!, "auth.sms.twilio"),
        ),
      ).rejects.toMatchObject({
        _tag: "MissingProjectEnvVarError",
        configPath: "auth.sms.twilio.auth_token",
        envName: "MISSING_SECRET",
      });
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
});
