import { execSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import { LEGACY_START_KONG_YML_TEMPLATE } from "../../legacy/commands/start/templates/kong.yml.ts";
import { LEGACY_EDGE_RUNTIME_IMAGE } from "../../legacy/shared/legacy-edge-runtime-image.ts";
import { ensureImage, resolveDeadline } from "../../../tests/helpers/docker-image.ts";
import { dockerfileServiceImage } from "../services/dockerfile-images.ts";
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
// Cold-cache image resolution (up to one shared 90s resolveDeadline budget)
// runs inside the test body, ahead of the 60s startup wait — the test budget
// must cover both stacked, or a healthy near-cap pull trips vitest first.
const SERVE_OFFLINE_TEST_TIMEOUT_MS = 180_000;
const AUTH_FUNCTIONS_CONFIG = JSON.stringify({
  test: {
    entrypointPath: "/tmp/test/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: true,
  },
});
const KONG_FUNCTIONS_CONFIG = JSON.stringify({
  test: {
    entrypointPath: "/app/functions/custom/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: true,
  },
  custom: {
    entrypointPath: "/app/functions/custom/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: false,
    env: {
      SHARED: "function",
      FUNCTION_ONLY: "function",
      FUNCTION_SECRET: "must-not-appear-in-debug-logs",
    },
  },
  "custom-alias": {
    entrypointPath: "/app/functions/custom/index.ts",
    importMapPath: "",
    staticFiles: [],
    verifyJWT: false,
  },
});
const CUSTOM_FUNCTION = `import { sharedValue } from "../_shared/value.ts";

Deno.serve(() => new Response("ok", {
  headers: {
    "X-Custom-Id": "abc123",
    "X-Function-Slug": Deno.env.get("SUPABASE_FUNCTION_SLUG") ?? "",
    "X-Shared-Import": sharedValue,
    "X-Shared": Deno.env.get("SHARED") ?? "",
    "X-Function-Only": Deno.env.get("FUNCTION_ONLY") ?? "",
    "X-Global-Only": Deno.env.get("GLOBAL_ONLY") ?? "",
    "Access-Control-Expose-Headers": "X-Custom-Id",
  },
}));`;

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

async function writeKongConfig(dir: string, edgeRuntimeContainer: string) {
  // Was: read straight from apps/cli-go/internal/start/templates/kong.yml. That
  // package was deleted outright (CLI-1966; unreachable from the TS CLI, directly
  // or indirectly), so this now uses the TS transcription of the same template
  // that legacy `start`'s Kong service already ports byte-for-byte.
  const config = LEGACY_START_KONG_YML_TEMPLATE.replaceAll(
    "{{ .EdgeRuntimeId }}",
    edgeRuntimeContainer,
  )
    .replaceAll("{{ .BearerToken }}", "$((headers.authorization or headers.apikey))")
    .replaceAll("{{ .QueryToken }}", "$((query_params.apikey))")
    .replace(/{{ \.[A-Za-z]+ }}/g, "unused");
  await writeFile(join(dir, "kong.yml"), config);
}

describe("functions serve runtime template (offline)", () => {
  test.skipIf(!dockerAvailable)(
    "boots under edge-runtime with networking disabled and fetches nothing remote",
    { timeout: SERVE_OFFLINE_TEST_TIMEOUT_MS },
    async () => {
      const runtimeImage = await ensureImage(LEGACY_EDGE_RUNTIME_IMAGE);
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
            runtimeImage,
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
      const runtimeImage = await ensureImage(LEGACY_EDGE_RUNTIME_IMAGE);
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
            runtimeImage,
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

  test.skipIf(!dockerAvailable)(
    "preserves function env and CORS headers and exposes JWT errors through Kong",
    { timeout: SERVE_OFFLINE_TEST_TIMEOUT_MS },
    async () => {
      const imageDeadline = resolveDeadline();
      const [runtimeImage, kongImage] = await Promise.all([
        ensureImage(LEGACY_EDGE_RUNTIME_IMAGE, imageDeadline),
        ensureImage(dockerfileServiceImage("kong"), imageDeadline),
      ]);
      const dir = await mkdtemp(join(tmpdir(), "supabase-serve-kong-e2e-"));
      const network = `supabase-serve-kong-e2e-${process.pid.toString()}`;
      const runtimeContainer = `${network}-runtime`;
      const kongContainer = `${network}-kong`;
      try {
        await writeFile(join(dir, "index.ts"), await bundleServeMainTemplate());
        await mkdir(join(dir, "functions", "custom"), { recursive: true });
        await mkdir(join(dir, "functions", "_shared"), { recursive: true });
        await writeFile(join(dir, "functions", "custom", "index.ts"), CUSTOM_FUNCTION);
        await writeFile(
          join(dir, "functions", "_shared", "value.ts"),
          'export const sharedValue = "shared-import-ok";\n',
        );
        await writeKongConfig(dir, runtimeContainer);

        const createNetwork = spawnSync("docker", ["network", "create", network], {
          encoding: "utf8",
        });
        expect(createNetwork.status, createNetwork.stderr).toBe(0);

        const runRuntime = spawnSync(
          "docker",
          [
            "run",
            "-d",
            "--name",
            runtimeContainer,
            "--network",
            network,
            "-e",
            "SUPABASE_INTERNAL_HOST_PORT=8081",
            "-e",
            "SUPABASE_INTERNAL_JWT_SECRET=auth-e2e",
            "-e",
            `SUPABASE_URL=http://${kongContainer}:8000`,
            "-e",
            `SUPABASE_INTERNAL_FUNCTIONS_CONFIG=${KONG_FUNCTIONS_CONFIG}`,
            "-e",
            "SUPABASE_INTERNAL_DEBUG=true",
            "-e",
            "SHARED=shared",
            "-e",
            "GLOBAL_ONLY=global",
            "-e",
            "SUPABASE_INTERNAL_WALLCLOCK_LIMIT_SEC=400",
            "-e",
            'SUPABASE_JWKS={"keys":[]}',
            "-v",
            `${dir}:/app:ro`,
            "--entrypoint",
            "edge-runtime",
            runtimeImage,
            "start",
            "--main-service=/app",
            "--port=8081",
          ],
          { encoding: "utf8" },
        );
        expect(runRuntime.status, runRuntime.stderr).toBe(0);

        const runKong = spawnSync(
          "docker",
          [
            "run",
            "-d",
            "--name",
            kongContainer,
            "--network",
            network,
            "-p",
            "127.0.0.1::8000",
            "-e",
            "KONG_DATABASE=off",
            "-e",
            "KONG_DECLARATIVE_CONFIG=/home/kong/kong.yml",
            "-e",
            "KONG_PLUGINS=request-transformer,cors",
            "-e",
            "KONG_NGINX_WORKER_PROCESSES=1",
            "-v",
            `${join(dir, "kong.yml")}:/home/kong/kong.yml:ro`,
            kongImage,
            "kong",
            "docker-start",
          ],
          { encoding: "utf8" },
        );
        expect(runKong.status, runKong.stderr).toBe(0);

        const portResult = spawnSync("docker", ["port", kongContainer, "8000/tcp"], {
          encoding: "utf8",
        });
        expect(portResult.status, portResult.stderr).toBe(0);
        const port = Number(portResult.stdout.trim().split(":").at(-1));
        expect(port).toBeGreaterThan(0);
        const functionsUrl = `http://127.0.0.1:${port}/functions/v1`;
        const authUrl = `${functionsUrl}/test`;

        const deadline = Date.now() + SERVE_OFFLINE_STARTUP_TIMEOUT_MS;
        let ready = false;
        while (Date.now() < deadline) {
          try {
            const response = await fetch(authUrl);
            if (response.status === 401) {
              ready = true;
              break;
            }
          } catch {}
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        expect(ready, `${containerLogs(kongContainer)}\n${containerLogs(runtimeContainer)}`).toBe(
          true,
        );

        const [customResponse, aliasResponse] = await Promise.all([
          fetch(`${functionsUrl}/custom`, {
            headers: { Origin: "http://localhost:3000" },
          }),
          fetch(`${functionsUrl}/custom-alias`),
        ]);
        expect(customResponse.status).toBe(200);
        expect(customResponse.headers.get("x-custom-id")).toBe("abc123");
        expect(customResponse.headers.get("x-function-slug")).toBe("custom");
        expect(customResponse.headers.get("x-shared-import")).toBe("shared-import-ok");
        expect(customResponse.headers.get("x-shared")).toBe("function");
        expect(customResponse.headers.get("x-function-only")).toBe("function");
        expect(customResponse.headers.get("x-global-only")).toBe("global");
        expect(customResponse.headers.get("access-control-expose-headers")?.toLowerCase()).toBe(
          "x-custom-id",
        );
        expect(aliasResponse.status).toBe(200);
        expect(aliasResponse.headers.get("x-function-slug")).toBe("custom-alias");
        expect(aliasResponse.headers.get("x-shared-import")).toBe("shared-import-ok");
        const runtimeLogs = containerLogs(runtimeContainer);
        expect(runtimeLogs).toContain("Functions config:");
        expect(runtimeLogs).toContain('"custom"');
        expect(runtimeLogs).not.toContain('"env"');
        expect(runtimeLogs).not.toContain("must-not-appear-in-debug-logs");

        const authResponse = await fetch(authUrl, {
          headers: { Origin: "http://localhost:3000" },
        });
        expect(authResponse.status).toBe(401);
        expect(authResponse.headers.get("sb-error-code")).toBe("UNAUTHORIZED_NO_AUTH_HEADER");
        expect(authResponse.headers.get("access-control-expose-headers")).toBe("sb-error-code");
        expect(await authResponse.json()).toEqual({
          code: "UNAUTHORIZED_NO_AUTH_HEADER",
          message: "Missing authorization header",
          msg: "Missing authorization header",
        });

        const reusedCustomResponse = await fetch(`${functionsUrl}/custom`);
        expect(reusedCustomResponse.status).toBe(200);
        expect(reusedCustomResponse.headers.get("x-function-slug")).toBe("custom");
      } finally {
        spawnSync("docker", ["rm", "-f", kongContainer, runtimeContainer], {
          stdio: "ignore",
        });
        spawnSync("docker", ["network", "rm", network], { stdio: "ignore" });
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
