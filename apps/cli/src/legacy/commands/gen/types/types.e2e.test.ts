import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Config,
  ConfigProvider,
  Duration,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type { PlatformError } from "effect/PlatformError";
import {
  makeTempHomeEffect,
  makeTempStackProjectEffect,
  runSupabaseEffect,
} from "../../../../../tests/helpers/cli.ts";
import { dockerfileServiceImage } from "../../../../shared/services/dockerfile-images.ts";
import { localDbContainerId, localNetworkId } from "../../../shared/legacy-docker-ids.ts";
import { legacyGetRegistryImageUrl } from "../../../shared/legacy-docker-registry.ts";
import { legacyPgDeltaSslProbeLayer } from "../../../shared/legacy-pgdelta-ssl-probe.layer.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import {
  RESOLVE_BUDGET_MS,
  ensureImage,
  resolveDeadline,
} from "../../../../../tests/helpers/docker-image.ts";
import { resolvePgmetaImage } from "./types.shared.ts";

const TYPEGEN_LANGS = ["typescript", "go", "swift", "python"] as const;
type TypegenLang = (typeof TYPEGEN_LANGS)[number];

class LegacyTypegenE2eError extends Data.TaggedError("LegacyTypegenE2eError")<{
  readonly message: string;
}> {}

type LegacyTypegenE2eProject = Effect.Success<ReturnType<typeof makeTempStackProjectEffect>>;

const LOCAL_POSTGRES_IMAGE = legacyGetRegistryImageUrl(dockerfileServiceImage("pg"), {});
const LOCAL_POSTGRES_TIMEOUT_MS = 120_000;
const TYPEGEN_TIMEOUT_MS = 90_000;
// Image resolution happens inside the test bodies, ahead of the startup and
// per-language windows the test timeouts already budget — so each timeout has
// to include its own image setup allowance on top.
const LOCAL_IMAGE_BUDGET_MS = LOCAL_POSTGRES_TIMEOUT_MS + TYPEGEN_TIMEOUT_MS;
const REMOTE_E2E_FLAG = "SUPABASE_TYPEGEN_E2E_REMOTE";
const REMOTE_PROJECT_REF_ENV = "SUPABASE_TEST_PROJECT_REF";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

const path = Effect.runSync(Path.Path.pipe(Effect.provide(BunServices.layer)));
const join = (first: string, ...rest: ReadonlyArray<string>) => path.join(first, ...rest);

function acquireTempStackProject(
  prefix: string,
): Effect.Effect<
  LegacyTypegenE2eProject,
  LegacyTypegenE2eError,
  FileSystem.FileSystem | Path.Path | Scope.Scope
> {
  const create = makeTempStackProjectEffect(prefix).pipe(
    Effect.mapError((cause) => new LegacyTypegenE2eError({ message: String(cause) })),
  );
  return Effect.acquireRelease(create, (project) => project.cleanupEffect.pipe(Effect.ignore));
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

function writeOfflineProfile(projectDir: string): Effect.Effect<string, PlatformError> {
  const profilePath = join(projectDir, "offline-profile.yaml");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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
  }).pipe(Effect.provide(BunServices.layer));
}

function writeLocalConfig(
  projectDir: string,
  projectId: string,
  dbPort: number,
): Effect.Effect<void, PlatformError> {
  const supabaseDir = join(projectDir, "supabase");
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(supabaseDir, { recursive: true });
    yield* fs.writeFileString(
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
  }).pipe(Effect.provide(BunServices.layer));
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

function runCommand(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly timeoutMs?: number } = {},
): Effect.Effect<
  CommandResult,
  LegacyTypegenE2eError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(ChildProcess.make(command, args));
    const read = (
      stream: Stream.Stream<Uint8Array, PlatformError>,
    ): Effect.Effect<string, PlatformError> =>
      stream.pipe(
        Stream.decodeText,
        Stream.runFold(
          () => "",
          (output, chunk) => output + chunk,
        ),
      );
    const exitCode =
      options.timeoutMs === undefined
        ? yield* child.exitCode
        : yield* child.exitCode.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(options.timeoutMs),
              orElse: () =>
                child.kill({ killSignal: "SIGKILL" }).pipe(Effect.andThen(child.exitCode)),
            }),
          );
    const [stdout, stderr] = yield* Effect.all([read(child.stdout), read(child.stderr)]);
    return { stdout, stderr, exitCode: Number(exitCode) };
  }).pipe(Effect.mapError((cause) => new LegacyTypegenE2eError({ message: String(cause) })));
}

function runDocker(
  args: ReadonlyArray<string>,
  options?: { readonly timeoutMs?: number },
): Effect.Effect<
  CommandResult,
  LegacyTypegenE2eError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return runCommand("docker", args, options);
}

function expectDockerSucceeded(
  args: ReadonlyArray<string>,
  timeoutMs?: number,
): Effect.Effect<
  CommandResult,
  LegacyTypegenE2eError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  return runDocker(args, { timeoutMs }).pipe(
    Effect.tap((result) => Effect.sync(() => expectSucceeded(`docker ${args.join(" ")}`, result))),
  );
}

function waitForLocalPostgres(containerName: string, dbPort: number) {
  const check = runDocker(
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
  ).pipe(
    Effect.filterOrFail(
      (result) => result.exitCode === 0 && result.stdout.trim() === "1",
      (result) => new LegacyTypegenE2eError({ message: combinedOutput(result) }),
    ),
  );
  const waitForPublishedHost = Effect.gen(function* () {
    const probe = yield* LegacyPgDeltaSslProbe;
    yield* probe.requireSslForHost("127.0.0.1", dbPort);
  }).pipe(
    Effect.provide(legacyPgDeltaSslProbeLayer),
    Effect.mapError((cause) => new LegacyTypegenE2eError({ message: String(cause) })),
    Effect.retry(Schedule.max([Schedule.spaced(Duration.seconds(1)), Schedule.recurs(120)])),
  );

  return check.pipe(
    Effect.retry(Schedule.max([Schedule.spaced(Duration.seconds(1)), Schedule.recurs(120)])),
    Effect.andThen(waitForPublishedHost),
    Effect.asVoid,
  );
}

// `gen types` starts pg-meta itself (local AND remote non-ts languages) via a
// single-registry rewrite with no fallback (`resolvePgmetaImage`), so pre-resolve
// it and retag the winning candidate onto the exact reference the CLI will run.
function ensureImageEffect(
  image: string,
  deadline?: number,
): Effect.Effect<string, LegacyTypegenE2eError> {
  return Effect.tryPromise({
    try: () => ensureImage(image, deadline),
    catch: (cause): LegacyTypegenE2eError => new LegacyTypegenE2eError({ message: String(cause) }),
  });
}

function ensurePgmetaImage(
  deadline?: number,
): Effect.Effect<
  string,
  LegacyTypegenE2eError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const expected = resolvePgmetaImage();
  return Effect.gen(function* () {
    const resolved = yield* ensureImageEffect(dockerfileServiceImage("pgmeta"), deadline);
    if (resolved !== expected) {
      yield* expectDockerSucceeded(["tag", resolved, expected], 30_000);
    }
    return resolved;
  });
}

function startLocalPostgres(input: {
  readonly projectId: string;
  readonly dbPort: number;
}): Effect.Effect<
  { readonly containerName: string; readonly networkName: string },
  LegacyTypegenE2eError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const containerName = localDbContainerId(input.projectId);
  const networkName = localNetworkId(input.projectId);
  // One shared window (already counted in the local test's timeout), with
  // pg-meta's slice reserved up front: Postgres may spend the window only up
  // to the point that still leaves pg-meta the default budget.
  const imageDeadline = resolveDeadline(LOCAL_IMAGE_BUDGET_MS);
  return Effect.gen(function* () {
    const postgresImage = yield* ensureImageEffect(
      LOCAL_POSTGRES_IMAGE,
      imageDeadline - RESOLVE_BUDGET_MS,
    );
    yield* ensurePgmetaImage(imageDeadline);
    yield* expectDockerSucceeded(["network", "create", networkName], 30_000);
    yield* expectDockerSucceeded(
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
    yield* waitForLocalPostgres(containerName, input.dbPort);
    return { containerName, networkName };
  });
}

function seedSmokeTable(containerName: string) {
  return expectDockerSucceeded(
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

function cleanupLocalPostgres(input: {
  readonly containerName: string;
  readonly networkName: string;
}) {
  return Effect.all(
    [
      runDocker(["rm", "-f", input.containerName], { timeoutMs: 30_000 }),
      runDocker(["network", "rm", input.networkName], { timeoutMs: 30_000 }),
    ],
    { discard: true },
  );
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
        LOCAL_IMAGE_BUDGET_MS +
        LOCAL_POSTGRES_TIMEOUT_MS +
        TYPEGEN_TIMEOUT_MS * TYPEGEN_LANGS.length,
    },
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const home = yield* Effect.acquireRelease(
              makeTempHomeEffect,
              (value) => value.disposeEffect,
            );
            const project = yield* acquireTempStackProject("supabase-typegen-local-e2e-");
            const projectId = `typegen${project.ports.dbPort}`;
            const profilePath = yield* writeOfflineProfile(project.dir);
            const env = tokenlessEnv(profilePath, project.dir);
            const localPostgres = {
              containerName: localDbContainerId(projectId),
              networkName: localNetworkId(projectId),
            };

            yield* writeLocalConfig(project.dir, projectId, project.ports.dbPort);
            yield* cleanupLocalPostgres(localPostgres);
            yield* project.portLease.release(["dbPort"]);
            yield* startLocalPostgres({ projectId, dbPort: project.ports.dbPort });
            yield* seedSmokeTable(localPostgres.containerName);

            yield* Effect.ensuring(
              Effect.forEach(
                TYPEGEN_LANGS,
                (lang) =>
                  runSupabaseEffect(
                    ["gen", "types", "--local", "--lang", lang, "--schema", "public"],
                    {
                      cwd: project.dir,
                      home: home.dir,
                      env,
                      entrypoint: "legacy",
                      exitTimeoutMs: TYPEGEN_TIMEOUT_MS,
                    },
                  ).pipe(
                    Effect.tap((result) =>
                      Effect.sync(() => {
                        expectSucceeded(`supabase gen types --local --lang ${lang}`, result);
                        expectNoRemoteAuthPath(result);
                        expectLanguageShape(lang, result.stdout);
                        expectLocalSmokeTable(lang, result.stdout);
                      }),
                    ),
                  ),
                { discard: true },
              ),
              cleanupLocalPostgres(localPostgres).pipe(Effect.ignore),
            );
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      ),
  );

  const remoteProjectRef = Option.getOrUndefined(
    Effect.runSync(
      Config.option(Config.string(REMOTE_PROJECT_REF_ENV)).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
        ),
      ),
    ),
  );
  const remoteAccessToken = Option.getOrUndefined(
    Effect.runSync(
      Config.option(Config.string("SUPABASE_ACCESS_TOKEN")).pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
        ),
      ),
    ),
  );
  const remoteEnabled =
    Option.getOrUndefined(
      Effect.runSync(
        Config.option(Config.string(REMOTE_E2E_FLAG)).pipe(
          Effect.provide(
            ConfigProvider.layer(ConfigProvider.fromEnv({ preserveEmptyStrings: true })),
          ),
        ),
      ),
    ) === "1";

  const remoteTest = remoteEnabled ? test : test.skip;

  remoteTest(
    "generates all supported languages from a remote project",
    { timeout: RESOLVE_BUDGET_MS + TYPEGEN_TIMEOUT_MS * TYPEGEN_LANGS.length },
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const home = yield* Effect.acquireRelease(
              makeTempHomeEffect,
              (value) => value.disposeEffect,
            );
            const project = yield* acquireTempStackProject("supabase-typegen-remote-e2e-");
            if (
              remoteProjectRef === undefined ||
              remoteProjectRef.length === 0 ||
              remoteAccessToken === undefined ||
              remoteAccessToken.length === 0
            ) {
              return yield* new LegacyTypegenE2eError({
                message: `Set ${REMOTE_E2E_FLAG}=1, ${REMOTE_PROJECT_REF_ENV}, and SUPABASE_ACCESS_TOKEN to run remote typegen e2e.`,
              });
            }

            yield* ensurePgmetaImage();

            yield* Effect.forEach(
              TYPEGEN_LANGS,
              (lang) =>
                runSupabaseEffect(
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
                    entrypoint: "legacy",
                    exitTimeoutMs: TYPEGEN_TIMEOUT_MS,
                  },
                ).pipe(
                  Effect.tap((result) =>
                    Effect.sync(() => {
                      expectSucceeded(
                        `supabase gen types --project-id <ref> --lang ${lang}`,
                        result,
                      );
                      expectLanguageShape(lang, result.stdout);
                    }),
                  ),
                ),
              { discard: true },
            );
          }),
        ).pipe(Effect.provide(BunServices.layer)),
      ),
  );
});
