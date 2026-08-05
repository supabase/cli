import { loadProjectConfig, loadProjectEnvironmentFor } from "@supabase/config/node";
import { Effect } from "effect";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveLocalStackLaunch } from "./stack-config.ts";

describe("local stack launch config", () => {
  it("resolves one project snapshot before translating the launch", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supabase-local-stack-launch-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(supabaseDir, { recursive: true });
      await writeFile(join(supabaseDir, ".env.local"), "DB_STARTUP_BUDGET=7s\n");
      await writeFile(
        join(supabaseDir, "config.toml"),
        [
          "[api]",
          "auto_expose_new_tables = false",
          "",
          "[db]",
          'health_timeout = "env(DB_STARTUP_BUDGET)"',
          "",
          "[experimental.webhooks]",
          "enabled = true",
          "",
        ].join("\n"),
      );

      const projectEnvironment = await loadProjectEnvironmentFor({ cwd: projectRoot, baseEnv: {} });
      expect(projectEnvironment).not.toBeNull();
      if (projectEnvironment === null) {
        return;
      }
      const loadedProjectConfig = await loadProjectConfig(projectRoot, {
        projectEnv: projectEnvironment,
      });
      const result = await Effect.runPromise(
        resolveLocalStackLaunch({
          loadedProjectConfig,
          projectEnvironment,
          projectPaths: { projectRoot, projectStateRoot: join(projectRoot, ".supabase") },
          mode: "native",
          exclude: ["studio"],
          runtimeVersions: { postgres: "17.6.1.090" },
        }),
      );

      expect(result.stackConfig).toMatchObject({
        projectDir: projectRoot,
        mode: "native",
        studio: false,
        postgres: { version: "17.6.1.090", autoExposeNewTables: false },
      });
      expect(result.stackConfig.postgres?.startupHealthTimeoutMs).toBe(7_000);
      expect(result.stackConfig.readiness).toEqual({ mode: "finite", timeoutMs: 37_000 });
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "unsupported",
          paths: ["experimental.webhooks.enabled"],
        }),
        expect.objectContaining({
          code: "unmatched-seed-pattern",
          paths: ["db.seed.sql_paths"],
        }),
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("translates an Auth project scenario without retaining secret values in diagnostics", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supabase-local-auth-launch-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(supabaseDir, { recursive: true });
      await writeFile(
        join(supabaseDir, ".env.local"),
        [
          "AUTH_JWT_SECRET=jwt-secret-with-at-least-32-characters",
          "AUTH_SMTP_PASS=smtp-secret",
          "AUTH_GITHUB_SECRET=github-secret",
          "AUTH_HOOK_SECRET=hook-secret",
        ].join("\n"),
      );
      await writeFile(
        join(supabaseDir, "config.toml"),
        [
          "[auth]",
          'site_url = "https://app.example.com"',
          'additional_redirect_urls = ["https://app.example.com/callback"]',
          "jwt_expiry = 7200",
          'jwt_secret = "env(AUTH_JWT_SECRET)"',
          "enable_signup = false",
          "",
          "[auth.email]",
          "enable_confirmations = true",
          "",
          "[auth.email.smtp]",
          "enabled = true",
          'host = "smtp.example.com"',
          "port = 587",
          'user = "mailer"',
          'pass = "env(AUTH_SMTP_PASS)"',
          'admin_email = "admin@example.com"',
          "",
          "[auth.external.github]",
          "enabled = true",
          'client_id = "github-client"',
          'secret = "env(AUTH_GITHUB_SECRET)"',
          "",
          "[auth.hook.custom_access_token]",
          "enabled = true",
          'uri = "pg-functions://postgres/auth/custom-access-token"',
          'secrets = "env(AUTH_HOOK_SECRET)"',
          "",
        ].join("\n"),
      );

      const projectEnvironment = await loadProjectEnvironmentFor({ cwd: projectRoot, baseEnv: {} });
      expect(projectEnvironment).not.toBeNull();
      if (projectEnvironment === null) return;
      const loadedProjectConfig = await loadProjectConfig(projectRoot, {
        projectEnv: projectEnvironment,
      });
      const result = await Effect.runPromise(
        resolveLocalStackLaunch({
          loadedProjectConfig,
          projectEnvironment,
          projectPaths: { projectRoot, projectStateRoot: join(projectRoot, ".supabase") },
          mode: "auto",
          exclude: [],
          runtimeVersions: {},
        }),
      );

      expect(result.stackConfig.credentials?.signing).toEqual({
        _tag: "SymmetricJwtSecret",
        secret: "jwt-secret-with-at-least-32-characters",
      });
      expect(result.stackConfig.auth).toMatchObject({
        siteUrl: "https://app.example.com",
        additionalRedirectUrls: ["https://app.example.com/callback"],
        jwtExpiry: 7200,
        enableSignup: false,
        email: {
          enableConfirmations: true,
          smtp: { host: "smtp.example.com", pass: "smtp-secret" },
        },
        externalProviders: {
          github: { enabled: true, clientId: "github-client", secret: "github-secret" },
        },
        hooks: {
          custom_access_token: { enabled: true, secrets: "hook-secret" },
        },
      });
      expect(result.warnings).toEqual([
        expect.objectContaining({
          code: "unmatched-seed-pattern",
          paths: ["db.seed.sql_paths"],
        }),
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it("resolves database bootstrap inputs before the stack launch is constructed", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "supabase-local-bootstrap-launch-"));
    const supabaseDir = join(projectRoot, "supabase");
    try {
      await mkdir(join(supabaseDir, "migrations"), { recursive: true });
      await mkdir(join(supabaseDir, "seeds"), { recursive: true });
      const migration = join(supabaseDir, "migrations", "20260805000000_create_widgets.sql");
      const seedSecond = join(supabaseDir, "seeds", "02_widgets.sql");
      const seedFirst = join(supabaseDir, "seeds", "01_accounts.sql");
      await writeFile(migration, "create table widgets(id bigint primary key);");
      await writeFile(seedFirst, "insert into widgets values (1);");
      await writeFile(seedSecond, "insert into widgets values (2);");
      await writeFile(
        join(supabaseDir, "config.toml"),
        [
          "[db.migrations]",
          "enabled = true",
          "",
          "[db.seed]",
          "enabled = true",
          'sql_paths = ["./seeds/02_widgets.sql", "./seeds/01_accounts.sql"]',
          "",
        ].join("\n"),
      );

      const projectEnvironment = await loadProjectEnvironmentFor({ cwd: projectRoot, baseEnv: {} });
      expect(projectEnvironment).not.toBeNull();
      if (projectEnvironment === null) return;
      const loadedProjectConfig = await loadProjectConfig(projectRoot, {
        projectEnv: projectEnvironment,
      });
      const result = await Effect.runPromise(
        resolveLocalStackLaunch({
          loadedProjectConfig,
          projectEnvironment,
          projectPaths: { projectRoot, projectStateRoot: join(projectRoot, ".supabase") },
          mode: "auto",
          exclude: [],
          runtimeVersions: {},
        }),
      );

      expect(result.stackConfig.databaseBootstrap).toMatchObject({
        migrationFiles: [migration],
      });
      expect(result.stackConfig.databaseBootstrap?.seedFiles?.map(({ path }) => path)).toEqual([
        seedSecond,
        seedFirst,
      ]);
      expect(
        result.stackConfig.databaseBootstrap?.seedFiles?.map(({ historyPath }) => historyPath),
      ).toEqual(["supabase/seeds/02_widgets.sql", "supabase/seeds/01_accounts.sql"]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
