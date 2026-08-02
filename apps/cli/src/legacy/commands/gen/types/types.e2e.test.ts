import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  makeTempHome,
  makeTempStackProject,
  runSupabase,
} from "../../../../../tests/helpers/cli.ts";
import { dockerfileServiceImage } from "../../../../shared/services/dockerfile-images.ts";
import { localDbContainerId, localNetworkId } from "../../../shared/legacy-docker-ids.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import {
  RESOLVE_BUDGET_MS,
  ensureImage,
  resolveDeadline,
} from "../../../../../tests/helpers/docker-image.ts";
import { resolvePgmetaImage } from "./types.shared.ts";

const TYPEGEN_LANGS = ["typescript", "go", "swift", "python"] as const;
type TypegenLang = (typeof TYPEGEN_LANGS)[number];

const LOCAL_POSTGRES_IMAGE = legacyGetRegistryImageUrl(dockerfileServiceImage("pg"));
const LOCAL_POSTGRES_TIMEOUT_MS = 120_000;
const TYPEGEN_TIMEOUT_MS = 90_000;
// Image resolution happens inside the test bodies, ahead of the startup and
// per-language windows the test timeouts already budget — so each timeout has
// to include its own image setup allowance on top.
const LOCAL_IMAGE_BUDGET_MS = LOCAL_POSTGRES_TIMEOUT_MS + TYPEGEN_TIMEOUT_MS;
const REMOTE_E2E_FLAG = "SUPABASE_TYPEGEN_E2E_REMOTE";
const REMOTE_PROJECT_REF_ENV = "SUPABASE_TEST_PROJECT_REF";
const OUTPUT_TAIL_LENGTH = 4_000;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function tokenlessEnv(profilePath: string, projectDir: string) {
  return {
    SUPABASE_ACCESS_TOKEN: "",
    SUPABASE_DB_PASSWORD: "postgres",
    SUPABASE_PROFILE: profilePath,
    SUPABASE_WORKDIR: projectDir,
  };
}

function remoteEnv(accessToken: string, projectDir: string) {
  return {
    SUPABASE_ACCESS_TOKEN: accessToken,
    SUPABASE_DB_PASSWORD: "",
    SUPABASE_WORKDIR: projectDir,
  };
}

async function writeOfflineProfile(projectDir: string): Promise<string> {
  const profilePath = join(projectDir, "offline-profile.yaml");
  await writeFile(
    profilePath,
    [
      "name: cli-typegen-e2e",
      'api_url: "http://127.0.0.1:1"',
      'dashboard_url: "http://127.0.0.1:1/dashboard"',
      'docs_url: "http://127.0.0.1:1/docs"',
      'project_host: "example.invalid"',
      'pooler_host: ""',
      "",
    ].join("\n"),
  );
  return profilePath;
}

async function writeLocalConfig(projectDir: string, projectId: string, dbPort: number) {
  const supabaseDir = join(projectDir, "supabase");
  await mkdir(supabaseDir, { recursive: true });
  await writeFile(
    join(supabaseDir, "config.toml"),
    [
      `project_id = "${projectId}"`,
      "",
      "[api]",
      'schemas = ["public"]',
      "",
      "[db]",
      `port = ${dbPort}`,
      "major_version = 17",
      "",
    ].join("\n"),
  );
}

function combinedOutput(result: { stdout: string; stderr: string }) {
  return `${result.stdout}\n${result.stderr}`;
}

function expectSucceeded(
  command: string,
  result: { stdout: string; stderr: string; exitCode: number },
) {
  expect(result.exitCode, `${command}\n${combinedOutput(result)}`).toBe(0);
}

function outputTail(output: string) {
  return output.length > OUTPUT_TAIL_LENGTH
    ? output.slice(output.length - OUTPUT_TAIL_LENGTH)
    : output;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            child.kill("SIGKILL");
          }, options.timeoutMs);

    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}${String(error)}`, exitCode: 1 });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve({
        stdout,
        stderr: timedOut ? `${stderr}\nTimed out after ${options.timeoutMs}ms` : stderr,
        exitCode: code ?? 1,
      });
    });
  });
}

function runDocker(args: ReadonlyArray<string>, options?: { readonly timeoutMs?: number }) {
  return runCommand("docker", args, options);
}

async function expectDockerSucceeded(args: ReadonlyArray<string>, timeoutMs?: number) {
  const result = await runDocker(args, { timeoutMs });
  expectSucceeded(`docker ${args.join(" ")}`, result);
  return result;
}

async function waitForLocalPostgres(containerName: string) {
  const startedAt = Date.now();
  let lastResult: CommandResult = { stdout: "", stderr: "", exitCode: 1 };
  let consecutiveReadyChecks = 0;
  while (Date.now() - startedAt < LOCAL_POSTGRES_TIMEOUT_MS) {
    lastResult = await runDocker(
      [
        "exec",
        "-e",
        "PGPASSWORD=postgres",
        containerName,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-tAc",
        "select 1",
      ],
      { timeoutMs: 5_000 },
    );
    if (lastResult.exitCode === 0 && lastResult.stdout.trim() === "1") {
      consecutiveReadyChecks += 1;
    } else {
      consecutiveReadyChecks = 0;
    }
    if (consecutiveReadyChecks >= 2) {
      return;
    }
    await sleep(1_000);
  }

  const logs = await runDocker(["logs", containerName], { timeoutMs: 10_000 });
  throw new Error(
    [
      `Timed out waiting for ${containerName}`,
      outputTail(combinedOutput(lastResult)),
      outputTail(combinedOutput(logs)),
    ].join("\n"),
  );
}

// `gen types` starts pg-meta itself (local AND remote non-ts languages) via a
// single-registry rewrite with no fallback (`resolvePgmetaImage`), so pre-resolve
// it and retag the winning candidate onto the exact reference the CLI will run.
async function ensurePgmetaImage(deadline?: number) {
  const expected = resolvePgmetaImage();
  const resolved = await ensureImage(dockerfileServiceImage("pgmeta"), deadline);
  if (resolved !== expected) {
    await expectDockerSucceeded(["tag", resolved, expected], 30_000);
  }
}

async function startLocalPostgres(input: { readonly projectId: string; readonly dbPort: number }) {
  const containerName = localDbContainerId(input.projectId);
  const networkName = localNetworkId(input.projectId);
  // Sized so a slow-but-healthy Postgres pull cannot starve pg-meta's
  // resolution; the local test's own timeout includes this allowance.
  const imageDeadline = resolveDeadline(LOCAL_IMAGE_BUDGET_MS);
  const postgresImage = await ensureImage(LOCAL_POSTGRES_IMAGE, imageDeadline);
  await ensurePgmetaImage(imageDeadline);

  await expectDockerSucceeded(["network", "create", networkName], 30_000);
  await expectDockerSucceeded(
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
      "--network",
      networkName,
      "--network-alias",
      "db",
      "-p",
      `${input.dbPort}:5432`,
      "-e",
      "POSTGRES_PASSWORD=postgres",
      postgresImage,
      "postgres",
      "-D",
      "/etc/postgresql",
      "-c",
      "wal_level=logical",
      "-c",
      "max_wal_senders=5",
      "-c",
      "max_replication_slots=5",
    ],
    LOCAL_POSTGRES_TIMEOUT_MS,
  );
  await waitForLocalPostgres(containerName);

  return { containerName, networkName };
}

async function seedSmokeTable(containerName: string) {
  await expectDockerSucceeded(
    [
      "exec",
      "-e",
      "PGPASSWORD=postgres",
      containerName,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      [
        "create table if not exists public.typegen_smoke (",
        "id bigint generated by default as identity primary key,",
        "name text not null,",
        "is_active boolean not null default true,",
        "created_at timestamptz not null default now()",
        ");",
      ].join(" "),
    ],
    30_000,
  );
}

async function cleanupLocalPostgres(input: {
  readonly containerName: string;
  readonly networkName: string;
}) {
  await runDocker(["rm", "-f", input.containerName], { timeoutMs: 30_000 });
  await runDocker(["network", "rm", input.networkName], { timeoutMs: 30_000 });
}

function expectNoRemoteAuthPath(result: { stdout: string; stderr: string }) {
  const output = combinedOutput(result);
  expect(output).not.toContain("Access token not provided");
  expect(output).not.toContain("api.supabase.com");
  expect(output).not.toContain("127.0.0.1:1");
}

function expectLanguageShape(lang: TypegenLang, stdout: string) {
  expect(stdout.trim().length, `${lang} stdout`).toBeGreaterThan(0);
  switch (lang) {
    case "typescript":
      expect(stdout).toContain("export type Database");
      break;
    case "go":
      expect(stdout).toMatch(/\btype\b/);
      break;
    case "swift":
      expect(stdout).toMatch(/\bstruct\b/);
      break;
    case "python":
      expect(stdout).toContain("from __future__ import annotations");
      break;
  }
}

function expectLocalSmokeTable(lang: TypegenLang, stdout: string) {
  if (lang === "typescript") {
    expect(stdout).toContain("typegen_smoke");
    return;
  }
  expect(stdout).toContain("TypegenSmoke");
}

describe("legacy gen types e2e", () => {
  test(
    "generates all supported languages from a tokenless local stack",
    {
      timeout:
        LOCAL_IMAGE_BUDGET_MS + LOCAL_POSTGRES_TIMEOUT_MS + TYPEGEN_TIMEOUT_MS * TYPEGEN_LANGS.length,
    },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-typegen-local-e2e-");
      const projectId = `typegen${project.ports.dbPort}`;
      const profilePath = await writeOfflineProfile(project.dir);
      const env = tokenlessEnv(profilePath, project.dir);
      const localPostgres = {
        containerName: localDbContainerId(projectId),
        networkName: localNetworkId(projectId),
      };

      try {
        await writeLocalConfig(project.dir, projectId, project.ports.dbPort);
        await cleanupLocalPostgres(localPostgres);
        await startLocalPostgres({ projectId, dbPort: project.ports.dbPort });
        await seedSmokeTable(localPostgres.containerName);

        for (const lang of TYPEGEN_LANGS) {
          const result = await runSupabase(
            ["gen", "types", "--local", "--lang", lang, "--schema", "public"],
            {
              cwd: project.dir,
              home: home.dir,
              env,
              entrypoint: "legacy",
              exitTimeoutMs: TYPEGEN_TIMEOUT_MS,
            },
          );
          expectSucceeded(`supabase gen types --local --lang ${lang}`, result);
          expectNoRemoteAuthPath(result);
          expectLanguageShape(lang, result.stdout);
          expectLocalSmokeTable(lang, result.stdout);
        }
      } finally {
        await cleanupLocalPostgres(localPostgres);
      }
    },
  );

  const remoteProjectRef = process.env[REMOTE_PROJECT_REF_ENV];
  const remoteAccessToken = process.env["SUPABASE_ACCESS_TOKEN"];
  const remoteEnabled = process.env[REMOTE_E2E_FLAG] === "1";

  const remoteTest = remoteEnabled ? test : test.skip;

  remoteTest(
    "generates all supported languages from a remote project",
    { timeout: TYPEGEN_TIMEOUT_MS * TYPEGEN_LANGS.length },
    async () => {
      const home = makeTempHome();
      const project = await makeTempStackProject("supabase-typegen-remote-e2e-");
      if (
        remoteProjectRef === undefined ||
        remoteProjectRef.length === 0 ||
        remoteAccessToken === undefined ||
        remoteAccessToken.length === 0
      ) {
        throw new Error(
          `Set ${REMOTE_E2E_FLAG}=1, ${REMOTE_PROJECT_REF_ENV}, and SUPABASE_ACCESS_TOKEN to run remote typegen e2e.`,
        );
      }

      await ensurePgmetaImage();

      for (const lang of TYPEGEN_LANGS) {
        const result = await runSupabase(
          ["gen", "types", "--project-id", remoteProjectRef, "--lang", lang, "--schema", "public"],
          {
            cwd: project.dir,
            home: home.dir,
            env: remoteEnv(remoteAccessToken, project.dir),
            entrypoint: "legacy",
            exitTimeoutMs: TYPEGEN_TIMEOUT_MS,
          },
        );
        expectSucceeded(`supabase gen types --project-id <ref> --lang ${lang}`, result);
        expectLanguageShape(lang, result.stdout);
      }
    },
  );
});
