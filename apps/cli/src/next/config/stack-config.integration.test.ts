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
      ]);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
