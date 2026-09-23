import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Clock, Config, Data, Effect, FileSystem, Option, Path, Schedule } from "effect";
import {
  makeTempStackProject,
  runDockerEffect,
  runSupabaseEffect,
  withTempHome,
} from "../../../../tests/helpers/cli.ts";
import { dockerfileServiceImage } from "../../../shared/services/dockerfile-images.ts";
import { localDbContainerId } from "../../../command-internal/docker-ids.ts";
import {
  RESOLVE_BUDGET_MS,
  ensureImage,
  resolveDeadline,
} from "../../../../tests/helpers/docker-image.ts";

const TYPEGEN_LANGS = ["typescript", "go", "swift", "python"] as const;
type TypegenLang = (typeof TYPEGEN_LANGS)[number];

const LOCAL_POSTGRES_IMAGE = dockerfileServiceImage("pg");
const LOCAL_POSTGRES_TIMEOUT_MS = 120_000;
const TYPEGEN_TIMEOUT_MS = 90_000;
// Image resolution runs inside the test body, so its timeout must add on top of the
// startup and per-language windows the test already budgets.
const LOCAL_IMAGE_BUDGET_MS = LOCAL_POSTGRES_TIMEOUT_MS + TYPEGEN_TIMEOUT_MS;
const REMOTE_E2E_FLAG = "SUPABASE_TYPEGEN_E2E_REMOTE";
const REMOTE_PROJECT_REF_ENV = "SUPABASE_TEST_PROJECT_REF";
const OUTPUT_TAIL_LENGTH = 4_000;

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

class TypegenE2eSetupError extends Data.TaggedError("TypegenE2eSetupError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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

const makeStackProject = (prefix: string) =>
  Effect.tryPromise({
    try: () => makeTempStackProject(prefix),
    catch: (cause) =>
      new TypegenE2eSetupError({ message: "failed to create the temp stack project", cause }),
  });

const writeOfflineProfile = Effect.fnUntraced(function* (projectDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const profilePath = path.join(projectDir, "offline-profile.yaml");
  yield* fs.writeFileString(
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
});

const writeLocalConfig = Effect.fnUntraced(function* (
  projectDir: string,
  projectId: string,
  dbPort: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supabaseDir = path.join(projectDir, "supabase");
  yield* fs.makeDirectory(supabaseDir, { recursive: true });
  yield* fs.writeFileString(
    path.join(supabaseDir, "config.toml"),
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
});

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

/** Runs a Docker CLI command to completion, reporting a failure as a non-zero result. */
const runDocker = (args: ReadonlyArray<string>, options: { readonly timeoutMs?: number } = {}) =>
  runDockerEffect(args, options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }).pipe(
    Effect.map(({ stdout, stderr }): CommandResult => ({ stdout, stderr, exitCode: 0 })),
    Effect.catchTag("DockerCommandError", (error): Effect.Effect<CommandResult> =>
      Effect.succeed({
        stdout: error.stdout,
        stderr: error.stderr.length > 0 ? error.stderr : error.message,
        exitCode: 1,
      }),
    ),
    Effect.catch((error): Effect.Effect<CommandResult> =>
      Effect.succeed({ stdout: "", stderr: String(error), exitCode: 1 }),
    ),
  );

const expectDockerSucceeded = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  timeoutMs?: number,
) {
  const result = yield* runDocker(args, timeoutMs === undefined ? {} : { timeoutMs });
  expectSucceeded(`docker ${args.join(" ")}`, result);
  return result;
});

const waitForLocalPostgres = Effect.fnUntraced(function* (containerName: string) {
  const startedAt = yield* Clock.currentTimeMillis;
  let lastResult: CommandResult = { stdout: "", stderr: "", exitCode: 1 };
  let consecutiveReadyChecks = 0;
  const probe = Effect.gen(function* () {
    if ((yield* Clock.currentTimeMillis) - startedAt >= LOCAL_POSTGRES_TIMEOUT_MS) {
      return "timed-out" as const;
    }
    lastResult = yield* runDocker(
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
    return consecutiveReadyChecks >= 2 ? ("ready" as const) : ("pending" as const);
  });
  const outcome = yield* probe.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (state) => state !== "pending",
    }),
  );
  if (outcome === "ready") {
    return;
  }

  const logs = yield* runDocker(["logs", containerName], { timeoutMs: 10_000 });
  return yield* new TypegenE2eSetupError({
    message: [
      `Timed out waiting for ${containerName}`,
      outputTail(combinedOutput(lastResult)),
      outputTail(combinedOutput(logs)),
    ].join("\n"),
  });
});

/**
 * Starts a bare Postgres container named for `assertLocalDbRunning`'s `container inspect` check.
 * Generation itself runs in-process against the host-mapped port, so — unlike the pg-meta-era
 * setup this replaces — no Docker network or network alias is needed here.
 */
const startLocalPostgres = Effect.fnUntraced(function* (input: {
  readonly projectId: string;
  readonly dbPort: number;
}) {
  const containerName = localDbContainerId(input.projectId);
  const imageDeadline = resolveDeadline(LOCAL_IMAGE_BUDGET_MS);
  const postgresImage = yield* Effect.tryPromise({
    try: () => ensureImage(LOCAL_POSTGRES_IMAGE, imageDeadline - RESOLVE_BUDGET_MS),
    catch: (cause) => new TypegenE2eSetupError({ message: "failed to ensure Docker image", cause }),
  });

  yield* expectDockerSucceeded(
    [
      "run",
      "--detach",
      "--rm",
      "--name",
      containerName,
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
  yield* waitForLocalPostgres(containerName);

  return { containerName };
});

const seedSmokeTable = (containerName: string) =>
  expectDockerSucceeded(
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

const cleanupLocalPostgres = (input: { readonly containerName: string }) =>
  runDocker(["rm", "-f", input.containerName], { timeoutMs: 30_000 }).pipe(Effect.asVoid);

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

describe("gen types e2e", () => {
  it.live(
    "generates all supported languages from a tokenless local stack",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const project = yield* makeStackProject("supabase-typegen-local-e2e-");
          const projectId = `typegen${project.ports.dbPort}`;
          const profilePath = yield* writeOfflineProfile(project.dir);
          const env = tokenlessEnv(profilePath, project.dir);
          const localPostgres = { containerName: localDbContainerId(projectId) };

          yield* Effect.gen(function* () {
            yield* writeLocalConfig(project.dir, projectId, project.ports.dbPort);
            yield* cleanupLocalPostgres(localPostgres);
            yield* startLocalPostgres({ projectId, dbPort: project.ports.dbPort });
            yield* seedSmokeTable(localPostgres.containerName);

            for (const lang of TYPEGEN_LANGS) {
              const result = yield* runSupabaseEffect(
                ["gen", "types", "--local", "--lang", lang, "--schema", "public"],
                {
                  cwd: project.dir,
                  home: home.dir,
                  env,
                  exitTimeoutMs: TYPEGEN_TIMEOUT_MS,
                },
              );
              expectSucceeded(`supabase gen types --local --lang ${lang}`, result);
              expectNoRemoteAuthPath(result);
              expectLanguageShape(lang, result.stdout);
              expectLocalSmokeTable(lang, result.stdout);
            }
          }).pipe(Effect.ensuring(cleanupLocalPostgres(localPostgres)));
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    {
      timeout:
        LOCAL_IMAGE_BUDGET_MS +
        LOCAL_POSTGRES_TIMEOUT_MS +
        TYPEGEN_TIMEOUT_MS * TYPEGEN_LANGS.length,
    },
  );

  // An unset or empty variable reads as `Option.none()`, matching the previous
  // `undefined`/empty-string checks below.
  const remote = Effect.runSync(
    Effect.all({
      projectRef: Config.option(Config.string(REMOTE_PROJECT_REF_ENV)),
      accessToken: Config.option(Config.string("SUPABASE_ACCESS_TOKEN")),
      enabled: Config.option(Config.string(REMOTE_E2E_FLAG)),
    }),
  );
  const remoteEnabled = Option.getOrElse(remote.enabled, () => "") === "1";

  it.live.skipIf(!remoteEnabled)(
    "generates all supported languages from a remote project",
    () =>
      withTempHome((home) =>
        Effect.gen(function* () {
          const project = yield* makeStackProject("supabase-typegen-remote-e2e-");
          if (Option.isNone(remote.projectRef) || Option.isNone(remote.accessToken)) {
            return yield* new TypegenE2eSetupError({
              message: `Set ${REMOTE_E2E_FLAG}=1, ${REMOTE_PROJECT_REF_ENV}, and SUPABASE_ACCESS_TOKEN to run remote typegen e2e.`,
            });
          }
          const remoteProjectRef = remote.projectRef.value;
          const remoteAccessToken = remote.accessToken.value;

          for (const lang of TYPEGEN_LANGS) {
            const result = yield* runSupabaseEffect(
              [
                "gen",
                "types",
                "--project-id",
                remoteProjectRef,
                "--lang",
                lang,
                "--schema",
                "public",
              ],
              {
                cwd: project.dir,
                home: home.dir,
                env: remoteEnv(remoteAccessToken, project.dir),
                exitTimeoutMs: TYPEGEN_TIMEOUT_MS,
              },
            );
            expectSucceeded(`supabase gen types --project-id <ref> --lang ${lang}`, result);
            expectLanguageShape(lang, result.stdout);
          }
        }),
      ).pipe(Effect.provide(BunServices.layer)),
    { timeout: RESOLVE_BUDGET_MS + TYPEGEN_TIMEOUT_MS * TYPEGEN_LANGS.length },
  );
});
