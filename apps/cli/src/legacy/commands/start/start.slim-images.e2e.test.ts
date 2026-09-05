import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeAll, describe, expect, test } from "vitest";

import { dockerfileServiceImageRaw } from "../../../shared/services/dockerfile-images.ts";
import { toSlimImage } from "../../../shared/services/slim-images.ts";
import { legacyBuildHealthCmdArg } from "../../shared/db-bootstrap/docker-create-args.ts";
import {
  legacySlimWgetHealthcheck,
  legacySlimWgetWaitCommand,
} from "../../shared/db-bootstrap/slim-runtime.ts";
import { LEGACY_REALTIME_TENANT_ID } from "../../shared/db-bootstrap/realtime-env.ts";
import { ensureImage, resolveDeadline } from "../../../../tests/helpers/docker-image.ts";
import {
  overrideStackPorts,
  requireCliSuccess,
  runSupabase,
} from "../../../../tests/helpers/cli.ts";
import {
  legacySanitizeProjectId,
  legacyServiceContainerName,
  localDbContainerId,
} from "../../shared/legacy-docker-ids.ts";

const execFileAsync = promisify(execFile);

const START_TIMEOUT_MS = 280_000;
const SHORT_E2E_TIMEOUT_MS = 30_000;
const PULL_TIMEOUT_MS = 240_000;
const LIFECYCLE_OVERHEAD_MS = 90_000;

const SLIM_ENV = { SUPABASE_USE_SLIM_IMAGES: "1" } as const;
/** Override an inherited dogfood/CI flag so docker.io starts stay on docker.io. */
const DOCKER_IO_ENV = { SUPABASE_USE_SLIM_IMAGES: "" } as const;
const START_ARGS = ["start", "--exclude", "studio", "--exclude", "logflare", "--exclude", "vector"];
const PULL_ALIASES = [
  "pg",
  "gotrue",
  "postgrest",
  "realtime",
  "storage",
  "edgeruntime",
  "pgmeta",
  "mailpit",
  "kong",
] as const;
/** Slim images whose in-container probe is BusyBox wget. */
const WGET_PROBE_ALIASES = [
  "gotrue",
  "realtime",
  "storage",
  "logflare",
  "supavisor",
  "vector",
] as const;

function latestImagesToPull(): ReadonlyArray<string> {
  return [...new Set([...PULL_ALIASES, ...WGET_PROBE_ALIASES])].map((alias) =>
    toSlimImage(alias, dockerfileServiceImageRaw(alias)),
  );
}

function readSectionPort(config: string, section: string): number {
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`^\\[${escaped}\\][\\s\\S]*?^port = (\\d+)`, "m").exec(config);
  if (match?.[1] === undefined) {
    throw new Error(`missing [${section}] port`);
  }
  return Number(match[1]);
}
async function containerImage(name: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "inspect",
    name,
    "--format",
    "{{.Config.Image}}",
  ]);
  return stdout.trim();
}

function expectedSlimImage(alias: string): string {
  return toSlimImage(alias, dockerfileServiceImageRaw(alias));
}

async function containerHealthcheckTest(name: string): Promise<ReadonlyArray<string>> {
  const { stdout } = await execFileAsync("docker", [
    "inspect",
    name,
    "--format",
    "{{json .Config.Healthcheck.Test}}",
  ]);
  return JSON.parse(stdout.trim()) as ReadonlyArray<string>;
}

async function containerHealthStatus(name: string): Promise<string> {
  const { stdout } = await execFileAsync("docker", [
    "inspect",
    name,
    "--format",
    "{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}",
  ]);
  return stdout.trim();
}

async function edgeRuntimeFailureDiagnostics(name: string): Promise<string> {
  let mounts = "<unavailable>";
  try {
    const { stdout } = await execFileAsync("docker", [
      "inspect",
      name,
      "--format",
      "{{json .Mounts}}",
    ]);
    mounts = stdout.trim() || "[]";
  } catch (error) {
    mounts = `<unavailable: ${error instanceof Error ? error.message : String(error)}>`;
  }

  let logs = "<unavailable>";
  try {
    const { stdout, stderr } = await execFileAsync("docker", ["logs", name]);
    logs = `${stdout}${stderr}`.trim() || "<empty>";
  } catch (error) {
    logs = `<unavailable: ${error instanceof Error ? error.message : String(error)}>`;
  }

  return `edge runtime Mounts: ${mounts}\nedge runtime logs:\n${logs}`;
}

async function runWgetInImage(
  image: string,
  args: ReadonlyArray<string>,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync("docker", [
      "run",
      "--rm",
      "--network",
      "none",
      "--entrypoint",
      "wget",
      image,
      ...args,
    ]);
    return { stdout, stderr };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
  }
}

function expectBusyBoxAccepted(
  output: { readonly stdout: string; readonly stderr: string },
  label: string,
): void {
  const text = `${output.stdout}\n${output.stderr}`;
  expect(text, label).not.toMatch(
    /Unable to find image|executable file not found|unrecognized option|invalid option|unknown option/i,
  );
}

async function pullLatestImage(image: string, deadline: number): Promise<void> {
  try {
    await execFileAsync("docker", ["pull", image], {
      timeout: Math.max(1, deadline - Date.now()),
    });
  } catch {
    await ensureImage(image, deadline);
  }
}

describe("supabase start slim images (e2e)", () => {
  let projectDir: string | undefined;

  beforeAll(async () => {
    const deadline = resolveDeadline(PULL_TIMEOUT_MS);
    for (const image of latestImagesToPull()) {
      await pullLatestImage(image, deadline);
    }
  }, PULL_TIMEOUT_MS + 10_000);

  afterEach(async () => {
    if (projectDir === undefined) return;
    await runSupabase(["stop", "--no-backup"], {
      entrypoint: "legacy",
      cwd: projectDir,
      env: SLIM_ENV,
    }).catch(() => undefined);
    await rm(projectDir, { recursive: true, force: true }).catch(() => undefined);
    projectDir = undefined;
  });

  test(
    "every slim wget image accepts the BusyBox healthcheck argv",
    { timeout: SHORT_E2E_TIMEOUT_MS },
    async () => {
      for (const alias of WGET_PROBE_ALIASES) {
        const image = expectedSlimImage(alias);
        const probe =
          alias === "realtime"
            ? legacySlimWgetHealthcheck("http://127.0.0.1:9/", {
                header: `Host:${LEGACY_REALTIME_TENANT_ID}`,
              })
            : legacySlimWgetHealthcheck("http://127.0.0.1:9/");
        expectBusyBoxAccepted(await runWgetInImage(image, probe.test.slice(2)), image);
        if (alias === "vector") {
          const waitArgs = legacySlimWgetWaitCommand("http://127.0.0.1:9/").split(" ").slice(1);
          expectBusyBoxAccepted(await runWgetInImage(image, waitArgs), `${image} wait`);
        }
      }
    },
  );

  test(
    "starts the latest slim images, serves a function without a version pin, and keeps the Dockerfile tag",
    { timeout: START_TIMEOUT_MS + LIFECYCLE_OVERHEAD_MS },
    async () => {
      projectDir = await mkdtemp(path.join(tmpdir(), "sb-slim-start-e2e-"));
      const projectId = legacySanitizeProjectId(path.basename(projectDir));
      const edgeRuntimeContainer = legacyServiceContainerName("edge_runtime", projectId);
      const dbContainer = localDbContainerId(projectId);
      const storageContainer = legacyServiceContainerName("storage", projectId);
      const authContainer = legacyServiceContainerName("auth", projectId);
      const realtimeContainer = legacyServiceContainerName("realtime", projectId);

      const init = await runSupabase(["init"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
        env: DOCKER_IO_ENV,
      });
      requireCliSuccess(init, "init");

      const created = await runSupabase(["functions", "new", "hello", "--auth", "none"], {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: SHORT_E2E_TIMEOUT_MS,
        env: { ...DOCKER_IO_ENV, SUPABASE_YES: "1" },
      });
      requireCliSuccess(created, "functions new");
      await overrideStackPorts(projectDir);
      const config = await readFile(path.join(projectDir, "supabase", "config.toml"), "utf8");
      const apiPort = readSectionPort(config, "api");

      const start = await runSupabase(START_ARGS, {
        entrypoint: "legacy",
        cwd: projectDir,
        exitTimeoutMs: START_TIMEOUT_MS,
        env: SLIM_ENV,
      });
      expect(start.exitCode, `stdout:\n${start.stdout}\nstderr:\n${start.stderr}`).toBe(0);

      expect(await containerImage(dbContainer)).toBe(expectedSlimImage("pg"));
      expect(await containerImage(storageContainer)).toBe(expectedSlimImage("storage"));
      expect(await containerImage(edgeRuntimeContainer)).toBe(expectedSlimImage("edgeruntime"));

      expect(await containerHealthcheckTest(authContainer)).toEqual([
        "CMD-SHELL",
        legacyBuildHealthCmdArg(legacySlimWgetHealthcheck("http://127.0.0.1:9999/health").test),
      ]);
      expect(await containerHealthcheckTest(realtimeContainer)).toEqual([
        "CMD-SHELL",
        legacyBuildHealthCmdArg(
          legacySlimWgetHealthcheck("http://127.0.0.1:4000/api/ping", {
            header: `Host:${LEGACY_REALTIME_TENANT_ID}`,
          }).test,
        ),
      ]);
      expect(await containerHealthcheckTest(storageContainer)).toEqual([
        "CMD-SHELL",
        legacyBuildHealthCmdArg(legacySlimWgetHealthcheck("http://127.0.0.1:5000/status").test),
      ]);
      expect(await containerHealthStatus(authContainer)).toBe("healthy");
      expect(await containerHealthStatus(realtimeContainer)).toBe("healthy");
      expect(await containerHealthStatus(storageContainer)).toBe("healthy");

      const invoked = await fetch(`http://127.0.0.1:${apiPort}/functions/v1/hello`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Functions" }),
      });
      const body = await invoked.text();
      if (!invoked.ok) {
        throw new Error(
          `Functions request failed (${invoked.status}): ${body}\n${await edgeRuntimeFailureDiagnostics(edgeRuntimeContainer)}`,
        );
      }
      expect(JSON.parse(body)).toEqual({ message: "Hello Functions!" });
    },
  );
});
