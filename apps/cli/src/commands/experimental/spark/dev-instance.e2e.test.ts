// One sequential scenario for the Spark dev-instance mode, driven through the compiled CLI: the
// test serves the Management API stand-in with its own Spark processes (one per project, in temp
// directories on free ports), and the CLI creates, uses, resets and deletes its dev instance
// through it. No local stack runs. Needs SUPABASE_SPARK_BIN; without it the suite is skipped.
import { createHmac } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import {
  Config,
  Effect,
  Exit,
  FileSystem,
  Layer,
  ManagedRuntime,
  Path,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";
import { HttpClient } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { afterAll, describe, expect, test } from "vitest";
import {
  createTempHome,
  pickFreePort,
  requireCliSuccess,
  runSupabase,
  stripAnsi,
  type TempHome,
} from "../../../../tests/helpers/cli.ts";
import {
  type SparkConnection,
  SparkInstanceError,
  type SparkInstances,
  serveSparkManagementApi,
} from "../../../../tests/helpers/spark-management-api.ts";

const STEP_TIMEOUT_MS = 180_000;
const CLI_EXIT_TIMEOUT_MS = 120_000;
const SPARK_READY_TIMEOUT = "30 seconds";
const ACCESS_TOKEN = `sbp_${"0a".repeat(20)}`;
const ORGANIZATIONS = [
  { id: "org-a-id", slug: "org-a", name: "Org A" },
  { id: "org-b-id", slug: "org-b", name: "Org B" },
];
const SEEDED_TITLE = "seeded todo";

const envValue = (name: string) => Effect.runSync(Config.String(name).pipe(Config.withDefault("")));
const sparkBin = envValue("SUPABASE_SPARK_BIN");
const exampleDir = envValue("SPARK_EXAMPLE_DIR");

const hostLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);
const hostRuntime = ManagedRuntime.make(hostLayer);
afterAll(() => hostRuntime.dispose());
const { join } = hostRuntime.runSync(Path.Path);
const fsOp = <A>(operation: (fs: FileSystem.FileSystem) => Effect.Effect<A, unknown>) =>
  hostRuntime.runPromise(Effect.flatMap(FileSystem.FileSystem, operation));
const readText = (path: string) => fsOp((fs) => fs.readFileString(path));
const writeText = (path: string, text: string) => fsOp((fs) => fs.writeFileString(path, text));
const exists = (path: string) => fsOp((fs) => fs.exists(path));

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** An HS256 JWT with the given role, as Spark's keys are. */
const signKey = (secret: string, role: string) => {
  const unsigned = `${base64url({ alg: "HS256", typ: "JWT" })}.${base64url({ iss: "supabase-demo", role, exp: 1983812996 })}`;
  return `${unsigned}.${createHmac("sha256", secret).update(unsigned).digest("base64url")}`;
};

interface RunningInstance {
  readonly dir: string;
  readonly port: number;
  readonly connection: SparkConnection;
  scope: Scope.Closeable;
}

const DevInstanceStatus = Schema.fromJsonString(
  Schema.Struct({
    ref: Schema.String,
    name: Schema.String,
    status: Schema.String,
    api_url: Schema.String,
    rest_url: Schema.String,
    anon_key: Schema.String,
    service_role_key: Schema.String,
  }),
);
const Projects = Schema.fromJsonString(Schema.Array(Schema.Struct({ ref: Schema.String })));
const StateFile = Schema.fromJsonString(
  Schema.Struct({ ref: Schema.String, management_api_url: Schema.String }),
);

describe.skipIf(sparkBin === "")("experimental spark dev instance (e2e)", () => {
  let workDir = "";
  let ownedPaths: ReadonlyArray<string> = [];
  let home: TempHome | undefined;
  let managementApiScope: Scope.Closeable | undefined;
  let managementApi = "";
  let profilePath = "";
  let failedStep: string | undefined;
  const running = new Map<string, RunningInstance>();
  let firstRef = "";
  let secondRef = "";

  const instanceError = (what: string) => (cause: unknown) =>
    new SparkInstanceError({ message: `${what}: ${String(cause)}` });

  /** Starts Spark on `port` and resolves once it answers its health route. */
  const launch = (dir: string, port: number, apiKey: string) =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const output: Array<string> = [];
      yield* Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const child = yield* spawner.spawn(
          ChildProcess.make(sparkBin, ["--workdir", dir, "start"], {
            extendEnv: true,
            env: { SPARK_API_PORT: String(port) },
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "5 seconds",
          }),
        );
        yield* Effect.forkScoped(
          Stream.runForEach(
            Stream.merge(Stream.decodeText(child.stdout), Stream.decodeText(child.stderr)),
            (chunk) => Effect.sync(() => output.push(chunk)),
          ),
        );
      }).pipe(Scope.provide(scope));
      const client = yield* HttpClient.HttpClient;
      yield* client
        .get(`http://127.0.0.1:${port}/auth/v1/health`, { headers: { apikey: apiKey } })
        .pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.void
              : Effect.fail(new SparkInstanceError({ message: `HTTP ${response.status}` })),
          ),
          Effect.retry(Schedule.spaced("200 millis")),
          Effect.timeoutOrElse({
            duration: SPARK_READY_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new SparkInstanceError({
                  message: `spark did not become ready:\n${output.join("")}`,
                }),
              ),
          }),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      return scope;
    });

  const instances: SparkInstances = {
    create: (ref) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dir = join(workDir, "instances", ref);
        const port = yield* pickFreePort;
        const secret = `secret-${ref}-0123456789abcdef`;
        const connection = {
          url: `http://127.0.0.1:${port}`,
          anonKey: signKey(secret, "anon"),
          serviceRoleKey: signKey(secret, "service_role"),
        };
        yield* fs.makeDirectory(join(dir, "supabase"), { recursive: true });
        yield* fs.writeFileString(
          join(dir, "supabase", "config.toml"),
          `project_id = "${ref}"\n\n[api]\nport = ${port}\n\n[auth]\njwt_secret = "${secret}"\nanon_key = "${connection.anonKey}"\nservice_role_key = "${connection.serviceRoleKey}"\n`,
        );
        const scope = yield* launch(dir, port, connection.anonKey);
        running.set(ref, { dir, port, connection, scope });
        return connection;
      }).pipe(Effect.mapError(instanceError(`create ${ref}`)), Effect.provide(hostLayer)),
    delete: (ref) =>
      Effect.gen(function* () {
        const instance = running.get(ref);
        if (instance === undefined) return;
        yield* Scope.close(instance.scope, Exit.void);
        running.delete(ref);
      }),
    reset: (ref) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const instance = running.get(ref);
        if (instance === undefined)
          return yield* new SparkInstanceError({ message: "no such instance" });
        yield* Scope.close(instance.scope, Exit.void);
        const temp = join(instance.dir, "supabase", ".temp");
        for (const file of yield* fs.readDirectory(temp))
          if (file.startsWith("spark.db")) yield* fs.remove(join(temp, file));
        instance.scope = yield* launch(instance.dir, instance.port, instance.connection.anonKey);
        return instance.connection;
      }).pipe(Effect.mapError(instanceError(`reset ${ref}`)), Effect.provide(hostLayer)),
  };

  const sb = async (args: ReadonlyArray<string>, cwd: string) => {
    if (home === undefined) throw new Error("no CLI home");
    const result = await runSupabase([...args], {
      cwd,
      home: home.dir,
      exitTimeoutMs: CLI_EXIT_TIMEOUT_MS,
      env: {
        SUPABASE_PROFILE: profilePath,
        SUPABASE_ACCESS_TOKEN: ACCESS_TOKEN,
        SUPABASE_PROJECT_ID: undefined,
        SUPABASE_YES: undefined,
        NODE_PATH: undefined,
        DO_NOT_TRACK: "1",
      },
    });
    const stdout = stripAnsi(result.stdout);
    return { ...result, stdout, log: `${stdout}${stripAnsi(result.stderr)}` };
  };
  const run = async (args: ReadonlyArray<string>, cwd: string) => {
    const result = await sb(args, cwd);
    requireCliSuccess(result, `supabase ${args.join(" ")}`);
    return result;
  };
  const runFails = async (args: ReadonlyArray<string>, cwd: string) => {
    const result = await sb(args, cwd);
    expect(result.exitCode, `supabase ${args.join(" ")} succeeded:\n${result.log}`).not.toBe(0);
    return result;
  };
  const projectRefs = async (cwd: string) =>
    Schema.decodeSync(Projects)((await run(["projects", "list", "-o", "json"], cwd)).stdout).map(
      (project) => project.ref,
    );
  const status = async (cwd: string) =>
    Schema.decodeSync(DevInstanceStatus)((await run(["status", "-o", "json"], cwd)).stdout);
  const stateFile = (cwd: string) => join(cwd, "supabase", ".temp", "dev-instance.json");

  const makeProject = async (name: string) => {
    const dir = join(workDir, name);
    await fsOp((fs) => fs.makeDirectory(join(dir, "supabase", "migrations"), { recursive: true }));
    await run(["init"], dir);
    const configPath = join(dir, "supabase", "config.toml");
    await writeText(
      configPath,
      `${await readText(configPath)}\n[experimental.spark]\nenabled = true\ndev_instance = true\n`,
    );
    await writeText(
      join(dir, "supabase", "migrations", "20260101000000_todos.sql"),
      await readText(join(exampleDir, "todos.sql")),
    );
    await writeText(
      join(dir, "supabase", "seed.sql"),
      `insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'seed@example.com');\ninsert into public.todos (user_id, title) values ('00000000-0000-0000-0000-000000000001', '${SEEDED_TITLE}');\n`,
    );
    return dir;
  };

  const sparkProcesses = async () => {
    const listed = await hostRuntime.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
          const child = yield* spawner.spawn(
            ChildProcess.make("ps", ["-ww", "-Ao", "pid=,command="], {
              stdin: "ignore",
              stdout: "pipe",
              stderr: "ignore",
            }),
          );
          return yield* Stream.mkString(Stream.decodeText(child.stdout));
        }),
      ),
    );
    return listed
      .split("\n")
      .filter((line) => line.includes(sparkBin) && ownedPaths.some((path) => line.includes(path)));
  };

  const step = (name: string, body: () => Promise<void>) =>
    test(name, { timeout: STEP_TIMEOUT_MS }, async () => {
      if (failedStep !== undefined) throw new Error(`skipped: step "${failedStep}" failed`);
      failedStep = name;
      await body();
      failedStep = undefined;
    });

  let projectDir = "";
  let otherProjectDir = "";

  afterAll(async () => {
    for (const instance of running.values())
      await hostRuntime.runPromise(Scope.close(instance.scope, Exit.void));
    running.clear();
    if (managementApiScope !== undefined)
      await hostRuntime.runPromise(Scope.close(managementApiScope, Exit.void));
    const left = workDir === "" ? [] : await sparkProcesses();
    if (home !== undefined) await Effect.runPromise(home.dispose);
    if (left.length > 0) {
      for (const line of left) process.kill(Number(line.trim().split(/\s+/u)[0]), "SIGKILL");
      throw new Error(`Spark processes of this run were still running:\n${left.join("\n")}`);
    }
    if (workDir !== "") await fsOp((fs) => fs.remove(workDir, { recursive: true, force: true }));
  }, STEP_TIMEOUT_MS);

  step("setup: the Management API stand-in with its own Spark instances", async () => {
    expect(await exists(sparkBin), `no spark binary at ${sparkBin}`).toBe(true);
    expect(exampleDir, "set SPARK_EXAMPLE_DIR to the PoC example apps").not.toBe("");
    home = await Effect.runPromise(createTempHome);
    workDir = await fsOp((fs) =>
      fs.makeTempDirectory({ directory: "/tmp", prefix: "spark-dev-e2e-" }),
    );
    ownedPaths = [workDir, await fsOp((fs) => fs.realPath(workDir))];
    const scope = await hostRuntime.runPromise(Scope.make());
    managementApiScope = scope;
    managementApi = await hostRuntime.runPromise(
      serveSparkManagementApi({ instances, organizations: ORGANIZATIONS }).pipe(
        Scope.provide(scope),
      ),
    );
    profilePath = join(workDir, "profile.yaml");
    await writeText(
      profilePath,
      `name: spark-dev\napi_url: ${managementApi}\ndashboard_url: http://127.0.0.1:9\nproject_host: localhost\n`,
    );
    projectDir = await makeProject("my-app");
  });

  step("before start: a command that needs the dev instance names supabase start", async () => {
    expect((await runFails(["db", "query", "select 1"], projectDir)).log).toContain(
      "Run `supabase start`",
    );
    const missing = await runFails(["status"], projectDir);
    expect(missing.exitCode).toBe(1);
    expect(missing.log).toContain("No dev instance for this project");
  });

  step(
    "start: refuses to pick between organizations, then creates the instance, applies the migration and the seed",
    async () => {
      const ambiguous = await runFails(["start"], projectDir);
      expect(ambiguous.log).toContain("org-a, org-b");
      expect(ambiguous.log).toContain("--org");

      const started = await run(["start", "--org", "org-a"], projectDir);
      expect(started.log).toMatch(
        /Creating dev instance dev-my-app-[0-9a-f]{6} in organization org-a/,
      );
      expect(started.log).toContain("Applying migration 20260101000000_todos.sql");
      expect(started.log).toContain("Seeding data from supabase/seed.sql");
      expect(started.log).toContain("ACTIVE_HEALTHY");
      const mode = await fsOp((fs) => fs.stat(stateFile(projectDir)));
      expect(mode.mode & 0o777, "the state file's mode").toBe(0o600);
      const state = Schema.decodeSync(StateFile)(await readText(stateFile(projectDir)));
      expect(state.management_api_url).toBe(managementApi);
      firstRef = state.ref;
      expect(await exists(join(home?.dir ?? "", "stacks")), "a local stack was created").toBe(
        false,
      );
    },
  );

  step("status -o json: the URL and keys serve the instance's REST API", async () => {
    const report = await status(projectDir);
    expect(report.ref).toBe(firstRef);
    expect(report.status).toBe("ACTIVE_HEALTHY");
    expect(report.rest_url).toBe(`${report.api_url}/rest/v1`);
    const asService = await fetch(`${report.rest_url}/todos?select=title`, {
      headers: {
        apikey: report.service_role_key,
        authorization: `Bearer ${report.service_role_key}`,
      },
    });
    expect(await asService.text()).toContain(SEEDED_TITLE);
    const asAnon = await fetch(`${report.rest_url}/todos?select=title`, {
      headers: { apikey: report.anon_key },
    });
    expect(asAnon.status, "the anon key is refused").toBe(200);
    expect(await asAnon.text(), "RLS hides the seeded row from anon").toBe("[]");
  });

  step("db query reads the seeded row; a second start reuses the instance", async () => {
    expect(
      (await run(["db", "query", "select title from public.todos", "-o", "json"], projectDir))
        .stdout,
    ).toContain(SEEDED_TITLE);
    const again = await run(["start"], projectDir);
    expect(again.log).toContain(`Using dev instance`);
    expect(again.log).not.toContain("Seeding data");
    expect(await projectRefs(projectDir)).toEqual([firstRef]);
  });

  step("a new migration: db push, migration list, gen types typescript", async () => {
    await writeText(
      join(projectDir, "supabase", "migrations", "20260102000000_labels.sql"),
      "create table public.labels (id bigint primary key, name text not null);\ngrant all on public.labels to anon, authenticated, service_role;\n",
    );
    expect((await run(["db", "push"], projectDir)).log).toContain("Finished supabase db push");
    const listed = (await run(["migration", "list"], projectDir)).log;
    expect(listed).toContain("20260101000000");
    expect(listed).toContain("20260102000000");
    expect((await run(["gen", "types", "typescript"], projectDir)).stdout).toMatch(
      /"?labels"?: \{/,
    );
  });

  step("db reset: drops what db query made, replays migrations and seed", async () => {
    await run(["db", "query", "create table public.scratch (id int)"], projectDir);
    await run(["db", "query", "select count(*) from public.scratch"], projectDir);
    const reset = await run(["db", "reset"], projectDir);
    expect(reset.log).toContain("Seeding data from supabase/seed.sql");
    expect(reset.log).toContain("Finished supabase db reset");
    await runFails(["db", "query", "select count(*) from public.scratch"], projectDir);
    await run(["db", "query", "select count(*) from public.labels"], projectDir);
    expect(
      (await run(["db", "query", "select title from public.todos", "-o", "json"], projectDir))
        .stdout,
    ).toContain(SEEDED_TITLE);
  });

  step("a second project directory gets its own instance; projects list shows both", async () => {
    otherProjectDir = await makeProject("other-app");
    await run(["start", "--org", "org-b"], otherProjectDir);
    secondRef = (await status(otherProjectDir)).ref;
    expect(secondRef).not.toBe(firstRef);
    expect((await projectRefs(projectDir)).toSorted()).toEqual([firstRef, secondRef].toSorted());
  });

  step("stop keeps the instance; stop --delete removes it and the state file", async () => {
    expect((await run(["stop"], projectDir)).log).toContain("supabase stop --delete");
    expect(await projectRefs(projectDir)).toContain(firstRef);
    expect((await run(["stop", "--delete"], projectDir)).log).toContain("Deleted the dev instance");
    expect(await exists(stateFile(projectDir))).toBe(false);
    expect(await projectRefs(projectDir)).toEqual([secondRef]);
    expect((await runFails(["db", "query", "select 1"], projectDir)).log).toContain(
      "Run `supabase start`",
    );
    await run(["stop", "--delete"], otherProjectDir);
    expect(running.size, "Spark instances left after both deletes").toBe(0);
    expect(await sparkProcesses(), "Spark processes left after both deletes").toEqual([]);
  });
});
