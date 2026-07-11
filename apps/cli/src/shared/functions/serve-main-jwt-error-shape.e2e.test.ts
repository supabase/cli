import { execSync, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as jose from "jose";
import { afterEach, describe, expect, test } from "vitest";

import { LEGACY_EDGE_RUNTIME_IMAGE } from "../../legacy/shared/legacy-edge-runtime-image.ts";
import { bundleServeMainTemplate } from "./serve-main-bundler.ts";

/**
 * Regression guard for supabase/supabase#47836: JWT verification failures must
 * return `{ "error": "..." }`, matching the platform edge runtime's shape, not
 * the template's former `{ "msg": "..." }`.
 *
 * Boots the real bundled template under edge-runtime and asserts the JSON body
 * for both JWT-failure paths: a missing Authorization header (caught-exception
 * path) and a wrongly-signed JWT (the `!isValidJWT` path).
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
const JWT_SECRET = "serve-main-jwt-error-shape-e2e-secret";
const STARTUP_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 120_000;
const PORT = 8082;

function containerLogs(container: string): string {
  const result = spawnSync("docker", ["logs", container], { encoding: "utf8" });
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

const containers: string[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const container of containers.splice(0)) {
    spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
  }
  for (const dir of dirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("functions serve runtime template (JWT error shape)", () => {
  test.skipIf(!dockerAvailable)(
    "returns { error } (not { msg }) for JWT verification failures",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "supabase-serve-jwt-error-shape-e2e-"));
      dirs.push(dir);
      const container = `supabase-serve-jwt-error-shape-e2e-${process.pid.toString()}`;
      containers.push(container);

      await writeFile(join(dir, "index.ts"), await bundleServeMainTemplate());

      const functionsConfig = {
        "test-func": {
          entrypointPath: "unused.ts",
          importMapPath: null,
          staticFiles: [],
          verifyJWT: true,
        },
      };

      const run = spawnSync(
        "docker",
        [
          "run",
          "-d",
          "--name",
          container,
          "-p",
          `${PORT.toString()}:${PORT.toString()}`,
          "-e",
          `SUPABASE_INTERNAL_HOST_PORT=${PORT.toString()}`,
          "-e",
          `SUPABASE_INTERNAL_JWT_SECRET=${JWT_SECRET}`,
          "-e",
          "SUPABASE_URL=http://127.0.0.1:54321",
          "-e",
          `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${JSON.stringify(functionsConfig)}`,
          "-e",
          "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400",
          "-v",
          `${dir}:/app:ro`,
          "--entrypoint",
          "edge-runtime",
          LEGACY_EDGE_RUNTIME_IMAGE,
          "start",
          "--main-service=/app",
          `--port=${PORT.toString()}`,
        ],
        { encoding: "utf8" },
      );
      expect(run.status, run.stderr).toBe(0);

      const deadline = Date.now() + STARTUP_TIMEOUT_MS;
      let logs = "";
      while (Date.now() < deadline) {
        logs = containerLogs(container);
        if (/Serving functions on/.test(logs) || /worker boot error/i.test(logs)) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(logs).toMatch(/Serving functions on/);

      const url = `http://127.0.0.1:${PORT.toString()}/test-func`;

      // Missing Authorization header: caught-exception path (previously { msg: e.toString() }).
      const missingAuthRes = await fetch(url, { method: "POST" });
      expect(missingAuthRes.status).toBe(401);
      const missingAuthBody = (await missingAuthRes.json()) as Record<string, unknown>;
      expect(missingAuthBody).toHaveProperty("error");
      expect(missingAuthBody.error).toContain("Missing authorization header");
      expect(missingAuthBody).not.toHaveProperty("msg");

      // Well-formed but wrongly-signed JWT: `!isValidJWT` path (previously { msg: "Invalid JWT" }).
      const wrongSecretKey = new TextEncoder().encode("a-different-secret-than-the-server-has");
      const badJwt = await new jose.SignJWT({ sub: "e2e-test" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(wrongSecretKey);

      const invalidJwtRes = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${badJwt}` },
      });
      expect(invalidJwtRes.status).toBe(401);
      const invalidJwtBody = (await invalidJwtRes.json()) as Record<string, unknown>;
      expect(invalidJwtBody).toHaveProperty("error");
      expect(invalidJwtBody.error).toBe("Invalid JWT");
      expect(invalidJwtBody).not.toHaveProperty("msg");
    },
  );
});
