import { execSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { LEGACY_EDGE_RUNTIME_IMAGE } from "../../legacy/shared/legacy-edge-runtime-image.ts";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

/**
 * Regression guard for supabase/supabase#45570: the edge-runtime worker bootstrap
 * template must boot with **no network access**. Before bundling, the template
 * imported `deno.land/std` and `jsr:` modules that Deno resolved over the network on
 * every start, so `functions serve` failed offline.
 *
 * This boots the real bundled template as an edge-runtime main service with
 * `--network none` and asserts it reaches the template's own "Serving functions"
 * log line without any remote fetch. The service is mounted at `/app` (read-only) so
 * `/root` stays writable for Deno's module cache — isolating the network as the only
 * variable (a control run of the unbundled template fails here with a DNS error).
 */

function hasDocker(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerAvailable = hasDocker();
const SERVE_OFFLINE_STARTUP_TIMEOUT_MS = 60_000;
const SERVE_OFFLINE_TEST_TIMEOUT_MS = 120_000;

function containerLogs(container: string): string {
  const result = spawnSync("docker", ["logs", container], { encoding: "utf8" });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

describe("functions serve runtime template (offline)", () => {
  test.skipIf(!dockerAvailable)(
    "boots under edge-runtime with networking disabled and fetches nothing remote",
    { timeout: SERVE_OFFLINE_TEST_TIMEOUT_MS },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "supabase-serve-offline-e2e-"));
      const container = `supabase-serve-offline-e2e-${process.pid.toString()}`;
      try {
        await writeFile(join(dir, "index.ts"), await bundleServeMainTemplate());

        const run = spawnSync(
          "docker",
          [
            "run",
            "-d",
            "--name",
            container,
            "--network",
            "none",
            "-e",
            "SUPABASE_INTERNAL_HOST_PORT=8081",
            "-e",
            "SUPABASE_INTERNAL_JWT_SECRET=offline-e2e",
            "-e",
            "SUPABASE_URL=http://127.0.0.1:54321",
            "-e",
            "SUPABASE_INTERNAL_FUNCTIONS_CONFIG={}",
            "-e",
            "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400",
            "-v",
            `${dir}:/app:ro`,
            "--entrypoint",
            "edge-runtime",
            LEGACY_EDGE_RUNTIME_IMAGE,
            "start",
            "--main-service=/app",
            "--port=8081",
          ],
          { encoding: "utf8" },
        );
        expect(run.status, run.stderr).toBe(0);

        const deadline = Date.now() + SERVE_OFFLINE_STARTUP_TIMEOUT_MS;
        let logs = "";
        while (Date.now() < deadline) {
          logs = containerLogs(container);
          if (/Serving functions on/.test(logs) || /worker boot error/i.test(logs)) {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 250));
        }

        // The template's own onListen message — proves the bundled worker booted.
        expect(logs).toMatch(/Serving functions on/);
        // No remote module resolution occurred (the #45570 failure mode).
        expect(logs).not.toMatch(/deno\.land|jsr\.io/);
        expect(logs).not.toMatch(/dns error|name resolution|worker boot error/i);
      } finally {
        spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
