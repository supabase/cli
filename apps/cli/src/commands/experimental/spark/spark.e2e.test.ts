// One sequential scenario for the experimental Spark backend, driven through the compiled CLI:
// start the stack, run the example app, Studio and MCP checks, then the Spark command tree on the
// local target and on a linked project, and stop. Needs SUPABASE_SPARK_BIN; without it the suite is
// skipped. Later steps depend on earlier ones, so the first failure fails the rest fast.
import { BunServices } from "@effect/platform-bun";
import {
  Config,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Schema,
  Scope,
  Stream,
} from "effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterAll, describe, expect, test } from "vitest";
import {
  createTempHome,
  helperRejection,
  portIsFree,
  requireCliSuccess,
  spawnSupabase,
  type SpawnSupabaseOptions,
  stripAnsi,
  type TempHome,
} from "../../../../tests/helpers/cli.ts";
import { serveSparkManagementApi } from "../../../../tests/helpers/spark-management-api.ts";

const STEP_TIMEOUT_MS = 600_000;
const CLI_CANCEL_GRACE_MS = 20_000;
/** Stopping a cancelled step's commands: a SIGTERM, then a SIGKILL after a grace period. */
const STEP_CANCEL_TIMEOUT_MS = 60_000;
const CLI_EXIT_TIMEOUT_MS = 280_000;
const DESTROY_EXIT_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = STEP_CANCEL_TIMEOUT_MS + DESTROY_EXIT_TIMEOUT_MS + 60_000;

const API = "http://127.0.0.1:54321";
const STUDIO = "http://127.0.0.1:54323";
const STACK_PORTS = [54321, 54322, 54323];
// The test's stand-in Management API accepts any token in the client's format and any 20-letter ref.
const PROJECT_REF = "sparkpocprojectlocal";
const ACCESS_TOKEN = `sbp_${"0".repeat(40)}`;

const envValue = (name: string) => Effect.runSync(Config.String(name).pipe(Config.withDefault("")));
const sparkBin = envValue("SUPABASE_SPARK_BIN");
const exampleDir = envValue("SPARK_EXAMPLE_DIR");
const mcpCli = envValue("SUPABASE_MCP_CLI");
const studioBin = envValue("SUPABASE_SPARK_STUDIO_BIN");

const hostRuntime = ManagedRuntime.make(Layer.mergeAll(BunServices.layer));
afterAll(() => hostRuntime.dispose());
const { join } = hostRuntime.runSync(Path.Path);
const fsOp = <A>(operation: (fs: FileSystem.FileSystem) => Effect.Effect<A, unknown>) =>
  hostRuntime.runPromise(Effect.flatMap(FileSystem.FileSystem, operation));

const exists = (path: string) => fsOp((fs) => fs.exists(path));
const readText = (path: string) => fsOp((fs) => fs.readFileString(path));
const writeText = (path: string, text: string) => fsOp((fs) => fs.writeFileString(path, text));
const removePath = (path: string) =>
  fsOp((fs) => fs.remove(path, { recursive: true, force: true }));
const listDir = (path: string) => fsOp((fs) => fs.readDirectory(path, { recursive: true }));

/** The step that is running; its commands end when its signal aborts. */
interface ActiveStep {
  readonly controller: AbortController;
  readonly commands: Set<Promise<void>>;
}
let activeStep: ActiveStep | undefined;

/** Starts a command the running step owns; `start` stops it when the step's signal aborts. */
const track = <A>(start: (signal: AbortSignal | undefined) => Promise<A>): Promise<A> => {
  const step = activeStep;
  if (step === undefined) return start(undefined);
  if (step.controller.signal.aborted) return Promise.reject(new Error("the step was cancelled"));
  const run = start(step.controller.signal);
  step.commands.add(
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
};

/** Runs an effect the running step owns, interrupted when the step is cancelled. */
const owned = <A, E>(effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>) =>
  track((signal) => hostRuntime.runPromise(effect, signal === undefined ? undefined : { signal }));

/**
 * Runs the CLI; a cancelled step sends it SIGTERM, so it removes what it started (shadow
 * containers), and SIGKILL after `CLI_CANCEL_GRACE_MS`.
 */
const runCli = (
  args: Array<string>,
  options: SpawnSupabaseOptions,
  signal: AbortSignal | undefined,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawned = yield* spawnSupabase(args, options);
      if (signal !== undefined) {
        const aborted = Effect.callback<void>((resume) => {
          const onAbort = () => resume(Effect.void);
          if (signal.aborted) return onAbort();
          signal.addEventListener("abort", onAbort, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", onAbort));
        });
        yield* Effect.forkScoped(
          aborted.pipe(
            Effect.andThen(spawned.kill("SIGTERM")),
            Effect.andThen(Effect.sleep(CLI_CANCEL_GRACE_MS)),
            Effect.andThen(spawned.kill("SIGKILL")),
          ),
        );
      }
      return yield* spawned.waitForExit();
    }),
  ).pipe(Effect.mapError(helperRejection));

/** Interrupts the step's commands and waits until each has exited. */
const cancelStep = (step: ActiveStep) => {
  step.controller.abort();
  return Promise.all(step.commands);
};

// Under `bun --bun vitest`, NODE_PATH points at vitest's modules, which break the compiled CLI,
// and the first PATH entry is a `node` shim that is bun.
const hostEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "NODE_PATH" && key !== "NODE") env[key] = value;
  }
  env["PATH"] = (env["PATH"] ?? "")
    .split(":")
    .filter((entry) => !entry.includes("bun-node-"))
    .join(":");
  return { ...env, ...extra };
};
const execEffect = (
  file: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(file, args, {
          cwd: options.cwd,
          env: options.env,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "5 seconds",
        }),
      );
      const [code, stdout, stderr] = yield* Effect.all(
        [
          child.exitCode,
          Stream.mkString(Stream.decodeText(child.stdout)),
          Stream.mkString(Stream.decodeText(child.stderr)),
        ],
        { concurrency: "unbounded" },
      );
      return { code: Number(code), out: `${stdout}${stderr}` };
    }),
  ).pipe(
    Effect.timeoutOrElse({
      duration: CLI_EXIT_TIMEOUT_MS,
      orElse: () =>
        Effect.succeed({ code: 1, out: `${file}: no exit within ${CLI_EXIT_TIMEOUT_MS} ms` }),
    }),
    Effect.catchTag("PlatformError", (error) =>
      Effect.succeed({ code: 1, out: `${file}: ${String(error)}` }),
    ),
  );
const exec = (...args: Parameters<typeof execEffect>) => owned(execEffect(...args));

const Rows = Schema.fromJsonString(Schema.Array(Schema.Record(Schema.String, Schema.Unknown)));
const parseRows = (stdout: string) => Schema.decodeSync(Rows)(stdout);
const ProjectDetail = Schema.fromJsonString(Schema.Struct({ postgres_engine: Schema.String }));
const LinkFile = Schema.fromJsonString(
  Schema.Struct({ project: Schema.Struct({ ref: Schema.String }) }),
);
const RestError = Schema.fromJsonString(Schema.Struct({ code: Schema.String }));

describe.skipIf(sparkBin === "")("experimental spark backend (e2e)", () => {
  let workDir = "";
  let projectDir = "";
  let home: TempHome | undefined;
  // Every path that marks a process or container as this run's: the temp project and CLI home,
  // as given and resolved (macOS /tmp is /private/tmp).
  let ownedPaths: ReadonlyArray<string> = [];
  // A fixed port another stack held before this run is not this run's to release.
  let portsFreeAtStart: ReadonlyArray<number> = [];
  let anonKey = "";
  let serviceKey = "";
  let todosBefore = 0;
  let failedStep: string | undefined;
  let managementApiScope: Scope.Closeable | undefined;
  let managementApi = "";

  // The local target needs none of these; the linked-project step sets them.
  const baseEnv = (): Record<string, string | undefined> => ({
    SUPABASE_EXPERIMENTAL_SPARK_STUDIO_EXECUTABLE: studioBin,
    SUPABASE_PROFILE: undefined,
    SUPABASE_ACCESS_TOKEN: undefined,
    SUPABASE_PROJECT_ID: undefined,
    SUPABASE_YES: undefined,
    NODE_PATH: undefined,
    DO_NOT_TRACK: "1",
  });
  let cliEnv = baseEnv();

  const sb = async (
    args: string[],
    options: { readonly stdin?: string; readonly exitTimeoutMs?: number } = {},
  ) => {
    if (home === undefined) throw new Error("no CLI home");
    const spawnOptions: SpawnSupabaseOptions = {
      cwd: projectDir,
      home: home.dir,
      env: cliEnv,
      exitTimeoutMs: options.exitTimeoutMs ?? CLI_EXIT_TIMEOUT_MS,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    };
    const result = await track((signal) =>
      hostRuntime.runPromise(runCli(args, spawnOptions, signal)),
    );
    const stdout = stripAnsi(result.stdout);
    const stderr = stripAnsi(result.stderr);
    return {
      exitCode: result.exitCode,
      stdout: stdout.replace(/\n+$/, ""),
      log: `${stdout}${stderr}`,
      raw: result,
    };
  };
  const run = async (args: string[]) => {
    const result = await sb(args);
    requireCliSuccess(result.raw, `supabase ${args.join(" ")}`);
    return result;
  };
  const runFails = async (args: string[]) => {
    const result = await sb(args);
    expect(result.exitCode, `supabase ${args.join(" ")} succeeded:\n${result.log}`).not.toBe(0);
    return result;
  };
  const expectNoSchemaChanges = async (args: string[]) => {
    const result = await sb(args);
    requireCliSuccess(result.raw, `supabase ${args.join(" ")}`);
    expect(result.stdout, `supabase ${args.join(" ")}`).toBe("No schema changes found");
  };
  const keyFromStatus = (env: string, name: string) =>
    new RegExp(`^${name}='(.*)'$`, "m").exec(env)?.[1] ?? "";

  const rest = (path: string, init: RequestInit = {}) =>
    fetch(`${API}/rest/v1/${path}`, {
      ...init,
      signal: activeStep?.controller.signal ?? null,
      headers: {
        apikey: serviceKey,
        authorization: `Bearer ${serviceKey}`,
        ...init.headers,
      },
    });
  const restCount = async (path: string) => {
    const response = await rest(path);
    return (parseRows(await response.text()) as ReadonlyArray<unknown>).length;
  };
  const restStatus = async (path: string) => (await rest(path)).status;

  const check = async (script: string, extraEnv: Record<string, string> = {}) => {
    const result = await exec("node", [join(exampleDir, script)], {
      cwd: projectDir,
      env: hostEnv({ ANON_KEY: anonKey, SERVICE_KEY: serviceKey, ...extraEnv }),
    });
    expect(result.code, `${script} failed:\n${result.out}`).toBe(0);
  };

  const noPostgres = async () => {
    const real = await fsOp((fs) => fs.realPath(projectDir));
    const docker = await exec("docker", [
      "ps",
      "--format",
      '{{.Image}} {{.Names}} {{.Label "com.supabase.stack-root"}} {{.Label "com.supabase.cli.workdir"}}',
    ]);
    const processes = await exec("pgrep", ["-af", "postgres"]);
    // Scoped to this project: other Postgres on the machine is not this stack's.
    const found = `${docker.out}${processes.out}`
      .split("\n")
      .filter(
        (line) => /postgres/i.test(line) && (line.includes(projectDir) || line.includes(real)),
      )
      .join("\n");
    expect(found, "Postgres is running").toBe("");
  };

  // Other stacks on the machine run the same Spark binary, so a process is this run's only when its
  // command line names this run's project or CLI home (Spark's --workdir, the stack owner's state
  // directory), or it descends from one that does.
  const ownedProcessesEffect = Effect.gen(function* () {
    const ps = yield* execEffect("ps", ["-ww", "-Ao", "pid=,ppid=,command="]);
    if (ps.code !== 0) return yield* Effect.die(`ps failed:\n${ps.out}`);
    const table = ps.out.split("\n").flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
      return match === null
        ? []
        : [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }];
    });
    const ours = new Set(
      table
        .filter((row) => ownedPaths.some((path) => row.command.includes(path)))
        .map((row) => row.pid),
    );
    for (let grew = true; grew;) {
      grew = false;
      for (const row of table) {
        if (ours.has(row.ppid) && !ours.has(row.pid)) {
          ours.add(row.pid);
          grew = true;
        }
      }
    }
    return table.filter((row) => ours.has(row.pid));
  });
  const ownedProcesses = () => owned(ownedProcessesEffect);

  const ownedContainersEffect = Effect.gen(function* () {
    const listed = yield* execEffect("docker", [
      "ps",
      "--all",
      "--format",
      '{{.ID}} {{.Label "com.supabase.cli.workdir"}}',
    ]);
    if (listed.code !== 0) return yield* Effect.die(`docker ps failed:\n${listed.out}`);
    return listed.out
      .split("\n")
      .filter((line) => ownedPaths.some((path) => line.endsWith(` ${path}`)))
      .map((line) => line.split(" ")[0] ?? "");
  });
  const ownedContainers = () => owned(ownedContainersEffect);

  /** What this run's stack left behind: its processes, containers and bound ports. */
  const stackLeftovers = () =>
    owned(
      Effect.all({
        processes: ownedProcessesEffect,
        containers: ownedContainersEffect,
        boundPorts: Effect.filter(portsFreeAtStart, (port) =>
          Effect.map(portIsFree(port), (free) => !free),
        ),
      }),
    );

  const schemaFiles = async () => {
    const entries = await listDir(join(projectDir, "supabase", "schemas"));
    return entries.filter((entry) => entry.endsWith(".sql"));
  };
  const migrationFiles = async (suffix: string) =>
    (await listDir(join(projectDir, "supabase", "migrations"))).filter((entry) =>
      entry.endsWith(suffix),
    );

  // The step owns its timeout: vitest's own fires outside the body and would leave its commands
  // running into the next step.
  const step = (name: string, body: () => Promise<void>) =>
    test(name, { timeout: STEP_TIMEOUT_MS + STEP_CANCEL_TIMEOUT_MS }, async () => {
      if (failedStep !== undefined) throw new Error(`skipped: step "${failedStep}" failed`);
      failedStep = name;
      const current: ActiveStep = { controller: new AbortController(), commands: new Set() };
      activeStep = current;
      const outcome = body();
      const settled = outcome.then(
        () => undefined,
        () => undefined,
      );
      const finished = await hostRuntime.runPromise(
        Effect.promise(() => settled).pipe(Effect.timeoutOption(STEP_TIMEOUT_MS)),
      );
      await cancelStep(current);
      await settled;
      activeStep = undefined;
      if (Option.isNone(finished)) {
        throw new Error(`timed out after ${STEP_TIMEOUT_MS} ms; its commands were stopped`);
      }
      await outcome;
      failedStep = undefined;
    });

  afterAll(async () => {
    if (activeStep !== undefined) await cancelStep(activeStep);
    activeStep = undefined;
    if (managementApiScope !== undefined)
      await hostRuntime.runPromise(Scope.close(managementApiScope, Exit.void));
    const cliHome = home;
    if (cliHome === undefined) {
      if (workDir !== "") await removePath(workDir);
      return;
    }
    const problems: Array<string> = [];
    const stacksDir = join(cliHome.dir, "stacks");
    const hasStack =
      (await exists(stacksDir)) && (await fsOp((fs) => fs.readDirectory(stacksDir))).length > 0;
    if (hasStack) {
      const destroyed = await sb(["stack", "destroy", "--yes"], {
        exitTimeoutMs: DESTROY_EXIT_TIMEOUT_MS,
      }).then(
        (result) =>
          result.exitCode === 0
            ? undefined
            : `supabase stack destroy exited ${result.exitCode}${result.raw.timedOutAfterMs === undefined ? "" : ` (killed after ${result.raw.timedOutAfterMs} ms)`}:\n${result.log}`,
        (error: unknown) => `supabase stack destroy did not run: ${String(error)}`,
      );
      if (destroyed !== undefined) problems.push(destroyed);
    }
    const left = await stackLeftovers();
    if (
      problems.length === 0 &&
      left.processes.length === 0 &&
      left.containers.length === 0 &&
      left.boundPorts.length === 0
    ) {
      await removePath(workDir);
      await Effect.runPromise(cliHome.dispose);
      return;
    }
    // Only what this run started: exact pids and container ids, never a name pattern.
    if (left.processes.length > 0) {
      await exec("kill", ["-KILL", ...left.processes.map((row) => String(row.pid))]);
    }
    if (left.containers.length > 0) await exec("docker", ["rm", "-f", "-v", ...left.containers]);
    throw new Error(
      [
        "the Spark stack of this run did not shut down cleanly",
        ...problems,
        ...left.processes.map((row) => `killed process ${row.pid}: ${row.command}`),
        ...left.containers.map((id) => `removed container ${id}`),
        ...left.boundPorts.map((port) => `port ${port} is still bound`),
        `kept for diagnosis: the project in ${workDir} and the CLI home with the stack state in ${stacksDir}`,
      ].join("\n"),
    );
  }, CLEANUP_TIMEOUT_MS);

  step(
    "setup: spark, the MCP server, the Studio launcher and the example apps are ready",
    async () => {
      expect(await exists(sparkBin), `no spark binary at ${sparkBin}`).toBe(true);
      expect(exampleDir, "set SPARK_EXAMPLE_DIR to the PoC example apps").not.toBe("");
      expect(
        await exists(join(exampleDir, "node_modules")),
        `run bun install in ${exampleDir}`,
      ).toBe(true);
      expect(mcpCli, "set SUPABASE_MCP_CLI to a built Supabase MCP server").not.toBe("");
      expect(await exists(mcpCli), `no Supabase MCP server at ${mcpCli}`).toBe(true);
      expect(
        studioBin,
        "set SUPABASE_SPARK_STUDIO_BIN to a Studio launcher with the Spark pg-meta fallbacks: the pinned Studio build has none, so the Studio step cannot pass",
      ).not.toBe("");
      expect(
        await exists(studioBin),
        `no Studio launcher at SUPABASE_SPARK_STUDIO_BIN=${studioBin}`,
      ).toBe(true);
      // The path checked here, absolute, is the one the CLI gets: the variable wins over config.toml.
      cliEnv = {
        ...baseEnv(),
        SUPABASE_EXPERIMENTAL_SPARK_STUDIO_EXECUTABLE: await fsOp((fs) => fs.realPath(studioBin)),
      };
      const free: Array<number> = [];
      for (const port of STACK_PORTS) {
        if (await hostRuntime.runPromise(portIsFree(port))) free.push(port);
      }
      portsFreeAtStart = free;
      home = await Effect.runPromise(createTempHome);
      workDir = await fsOp((fs) =>
        fs.makeTempDirectory({ directory: "/tmp", prefix: "spark-e2e-" }),
      );
      projectDir = join(workDir, "spark-todos");
      await fsOp((fs) => fs.makeDirectory(projectDir, { recursive: true }));
      const homeDir = home.dir;
      ownedPaths = [
        projectDir,
        await fsOp((fs) => fs.realPath(projectDir)),
        homeDir,
        await fsOp((fs) => fs.realPath(homeDir)),
      ];
    },
  );

  step(
    "supabase init in a new project, a todos migration, and [experimental.spark] enabled in config.toml",
    async () => {
      await run(["init"]);
      await fsOp((fs) =>
        fs.makeDirectory(join(projectDir, "supabase", "migrations"), { recursive: true }),
      );
      await writeText(
        join(projectDir, "supabase", "migrations", "20260101000000_todos.sql"),
        await readText(join(exampleDir, "todos.sql")),
      );
      const configPath = join(projectDir, "supabase", "config.toml");
      await writeText(
        configPath,
        `${await readText(configPath)}\n[experimental.spark]\nenabled = true\nexecutable = "${sparkBin}"\n`,
      );
    },
  );

  step("supabase start: Spark and Studio on the native stack (no Postgres)", async () => {
    const started = await run(["start"]);
    expect(started.log).toContain("Stack is ready");
    expect(started.log).toContain("spark");
    await noPostgres();
  });

  step("supabase status reports the Spark stack and its keys", async () => {
    const status = await run(["status"]);
    expect(status.log).toContain(API);
    expect(status.log).toContain("spark");
    const env = (await run(["status", "--env"])).log;
    anonKey = keyFromStatus(env, "ANON_KEY");
    serviceKey = keyFromStatus(env, "SERVICE_ROLE_KEY");
    expect(anonKey, "supabase status --env printed no ANON_KEY").not.toBe("");
    expect(serviceKey, "supabase status --env printed no SERVICE_ROLE_KEY").not.toBe("");
  });

  step("app (supabase-js): sign up, CRUD and RLS isolation on todos", async () => {
    await check("app.test.mjs");
  });

  step(
    "Studio: table editor rows, create table and insert row from the UI, policies page, SQL editor; the new table is on Spark, not in a migration",
    async () => {
      const response = await fetch(`${STUDIO}/api/platform/projects/default`);
      expect(response.ok, `Studio project detail: HTTP ${response.status}`).toBe(true);
      const detail = Schema.decodeSync(ProjectDetail)(await response.text());
      expect(detail.postgres_engine, "Studio's project detail engine").toBe("spark");
      const historyBefore = (await run(["migration", "list"])).log;
      await check("studio.check.mjs");
      expect(await restStatus("comments?select=id"), "Studio's table is not served").toBe(200);
      expect(
        await migrationFiles(".sql"),
        "a change made in Studio wrote a migration file",
      ).toEqual(["20260101000000_todos.sql"]);
      expect(
        (await run(["migration", "list"])).log,
        "a change made in Studio was recorded in Spark's migration history",
      ).toBe(historyBefore);
      await noPostgres();
    },
  );

  step(
    "MCP: list_tables, apply_migration, execute_sql, list_migrations, generate_typescript_types, get_project_url; migration fetch writes the applied migration's file",
    async () => {
      const mcpCheck = await readText(join(exampleDir, "mcp.check.mjs"));
      expect(mcpCheck, "the MCP check does not start the MCP server from MCP_CLI").toContain(
        "process.env.MCP_CLI",
      );
      expect(mcpCheck, "the MCP check does not take its --api-url from MCP_API_URL").toContain(
        "process.env.MCP_API_URL",
      );
      const scope = await hostRuntime.runPromise(Scope.make());
      managementApiScope = scope;
      managementApi = await hostRuntime.runPromise(
        serveSparkManagementApi({ sparkUrl: API, serviceRoleKey: serviceKey, anonKey }).pipe(
          Scope.provide(scope),
          Effect.provide(FetchHttpClient.layer),
        ),
      );
      await check("mcp.check.mjs", { MCP_CLI: mcpCli, MCP_API_URL: managementApi });
      expect(
        await migrationFiles("_add_labels.sql"),
        "the Management API wrote a migration file",
      ).toHaveLength(0);
      expect(
        (await runFails(["db", "push"])).log,
        "db push accepted a history with a version that has no local file",
      ).toContain("Remote migration versions not found in local migrations directory");
      await run(["migration", "fetch", "--yes"]);
      const fetched = await migrationFiles("_add_labels.sql");
      expect(fetched, "migration fetch wrote no add_labels migration").toHaveLength(1);
      expect(
        await readText(join(projectDir, "supabase", "migrations", fetched[0] ?? "")),
        "the fetched migration is not what apply_migration ran",
      ).toMatch(/^create table public\.labels \(.*;\n$/s);
      expect(
        await readText(join(projectDir, "supabase", "migrations", "20260101000000_todos.sql")),
        "migration fetch changed a migration that was pushed from its local file",
      ).toBe(await readText(join(exampleDir, "todos.sql")));
      expect((await run(["db", "push"])).log).toContain("Remote database is up to date");
    },
  );

  step("gen types typescript on the local target (no profile, token or link)", async () => {
    const types = await run(["gen", "types", "typescript"]);
    expect(types.log).toContain('"todos": {');
    expect(await exists(join(projectDir, "supabase", ".link.json"))).toBe(false);
  });

  step(
    "db pull: the project's dump in a shadow Postgres, exported by pg-delta to supabase/schemas, with the RLS policies, the table made in Studio and none of the image-only files",
    async () => {
      await run(["db", "pull"]);
      expect(await exists(join(projectDir, "supabase/schemas/public/tables/todos.sql"))).toBe(true);
      expect(
        await exists(join(projectDir, "supabase/schemas/public/tables/comments.sql")),
        "db pull did not capture the table made in Studio",
      ).toBe(true);
      const files = await schemaFiles();
      const texts = await Promise.all(
        files.map((file) => readText(join(projectDir, "supabase", "schemas", file))),
      );
      expect(texts.some((text) => /create policy "Users manage their own todos"/i.test(text))).toBe(
        true,
      );
      // The shadow image's own grants, default privileges and extensions are not in Spark, which refuses them.
      for (const imageOnly of [
        "default_privileges.sql",
        "adp_wipes.sql",
        "schema.sql",
        "pgcrypto.sql",
        "uuid-ossp.sql",
      ]) {
        expect(
          files.filter((file) => file.split("/").pop() === imageOnly),
          `db pull wrote ${imageOnly}, which comes from the shadow image`,
        ).toEqual([]);
      }
    },
  );

  step(
    "db diff on the freshly pulled files (Spark, dump, shadow round trip): No schema changes found",
    async () => {
      await expectNoSchemaChanges(["db", "diff", "-f", "noop"]);
      await noPostgres();
    },
  );

  step(
    "edit schema files (new column, projects table with FK, RLS policy, index); db diff -f add_projects: Dry run on Spark: OK",
    async () => {
      const todosPath = join(projectDir, "supabase/schemas/public/tables/todos.sql");
      await writeText(
        todosPath,
        (await readText(todosPath)).replace(
          '"done"',
          () => '"priority" integer not null default 0,\n  "done"',
        ),
      );
      await writeText(
        join(projectDir, "supabase/schemas/public/tables/projects.sql"),
        `create table "public"."projects" (
  "id"       bigint generated by default as identity primary key,
  "owner_id" uuid not null default auth.uid() references auth.users (id) on delete cascade,
  "name"     text not null
);
create index "projects_owner_id_idx" on "public"."projects" ("owner_id");
alter table "public"."projects" enable row level security;
create policy "Owners manage projects" on "public"."projects" for all to authenticated
  using (auth.uid() = owner_id) with check (auth.uid() = owner_id);
grant all on table "public"."projects" to "authenticated";
`,
      );
      todosBefore = await restCount("todos?select=id");
      const diff = await run(["db", "diff", "-f", "add_projects"]);
      expect(diff.log).toContain("Dry run on Spark: OK");
      expect(
        await migrationFiles("_add_projects.sql"),
        "no add_projects migration file",
      ).toHaveLength(1);
    },
  );

  step(
    "db push applies the migration (dry run first), existing rows kept; pg_policies lists both policies",
    async () => {
      const push = await run(["db", "push"]);
      expect(push.log).toContain("Finished supabase db push");
      const query = await run([
        "db",
        "query",
        "-o",
        "json",
        "select policyname from pg_policies where schemaname = 'public'",
      ]);
      const policies = parseRows(query.stdout).map((row) => row["policyname"]);
      expect(policies).toContain("Owners manage projects");
      expect(policies).toContain("Users manage their own todos");
      expect(await restCount("todos?select=id"), "db push lost todos rows").toBe(todosBefore);
    },
  );

  step(
    "app: the new column and the projects table work over REST (RLS, foreign key enforced)",
    async () => {
      expect(await restStatus("todos?select=priority")).toBe(200);
      await check("feature.check.mjs");
      const response = await rest("projects", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: "orphan",
          owner_id: "00000000-0000-0000-0000-000000000000",
        }),
      });
      const body = Schema.decodeSync(RestError)(await response.text());
      expect(body.code, "the projects foreign key is not enforced").toBe("23503");
    },
  );

  step("db diff after push: No schema changes found", async () => {
    await expectNoSchemaChanges(["db", "diff", "-f", "again"]);
  });

  step("db query -o json: a JSON array of rows from the local Spark server", async () => {
    // Piped, so the command's stdin wiring runs too.
    const result = await sb(["db", "query", "-o", "json"], {
      stdin: "select count(*) as n from public.todos\n",
    });
    requireCliSuccess(result.raw, "supabase db query (stdin)");
    const rows = parseRows(result.stdout);
    expect(rows[0], "db query -o json returned no row with n").toHaveProperty("n");
  });

  let probeUserId = "";
  step(
    "db query: a write survives a later rolled-back script; the failing script's first statement is rolled back",
    async () => {
      // The query route has no JWT, so auth.uid() is null: the probe row borrows a user the app checks created.
      const users = parseRows(
        (await run(["db", "query", "-o", "json", "select id from auth.users limit 1"])).stdout,
      );
      const uid = users[0]?.["id"];
      expect(typeof uid, "db query found no auth user to own the probe row").toBe("string");
      probeUserId = String(uid);
      todosBefore = await restCount("todos?select=id");
      const inserted = parseRows(
        (
          await run([
            "db",
            "query",
            "-o",
            "json",
            `insert into public.todos (user_id, title) values ('${probeUserId}', 'db query probe') returning id, title`,
          ])
        ).stdout,
      );
      const probeId = inserted[0]?.["id"];
      expect(probeId, "db query insert returned no id").toBeDefined();
      expect(probeId).not.toBeNull();
      const failing = await runFails([
        "db",
        "query",
        `insert into public.todos (user_id, title) values ('${probeUserId}', 'rolled back'); insert into public.todos (user_id, title) values ('${probeUserId}', '')`,
      ]);
      expect(failing.log, "db query failed for another reason than the check constraint").toContain(
        "violates check constraint",
      );
      const left = parseRows(
        (
          await run([
            "db",
            "query",
            "-o",
            "json",
            "select id, title from public.todos where title in ('db query probe', 'rolled back') order by id",
          ])
        ).stdout,
      );
      expect(left.map((row) => row["title"])).toEqual(["db query probe"]);
      await run(["db", "query", `delete from public.todos where id = ${String(probeId)}`]);
      expect(await restCount("todos?select=id"), "db query left the probe row behind").toBe(
        todosBefore,
      );
    },
  );

  step("db query --read-only refuses an insert", async () => {
    const refused = await runFails([
      "db",
      "query",
      "--read-only",
      `insert into public.todos (user_id, title) values ('${probeUserId}', 'read only')`,
    ]);
    expect(refused.log).toMatch(/read-only|query_only/);
    expect(await restCount("todos?select=id"), "db query --read-only wrote a row").toBe(
      todosBefore,
    );
  });

  step(
    "an unsupported function in a schema file is refused by the Spark dry run, naming its file and line",
    async () => {
      const functionsFile = join(projectDir, "supabase/schemas/public/functions.sql");
      await writeText(
        functionsFile,
        "create function public.add(a int, b int) returns int\n  language plpgsql as $$ begin return a + b; end $$;\n",
      );
      const refused = await runFails(["db", "diff", "-f", "with_function"]);
      expect(refused.log, "the refusal names no function statement").toMatch(
        /(unsupported|error) [^:]*: create (or replace )?function [^ ]*add/i,
      );
      expect(refused.log, "the refusal names no schema file and line").toMatch(
        /supabase\/schemas\/public\/functions\.sql:[0-9]/,
      );
      expect(
        await migrationFiles("_with_function.sql"),
        "a refused migration was written",
      ).toHaveLength(0);
      await removePath(functionsFile);
    },
  );

  const migrationsPath = (name: string) => join(projectDir, "supabase", "migrations", name);

  step(
    "db push with a refused pending migration applies nothing (one dry run over all pending files)",
    async () => {
      // Two pending files: a good one, then one Spark refuses. The combined dry run must stop both.
      const historyBefore = (await sb(["migration", "list"])).log;
      await writeText(
        migrationsPath("20990101000000_notes.sql"),
        "create table public.notes (id bigint primary key);\n",
      );
      await writeText(
        migrationsPath("20990101000001_events.sql"),
        "-- a date column\ncreate table public.events (\n  id bigint primary key,\n  day date\n);\n",
      );
      const refused = await runFails(["db", "push"]);
      expect(
        refused.log,
        "the push refusal does not name the refused statement's file and line",
      ).toContain("supabase/migrations/20990101000001_events.sql:2");
      expect(
        await restStatus("notes?select=id"),
        "db push applied the good file before the refused one",
      ).not.toBe(200);
      await removePath(migrationsPath("20990101000000_notes.sql"));
      await removePath(migrationsPath("20990101000001_events.sql"));
      expect(
        (await sb(["migration", "list"])).log,
        "migration history changed after a refused push",
      ).toBe(historyBefore);
    },
  );

  step(
    "db push refuses two migration files with the same version before applying anything",
    async () => {
      await writeText(
        migrationsPath("20990101000000_notes.sql"),
        "create table public.notes (id bigint primary key);\n",
      );
      await writeText(
        migrationsPath("20990101000000_other.sql"),
        "create table public.other (id bigint primary key);\n",
      );
      const refused = await runFails(["db", "push"]);
      expect(refused.log).toContain("20990101000000_notes");
      expect(refused.log).toContain("20990101000000_other");
      expect(
        await restStatus("notes?select=id"),
        "db push applied a duplicate-version migration",
      ).not.toBe(200);
      await removePath(migrationsPath("20990101000000_notes.sql"));
      await removePath(migrationsPath("20990101000000_other.sql"));
    },
  );

  step("db dump, db lint, inspect db and test db are not in the Spark command tree", async () => {
    for (const command of [
      ["db", "dump"],
      ["db", "lint"],
      ["inspect", "db", "table-stats"],
      ["test", "db"],
    ]) {
      const result = await runFails(command);
      expect(
        result.log,
        `supabase ${command.join(" ")}: not reported as an unknown command`,
      ).toMatch(/unknown|not found|invalid subcommand/i);
    }
  });

  step(
    "stop and start (the project stays on Spark): todos survive, db diff still clean",
    async () => {
      const rowsBefore = await restCount("todos?select=id");
      await run(["stop"]);
      await run(["start"]);
      expect(await restCount("todos?select=id"), "todos rows changed across restart").toBe(
        rowsBefore,
      );
      await expectNoSchemaChanges(["db", "diff", "-f", "after_restart"]);
      await noPostgres();
    },
  );

  step("db reset: data removed, all migrations replayed, the app works", async () => {
    const reset = await run(["db", "reset"]);
    expect(reset.log).toContain("Finished supabase db reset");
    expect(await restCount("todos?select=id"), "db reset kept todos rows").toBe(0);
    expect(await restStatus("projects?select=id"), "projects missing after reset").toBe(200);
    await check("app.test.mjs");
  });

  step(
    "db reset drops the table made in Studio, which no migration records; db diff -f writes it from the pulled schema files and db push applies it",
    async () => {
      expect(await restStatus("comments?select=id"), "db reset kept the Studio table").not.toBe(
        200,
      );
      const diff = await run(["db", "diff", "-f", "studio_comments"]);
      expect(diff.log).toContain("Dry run on Spark: OK");
      expect(
        await migrationFiles("_studio_comments.sql"),
        "no studio_comments migration file",
      ).toHaveLength(1);
      expect((await run(["db", "push"])).log).toContain("Finished supabase db push");
      expect(await restStatus("comments?select=id"), "db push did not restore comments").toBe(200);
    },
  );

  step(
    "linked project: link, db query --read-only (a write asks for --yes), migration list, gen types, db diff, a confirmed db push and migration fetch through the Management API; unreachable, only the local target answers",
    async () => {
      // The linked project's path: the Management API, served by the test's stand-in.
      const profilePath = join(workDir, "spark-profile.yaml");
      await writeText(
        profilePath,
        `name: spark-local\napi_url: ${managementApi}\ndashboard_url: ${STUDIO}\nproject_host: localhost\n`,
      );
      cliEnv = { ...cliEnv, SUPABASE_PROFILE: profilePath, SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN };

      const link = await run(["link", "--project-ref", PROJECT_REF]);
      expect(link.log).toContain("Finished supabase link");
      const linked = Schema.decodeSync(LinkFile)(
        await readText(join(projectDir, "supabase", ".link.json")),
      );
      expect(linked.project.ref).toBe(PROJECT_REF);

      const count = await run([
        "db",
        "query",
        "--remote",
        "--read-only",
        "-o",
        "json",
        "select count(*) as n from public.projects",
      ]);
      expect(String(parseRows(count.stdout)[0]?.["n"])).toBe("0");
      const unconfirmed = await runFails([
        "db",
        "query",
        "--remote",
        "delete from public.projects",
      ]);
      expect(unconfirmed.log, "db query --remote asked for no confirmation").toContain("--yes");

      const migrations = await run(["migration", "list", "--remote"]);
      const addProjectsVersion =
        (await migrationFiles("_add_projects.sql"))[0]?.split("_")[0] ?? "";
      expect(addProjectsVersion).not.toBe("");
      expect(migrations.log, "migration list --remote shows add_projects on one side only").toMatch(
        new RegExp(`${addProjectsVersion}.*${addProjectsVersion}`),
      );

      const types = await run(["gen", "types", "typescript", "--remote"]);
      expect(types.log).toContain('"projects": {');
      await expectNoSchemaChanges(["db", "diff", "--remote"]);
      expect((await run(["db", "push", "--remote"])).log).toContain(
        "Remote database is up to date",
      );

      // A pending migration through the linked path: its dry run and its apply are the Management API's.
      await writeText(
        migrationsPath("20990101000002_remote_probe.sql"),
        "create table public.remote_probe (id bigint primary key);\n",
      );
      const unconfirmedPush = await runFails(["db", "push", "--remote"]);
      expect(unconfirmedPush.log, "db push --remote asked for no confirmation").toContain("--yes");
      const confirmedPush = await run(["db", "push", "--remote", "--yes"]);
      expect(confirmedPush.log).toContain("Finished supabase db push");
      expect(
        await restStatus("remote_probe?select=id"),
        "db push --remote applied no remote_probe table",
      ).toBe(200);

      await removePath(migrationsPath("20990101000002_remote_probe.sql"));
      await run(["migration", "fetch", "--remote", "--yes"]);
      expect(
        await readText(migrationsPath("20990101000002_remote_probe.sql")),
        "migration fetch --remote did not write the pushed migration back",
      ).toBe("create table public.remote_probe (id bigint primary key);\n");

      // With the profile pointing nowhere the linked path fails and the local one still answers: they do not share a route.
      const deadProfilePath = join(workDir, "dead-profile.yaml");
      await writeText(
        deadProfilePath,
        (await readText(profilePath)).replace(/^api_url: .*$/m, "api_url: http://127.0.0.1:9"),
      );
      cliEnv = { ...cliEnv, SUPABASE_PROFILE: deadProfilePath };
      await runFails(["migration", "list", "--remote"]);
      expect(
        (await run(["migration", "list"])).log,
        "migration list on the local target does not show the pushed migration",
      ).toContain("20990101000002");
      cliEnv = { ...cliEnv, SUPABASE_PROFILE: profilePath };
    },
  );

  step("supabase stop: nothing left running", async () => {
    await run(["stop"]);
    expect(
      (await ownedProcesses())
        .filter((row) => row.command.startsWith(sparkBin))
        .map((row) => `${row.pid} ${row.command}`),
      "spark still running after stop",
    ).toEqual([]);
    expect(await ownedContainers(), "stack containers left after stop").toEqual([]);
    await expect(fetch(`${API}/rest/v1/`), "the API still answers after stop").rejects.toThrow();
  });
});
