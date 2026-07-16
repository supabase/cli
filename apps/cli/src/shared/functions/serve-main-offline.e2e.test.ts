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
const AUTH_FUNCTIONS_CONFIG = JSON.stringify({
  test: {
    entrypointPath: "/tmp/test/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: true,
  },
});

function jwtWithInvalidSignature(algorithm?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test-user" })).toString("base64url");
  return `${header}.${payload}.invalid`;
}

const authFailureCases = [
  {
    name: "missing authorization",
    code: "UNAUTHORIZED_NO_AUTH_HEADER",
    message: "Missing authorization header",
  },
  {
    name: "invalid JWT format",
    authorization: "Bearer not-a-jwt",
    code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
    message: "Invalid JWT format",
  },
  {
    name: "missing JWT algorithm",
    authorization: `Bearer ${jwtWithInvalidSignature()}`,
    code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
    message: "Invalid JWT format",
  },
  {
    name: "invalid legacy JWT",
    authorization: `Bearer ${jwtWithInvalidSignature("HS256")}`,
    code: "UNAUTHORIZED_LEGACY_JWT",
    message: "Invalid JWT",
  },
  {
    name: "invalid asymmetric JWT",
    authorization: `Bearer ${jwtWithInvalidSignature("ES256")}`,
    code: "UNAUTHORIZED_ASYMMETRIC_JWT",
    message: "Invalid JWT",
  },
  {
    name: "unsupported JWT algorithm",
    authorization: `Bearer ${jwtWithInvalidSignature("none")}`,
    code: "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM",
    message: "Unsupported JWT algorithm none",
  },
];

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

  test.skipIf(!dockerAvailable)(
    "returns canonical JWT auth failures",
    { timeout: SERVE_OFFLINE_TEST_TIMEOUT_MS },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "supabase-serve-auth-e2e-"));
      const container = `supabase-serve-auth-e2e-${process.pid.toString()}`;
      try {
        await writeFile(join(dir, "index.ts"), await bundleServeMainTemplate());

        const run = spawnSync(
          "docker",
          [
            "run",
            "-d",
            "--name",
            container,
            "-p",
            "127.0.0.1::8081",
            "-e",
            "SUPABASE_INTERNAL_HOST_PORT=8081",
            "-e",
            "SUPABASE_INTERNAL_JWT_SECRET=auth-e2e",
            "-e",
            "SUPABASE_URL=http://127.0.0.1:54321",
            "-e",
            `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${AUTH_FUNCTIONS_CONFIG}`,
            "-e",
            "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400",
            "-e",
            'SUPABASE_JWKS={"keys":[]}',
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

        const portResult = spawnSync("docker", ["port", container, "8081/tcp"], {
          encoding: "utf8",
        });
        expect(portResult.status, portResult.stderr).toBe(0);
        const port = Number(portResult.stdout.trim().split(":").at(-1));
        expect(port).toBeGreaterThan(0);
        const url = `http://127.0.0.1:${port}/test`;

        const deadline = Date.now() + SERVE_OFFLINE_STARTUP_TIMEOUT_MS;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            const response = await fetch(url);
            if (response.status === 401) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(ready, containerLogs(container)).toBe(true);

        for (const { name, authorization, code, message } of authFailureCases) {
          const response = await fetch(url, {
            headers: authorization === undefined ? undefined : { authorization },
          });
          expect(response.status, name).toBe(401);
          expect(response.headers.get("content-type"), name).toContain("application/json");
          expect(response.headers.get("sb-error-code"), name).toBe(code);
          expect(await response.json(), name).toEqual({ code, message, msg: message });
        }
      } finally {
        spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
