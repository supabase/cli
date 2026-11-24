// One sequential scenario for the Spark dev-instance mode, driven through the compiled CLI: the
// test serves the Management API stand-in with its own Spark processes (one per project, in temp
// directories on free ports), and the CLI creates, uses, resets and deletes its dev instance
// through it. No local stack runs. Needs SUPABASE_SPARK_BIN; without it the suite is skipped.
import { createHash, createHmac } from "node:crypto";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { holdLock } from "@supabase/stack/effect";
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
import { afterAll } from "vitest";
import {
  createTempHome,
  pickFreePort,
  runSupabaseEffect,
  stripAnsi,
  type TempHome,
} from "../../../../tests/helpers/cli.ts";
import {
  type ManagementApiFaults,
  type ManagementApiLog,
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
const REFUSED_MIGRATION =
  "create function public.add(a int, b int) returns int\n  language plpgsql as $$ begin return a + b; end $$;\n";

const envValue = (name: string) => Effect.runSync(Config.String(name).pipe(Config.withDefault("")));
const sparkBin = envValue("SUPABASE_SPARK_BIN");
const exampleDir = envValue("SPARK_EXAMPLE_DIR");

const hostLayer = Layer.mergeAll(BunServices.layer, FetchHttpClient.layer);
const hostRuntime = ManagedRuntime.make(hostLayer);
afterAll(() => hostRuntime.dispose());
const { join } = hostRuntime.runSync(Path.Path);

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
  Schema.Struct({
    ref: Schema.String,
    management_api_url: Schema.String,
    api_url: Schema.optionalKey(Schema.String),
    service_role_key: Schema.optionalKey(Schema.String),
    seeded: Schema.optionalKey(Schema.Boolean),
  }),
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
  const faults: ManagementApiFaults = { apiKeysFailures: 0, nullApiUrl: false, resetFailures: 0 };
  const received: ManagementApiLog = { deploys: [], bulkUpdates: [] };
  let firstRef = "";
  let secondRef = "";
  let projectDir = "";
  let otherProjectDir = "";

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

  const sb = (args: ReadonlyArray<string>, cwd: string) =>
    Effect.gen(function* () {
      if (home === undefined) return yield* Effect.die("no CLI home");
      const result = yield* runSupabaseEffect([...args], {
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
    });
  const run = (args: ReadonlyArray<string>, cwd: string) =>
    Effect.tap(sb(args, cwd), (result) =>
      Effect.sync(() =>
        expect(result.exitCode, `supabase ${args.join(" ")} failed:\n${result.log}`).toBe(0),
      ),
    );
  const runFails = (args: ReadonlyArray<string>, cwd: string) =>
    Effect.tap(sb(args, cwd), (result) =>
      Effect.sync(() =>
        expect(result.exitCode, `supabase ${args.join(" ")} succeeded:\n${result.log}`).not.toBe(0),
      ),
    );
  const projectRefs = (cwd: string) =>
    Effect.map(run(["projects", "list", "-o", "json"], cwd), (result) =>
      Schema.decodeSync(Projects)(result.stdout).map((project) => project.ref),
    );
  const status = (cwd: string) =>
    Effect.map(run(["status", "-o", "json"], cwd), (result) =>
      Schema.decodeSync(DevInstanceStatus)(result.stdout),
    );
  const stateFile = (cwd: string) => join(cwd, "supabase", ".temp", "dev-instance.json");
  const readState = (cwd: string) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(stateFile(cwd))).pipe(
      Effect.map(Schema.decodeSync(StateFile)),
    );
  const writeText = (path: string, text: string) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(path, text));
  const readText = (path: string) =>
    Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(path));
  const exists = (path: string) => Effect.flatMap(FileSystem.FileSystem, (fs) => fs.exists(path));

  /** A `supabase init` project in dev-instance mode, with the example migration and a seed file unless `bare`. */
  const makeProject = (name: string, options: { readonly bare?: boolean } = {}) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = join(workDir, name);
      yield* fs.makeDirectory(join(dir, "supabase", "migrations"), { recursive: true });
      yield* run(["init"], dir);
      const configPath = join(dir, "supabase", "config.toml");
      yield* writeText(
        configPath,
        `${yield* readText(configPath)}\n[experimental.spark]\nenabled = true\ndev_instance = true\n`,
      );
      if (options.bare === true) return dir;
      yield* writeText(
        join(dir, "supabase", "migrations", "20260101000000_todos.sql"),
        yield* readText(join(exampleDir, "todos.sql")),
      );
      yield* writeText(
        join(dir, "supabase", "seed.sql"),
        `insert into auth.users (id, email) values ('00000000-0000-0000-0000-000000000001', 'seed@example.com');\ninsert into public.todos (user_id, title) values ('00000000-0000-0000-0000-000000000001', '${SEEDED_TITLE}');\n`,
      );
      return dir;
    });

  const sparkProcesses = Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make("ps", ["-ww", "-Ao", "pid=,command="], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
      }),
    );
    const listed = yield* Stream.mkString(Stream.decodeText(child.stdout));
    return listed
      .split("\n")
      .filter((line) => line.includes(sparkBin) && ownedPaths.some((path) => line.includes(path)));
  }).pipe(Effect.scoped);

  const step = <E>(
    name: string,
    body: Effect.Effect<
      void,
      E,
      | FileSystem.FileSystem
      | Path.Path
      | HttpClient.HttpClient
      | ChildProcessSpawner.ChildProcessSpawner
    >,
  ) =>
    it.live(
      name,
      () =>
        Effect.gen(function* () {
          if (failedStep !== undefined)
            return yield* Effect.die(`skipped: step "${failedStep}" failed`);
          failedStep = name;
          yield* body;
          failedStep = undefined;
        }).pipe(Effect.provide(hostLayer)),
      STEP_TIMEOUT_MS,
    );

  const cleanup = Effect.gen(function* () {
    for (const instance of running.values()) yield* Scope.close(instance.scope, Exit.void);
    running.clear();
    if (managementApiScope !== undefined) yield* Scope.close(managementApiScope, Exit.void);
    const left = workDir === "" ? [] : yield* sparkProcesses;
    if (home !== undefined) yield* home.dispose;
    for (const line of left)
      yield* Effect.sync(() => process.kill(Number(line.trim().split(/\s+/u)[0]), "SIGKILL"));
    if (workDir !== "") {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(workDir, { recursive: true, force: true });
    }
    if (left.length > 0)
      return yield* Effect.die(
        `Spark processes of this run were still running:\n${left.join("\n")}`,
      );
  });
  afterAll(() => hostRuntime.runPromise(cleanup), STEP_TIMEOUT_MS);

  step(
    "setup: the Management API stand-in with its own Spark instances",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      expect(yield* exists(sparkBin), `no spark binary at ${sparkBin}`).toBe(true);
      expect(exampleDir, "set SPARK_EXAMPLE_DIR to the PoC example apps").not.toBe("");
      home = yield* createTempHome;
      workDir = yield* fs.makeTempDirectory({ directory: "/tmp", prefix: "spark-dev-e2e-" });
      ownedPaths = [workDir, yield* fs.realPath(workDir)];
      const scope = yield* Scope.make();
      managementApiScope = scope;
      managementApi = yield* serveSparkManagementApi({
        instances,
        organizations: ORGANIZATIONS,
        faults,
        log: received,
      }).pipe(Scope.provide(scope));
      profilePath = join(workDir, "profile.yaml");
      yield* writeText(
        profilePath,
        `name: spark-dev\napi_url: ${managementApi}\ndashboard_url: http://127.0.0.1:9\nproject_host: localhost\n`,
      );
      projectDir = yield* makeProject("my-app");
    }),
  );

  step(
    "before start: a command that needs the dev instance names supabase start",
    Effect.gen(function* () {
      expect((yield* runFails(["db", "query", "select 1"], projectDir)).log).toContain(
        "Run `supabase start`",
      );
      const missing = yield* runFails(["status"], projectDir);
      expect(missing.exitCode).toBe(1);
      expect(missing.log).toContain("No dev instance for this project");
    }),
  );

  step(
    "start fails at once, creating nothing, while another command holds the dev-instance lock",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = join(projectDir, "supabase", ".temp");
      yield* fs.makeDirectory(temp, { recursive: true });
      const locked = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* holdLock(join(temp, "dev-instance.lock"), "5 seconds", "the e2e test");
          return yield* runFails(["start", "--org", "org-a"], projectDir);
        }),
      );
      expect(locked.log).toContain("supabase/.temp/dev-instance.lock");
      expect(yield* projectRefs(projectDir)).toEqual([]);
      expect(yield* exists(stateFile(projectDir))).toBe(false);
    }),
  );

  step(
    "start: refuses to pick between organizations; a start that fails after the create is resumed by the next one",
    Effect.gen(function* () {
      const ambiguous = yield* runFails(["start"], projectDir);
      expect(ambiguous.log).toContain("org-a, org-b");
      expect(ambiguous.log).toContain("--org");

      const gitignore = join(projectDir, "supabase", ".gitignore");
      yield* writeText(gitignore, "# the user's own rules, without .temp\n.env\n");

      faults.apiKeysFailures = 1;
      const failed = yield* runFails(["start", "--org", "org-a"], projectDir);
      expect(failed.log).toMatch(
        /Creating dev instance dev-my-app-[0-9a-f]{6} in organization org-a/,
      );
      const partial = yield* readState(projectDir);
      expect(partial.service_role_key, "keys recorded before they were read").toBeUndefined();
      firstRef = partial.ref;
      expect(yield* projectRefs(projectDir)).toEqual([firstRef]);
      expect((yield* readText(gitignore)).split("\n")).toContain(".temp");
      expect((yield* runFails(["status"], projectDir)).log).toContain("not set up yet");

      const started = yield* run(["start"], projectDir);
      expect(started.log).toContain(`Finishing the setup of dev instance`);
      expect(started.log).not.toContain("Creating dev instance");
      expect(started.log).toContain("Applying migration 20260101000000_todos.sql");
      expect(started.log).toContain("Seeding data from supabase/seed.sql");
      expect(started.log).toContain("ACTIVE_HEALTHY");
      expect(yield* projectRefs(projectDir)).toEqual([firstRef]);
      const mode = yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.stat(stateFile(projectDir)),
      );
      expect(mode.mode & 0o777, "the state file's mode").toBe(0o600);
      const state = yield* readState(projectDir);
      expect(state.ref).toBe(firstRef);
      expect(state.management_api_url).toBe(managementApi);
      expect(state.seeded).toBe(true);
      expect(yield* exists(join(home?.dir ?? "", "stacks")), "a local stack was created").toBe(
        false,
      );
    }),
  );

  step(
    "status -o json: the URL and keys serve the instance's REST API",
    Effect.gen(function* () {
      const report = yield* status(projectDir);
      expect(report.ref).toBe(firstRef);
      expect(report.status).toBe("ACTIVE_HEALTHY");
      expect(report.rest_url).toBe(`${report.api_url}/rest/v1`);
      const client = yield* HttpClient.HttpClient;
      const asService = yield* client.get(`${report.rest_url}/todos?select=title`, {
        headers: {
          apikey: report.service_role_key,
          authorization: `Bearer ${report.service_role_key}`,
        },
      });
      expect(yield* asService.text).toContain(SEEDED_TITLE);
      const asAnon = yield* client.get(`${report.rest_url}/todos?select=title`, {
        headers: { apikey: report.anon_key },
      });
      expect(asAnon.status, "the anon key is refused").toBe(200);
      expect(yield* asAnon.text, "RLS hides the seeded row from anon").toBe("[]");
    }),
  );

  step(
    "db query reads the seeded row; a second start reuses the instance; --local is refused",
    Effect.gen(function* () {
      expect(
        (yield* run(["db", "query", "select title from public.todos", "-o", "json"], projectDir))
          .stdout,
      ).toContain(SEEDED_TITLE);
      const again = yield* run(["start"], projectDir);
      expect(again.log).toContain(`Using dev instance`);
      expect(again.log).not.toContain("Seeding data");
      expect(yield* projectRefs(projectDir)).toEqual([firstRef]);
      const local = yield* runFails(["db", "query", "--local", "select 1"], projectDir);
      expect(local.log).toContain("has no local stack");
      expect(local.log).not.toContain("isn't needed");
    }),
  );

  step(
    "a new migration: db push, migration list, gen types typescript",
    Effect.gen(function* () {
      yield* writeText(
        join(projectDir, "supabase", "migrations", "20260102000000_labels.sql"),
        "create table public.labels (id bigint primary key, name text not null);\ngrant all on public.labels to anon, authenticated, service_role;\n",
      );
      expect((yield* run(["db", "push"], projectDir)).log).toContain("Finished supabase db push");
      const listed = (yield* run(["migration", "list"], projectDir)).log;
      expect(listed).toContain("20260101000000");
      expect(listed).toContain("20260102000000");
      expect((yield* run(["gen", "types", "typescript"], projectDir)).stdout).toMatch(
        /"?labels"?: \{/,
      );
    }),
  );

  step(
    "db reset: drops what db query made, replays migrations and seed",
    Effect.gen(function* () {
      yield* run(["db", "query", "create table public.scratch (id int)"], projectDir);
      yield* run(["db", "query", "select count(*) from public.scratch"], projectDir);
      const reset = yield* run(["db", "reset"], projectDir);
      expect(reset.log).toContain("Seeding data from supabase/seed.sql");
      expect(reset.log).toContain("Finished supabase db reset");
      yield* runFails(["db", "query", "select count(*) from public.scratch"], projectDir);
      yield* run(["db", "query", "select count(*) from public.labels"], projectDir);
      expect(
        (yield* run(["db", "query", "select title from public.todos", "-o", "json"], projectDir))
          .stdout,
      ).toContain(SEEDED_TITLE);
      expect((yield* readState(projectDir)).seeded).toBe(true);
    }),
  );

  step(
    "a rejected db reset leaves the data and the seeded marker as they were",
    Effect.gen(function* () {
      faults.resetFailures = 1;
      const rejected = yield* runFails(["db", "reset"], projectDir).pipe(
        Effect.ensuring(Effect.sync(() => (faults.resetFailures = 0))),
      );
      expect(rejected.log).toContain("rejected");
      expect(rejected.log).not.toContain("Seeding data");
      expect((yield* readState(projectDir)).seeded).toBe(true);
      expect(
        (yield* run(["db", "query", "select title from public.todos", "-o", "json"], projectDir))
          .stdout,
      ).toContain(SEEDED_TITLE);
      expect((yield* run(["start"], projectDir)).log).not.toContain("Seeding data");
    }),
  );

  step(
    "functions new, deploy through the API (one, then two in one bulk update), list and delete on the dev instance",
    Effect.gen(function* () {
      const report = yield* status(projectDir);
      yield* run(["functions", "new", "hello"], projectDir);
      expect(yield* exists(join(projectDir, "supabase", "functions", "hello", "index.ts"))).toBe(
        true,
      );
      const deployed = yield* run(["functions", "deploy", "hello", "--yes"], projectDir);
      expect(deployed.log).not.toContain("Docker");
      expect(deployed.stdout).toContain(`${report.api_url}/functions/v1/hello`);
      const upload = received.deploys.find((deploy) => deploy.slug === "hello");
      expect(upload?.ref).toBe(firstRef);
      expect(upload?.metadata.entrypoint_path).toContain("hello/index.ts");
      expect(upload?.files.some((file) => file.endsWith("hello/index.ts"))).toBe(true);
      expect(received.bulkUpdates).toEqual([]);

      yield* run(["functions", "new", "bye"], projectDir);
      yield* run(["functions", "new", "off"], projectDir);
      const configPath = join(projectDir, "supabase", "config.toml");
      const declared = yield* readText(configPath);
      const disabled = declared.replace(
        "[functions.off]\nenabled = true",
        "[functions.off]\nenabled = false",
      );
      expect(disabled, "functions new declares the function enabled").not.toBe(declared);
      yield* writeText(configPath, disabled);
      const all = yield* run(["functions", "deploy", "--yes"], projectDir);
      expect(all.log).toContain("Skipping disabled Function: off");
      expect(all.stdout).toContain(`${report.api_url}/functions/v1/hello`);
      expect(all.stdout).toContain(`${report.api_url}/functions/v1/bye`);
      expect(all.stdout, "a disabled function was not deployed").not.toContain("/functions/v1/off");
      const asJson = yield* run(
        ["functions", "deploy", "--yes", "--output-format", "json"],
        projectDir,
      );
      expect(asJson.stdout).toContain("function_urls");
      expect(asJson.stdout).not.toContain("/functions/v1/off");
      expect(received.bulkUpdates.map((update) => update.slugs.toSorted())).toEqual([
        ["bye", "hello"],
        ["bye", "hello"],
      ]);
      const listed = (yield* run(["functions", "list", "-o", "json"], projectDir)).stdout;
      expect(listed).toContain('"hello"');
      expect(listed).toContain('"bye"');

      const docker = yield* runFails(
        ["functions", "deploy", "hello", "--use-docker", "--yes"],
        projectDir,
      );
      expect(docker.log).toContain("--use-docker");

      yield* run(["functions", "delete", "bye", "--yes"], projectDir);
      const left = (yield* run(["functions", "list", "-o", "json"], projectDir)).stdout;
      expect(left).toContain('"hello"');
      expect(left).not.toContain('"bye"');
    }),
  );

  step(
    "secrets set, list (a digest, not the value) and unset on the dev instance",
    Effect.gen(function* () {
      const value = "a-secret-value";
      yield* run(["secrets", "set", `A=${value}`, "--yes"], projectDir);
      const listed = (yield* run(["secrets", "list"], projectDir)).stdout;
      expect(listed).toContain("A");
      expect(listed).toContain(createHash("sha256").update(value).digest("hex"));
      expect(listed).not.toContain(value);
      yield* run(["secrets", "unset", "A", "--yes"], projectDir);
      expect((yield* run(["secrets", "list"], projectDir)).stdout).not.toContain(
        createHash("sha256").update(value).digest("hex"),
      );
    }),
  );

  step(
    "a second project: a refused migration leaves it unseeded, and start seeds it once the migration is fixed",
    Effect.gen(function* () {
      otherProjectDir = yield* makeProject("other-app");
      const fixable = join(otherProjectDir, "supabase", "migrations", "20260101000001_add.sql");
      yield* writeText(fixable, REFUSED_MIGRATION);
      const refused = yield* runFails(["start", "--org", "org-b"], otherProjectDir);
      expect(refused.log).toContain("supabase/migrations/20260101000001_add.sql");
      expect(refused.log).not.toContain("Seeding data");
      expect((yield* readState(otherProjectDir)).seeded).toBe(false);

      yield* writeText(fixable, "create table public.numbers (n int);\n");
      const fixed = yield* run(["start"], otherProjectDir);
      expect(fixed.log).toContain("Using dev instance");
      expect(fixed.log).toContain("Seeding data from supabase/seed.sql");
      secondRef = (yield* status(otherProjectDir)).ref;
      expect(secondRef).not.toBe(firstRef);
      expect((yield* projectRefs(projectDir)).toSorted()).toEqual([firstRef, secondRef].toSorted());
    }),
  );

  step(
    "start -o json prints one JSON document when the seed file is missing, and falls back from a null api_url",
    Effect.gen(function* () {
      const bareDir = yield* makeProject("bare-app", { bare: true });
      faults.nullApiUrl = true;
      const started = yield* run(["start", "--org", "org-a", "-o", "json"], bareDir).pipe(
        Effect.ensuring(Effect.sync(() => (faults.nullApiUrl = false))),
      );
      const report = yield* Schema.decodeEffect(DevInstanceStatus)(started.stdout);
      expect(report.api_url).toBe(`https://${report.ref}.localhost`);
      expect(started.stderr).toContain("no files matched pattern");
      yield* run(["stop", "--delete"], bareDir);
    }),
  );

  step(
    "start creates no project when it cannot write its local state",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const blockedDir = yield* makeProject("blocked-app", { bare: true });
      const before = yield* projectRefs(projectDir);
      // A directory where supabase/.gitignore belongs: the local write fails on every retry.
      yield* fs.makeDirectory(join(blockedDir, "supabase", ".gitignore"), { recursive: true });
      const blocked = yield* runFails(["start", "--org", "org-a"], blockedDir);
      expect(blocked.log).not.toContain("Creating dev instance");
      expect(yield* projectRefs(projectDir)).toEqual(before);
      expect(yield* exists(stateFile(blockedDir))).toBe(false);
    }),
  );

  step(
    "stop keeps the instance; stop --delete removes it and the state file",
    Effect.gen(function* () {
      expect((yield* run(["stop"], projectDir)).log).toContain("supabase stop --delete");
      expect(yield* projectRefs(projectDir)).toContain(firstRef);
      const heldLock = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* holdLock(
            join(projectDir, "supabase", ".temp", "dev-instance.lock"),
            "5 seconds",
            "the e2e test",
          );
          return yield* runFails(["stop", "--delete"], projectDir);
        }),
      );
      expect(heldLock.log).toContain("supabase/.temp/dev-instance.lock");
      expect(yield* exists(stateFile(projectDir)), "the state file stays while locked").toBe(true);
      expect(yield* projectRefs(projectDir)).toContain(firstRef);
      expect((yield* run(["stop", "--delete"], projectDir)).log).toContain(
        "Deleted the dev instance",
      );
      expect(yield* exists(stateFile(projectDir))).toBe(false);
      expect(yield* projectRefs(projectDir)).toEqual([secondRef]);
      expect((yield* runFails(["db", "query", "select 1"], projectDir)).log).toContain(
        "Run `supabase start`",
      );
      yield* run(["stop", "--delete"], otherProjectDir);
      expect(running.size, "Spark instances left after the deletes").toBe(0);
      expect(yield* sparkProcesses, "Spark processes left after the deletes").toEqual([]);
    }),
  );
});
