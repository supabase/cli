import { Effect, FileSystem, Path } from "effect";

import { CommandSettings } from "../../config/command-settings.service.ts";
import { Output } from "../../shared/output/output.service.ts";
import {
  answers,
  gatewayScript,
  isAlive,
  isSparkProject,
  launchDaemon,
  readState,
  runCaptured,
  SparkBackendError,
  type SparkKeys,
  type SparkPaths,
  sparkHttp,
  sparkPaths,
  SparkSettings,
  type SparkState,
  SparkUnsupportedError,
  stopDaemon,
  waitUntil,
  writeState,
} from "./spark-backend.ts";

const fail = (message: string) => Effect.fail(new SparkBackendError({ message }));

const PROJECT_REF = "default";
const CRYPTO_KEY = "spark-local-crypto-key-0123456789abcdef";

const context = Effect.fnUntraced(function* () {
  const settings = yield* CommandSettings;
  const path = yield* Path.Path;
  const config = yield* SparkSettings;
  return { paths: sparkPaths(path, settings.workdir), config, path };
});

/**
 * Runs `spark` when the project uses the experimental Spark backend, `postgres` otherwise.
 * `forceSpark` opts a project in (`supabase start --experimental-spark`).
 */
export const withSparkBackend = <A, E, R, A2, E2, R2>(
  postgres: Effect.Effect<A, E, R>,
  spark: Effect.Effect<A2, E2, R2>,
  forceSpark = false,
) =>
  Effect.gen(function* () {
    const settings = yield* CommandSettings;
    const enabled = forceSpark || (yield* isSparkProject(settings.workdir));
    return enabled ? yield* spark : yield* postgres;
  });

/** Fails a command the Spark backend does not implement. */
export const sparkUnsupported = (command: string) =>
  Effect.fail(
    new SparkUnsupportedError({
      message: `\`supabase ${command}\` is not supported on the experimental Spark backend (no Postgres runs locally).`,
    }),
  );

const sparkUrl = (state: Pick<SparkState, "sparkPort">) => `http://127.0.0.1:${state.sparkPort}`;
const apiUrl = (state: Pick<SparkState, "apiPort">) => `http://127.0.0.1:${state.apiPort}`;

const parseKeys = (log: string): SparkKeys | undefined => {
  const get = (label: string) => new RegExp(`${label}: (\\S+)`).exec(log)?.[1];
  const anon = get("anon key");
  const service = get("service_role key");
  const jwt = get("JWT secret");
  return anon && service && jwt ? { anon, service, jwt } : undefined;
};

const startSpark = Effect.fn("spark.start.spark")(function* (
  paths: SparkPaths,
  config: SparkSettings,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(paths.log("spark"), { force: true });
  const pid = yield* launchDaemon("spark", config.sparkBin, ["start"], {
    cwd: paths.root,
    env: { SPARK_API_PORT: String(config.sparkPort) },
    logFile: paths.log("spark"),
  });
  let keys: SparkKeys | undefined;
  yield* waitUntil(
    "spark",
    Effect.gen(function* () {
      const log = yield* fs.readFileString(paths.log("spark")).pipe(Effect.orElseSucceed(() => ""));
      if (!(yield* isAlive(pid))) {
        return yield* fail(`spark exited at start:\n${log}`);
      }
      keys = parseKeys(log);
      return keys !== undefined;
    }).pipe(Effect.catchTag("SparkBackendError", (e) => Effect.die(e))),
  );
  if (keys === undefined) return yield* fail("spark printed no API keys");
  return { pid, keys };
});

const studioContainerName = (paths: SparkPaths, path: Path.Path) =>
  `supabase_studio_spark_${path.basename(paths.root).replace(/[^A-Za-z0-9_.-]/g, "_")}`;

const docker = (args: ReadonlyArray<string>) => runCaptured("spark.docker", "docker", args);

const startStudio = Effect.fn("spark.start.studio")(function* (
  paths: SparkPaths,
  path: Path.Path,
  config: SparkSettings,
  keys: SparkKeys,
) {
  const fs = yield* FileSystem.FileSystem;
  const name = studioContainerName(paths, path);
  const api = `http://127.0.0.1:${config.apiPort}`;
  yield* fs.makeDirectory(paths.snippets, { recursive: true });
  yield* docker(["rm", "-f", name]);
  const env = {
    HOSTNAME: "0.0.0.0",
    PORT: String(config.studioPort),
    STUDIO_PG_META_URL: `${api}/pg`,
    POSTGRES_PASSWORD: "unused",
    PG_META_CRYPTO_KEY: CRYPTO_KEY,
    DEFAULT_ORGANIZATION_NAME: "Spark",
    DEFAULT_PROJECT_NAME: "spark-local",
    SUPABASE_URL: api,
    SUPABASE_PUBLIC_URL: api,
    SUPABASE_ANON_KEY: keys.anon,
    SUPABASE_SERVICE_KEY: keys.service,
    AUTH_JWT_SECRET: keys.jwt,
    SNIPPETS_MANAGEMENT_FOLDER: "/app/snippets",
    ENABLED_FEATURES_LOGS_ALL: "false",
  };
  const run = yield* docker([
    "run",
    "-d",
    "--name",
    name,
    "--network",
    "host",
    "-v",
    `${paths.snippets}:/app/snippets`,
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    config.studioImage,
  ]);
  if (run.code !== 0) return yield* fail(`cannot start Studio:\n${run.stderr}`);
  return name;
});

const startGateway = Effect.fn("spark.start.gateway")(function* (
  paths: SparkPaths,
  config: SparkSettings,
  keys: SparkKeys,
) {
  const api = `http://127.0.0.1:${config.apiPort}`;
  const pid = yield* launchDaemon("gateway", config.bunBin, [gatewayScript], {
    cwd: paths.root,
    env: {
      GATEWAY_PORT: String(config.apiPort),
      SPARK_URL: `http://127.0.0.1:${config.sparkPort}`,
      SERVICE_ROLE_KEY: keys.service,
      ANON_KEY: keys.anon,
      PROJECT_REF,
      PUBLIC_URL: api,
      GAPS_FILE: paths.gaps,
      MIGRATIONS_DIR: paths.migrations,
    },
    logFile: paths.log("gateway"),
  });
  yield* waitUntil("the Spark gateway", answers(`${api}/_dev/status`));
  yield* syncGateway(api);
  return pid;
});

const syncGateway = Effect.fn("spark.gateway.sync")(function* (api: string) {
  const r = yield* sparkHttp("POST", `${api}/_dev/sync`);
  if (r.status !== 200) return yield* fail(`the gateway cannot read Spark's schema: ${r.text}`);
});

const portInUse = (port: number) => answers(`http://127.0.0.1:${port}/`);

/** `supabase start` on the Spark backend: Spark, the meta gateway and Studio; no Postgres. */
export const sparkStart = Effect.fn("spark.start")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const { paths, config, path } = yield* context();
  if (!(yield* fs.exists(path.join(paths.root, "supabase", "config.toml")))) {
    return yield* fail("no supabase/config.toml: run `supabase init` first");
  }
  yield* fs.makeDirectory(paths.dir, { recursive: true });
  yield* fs.writeFileString(paths.marker, "spark\n");
  const existing = yield* readState(paths);
  if (existing !== undefined && (yield* isAlive(existing.sparkPid))) {
    yield* output.raw("supabase start is already running.\n", "stderr");
    return yield* printStatus(existing);
  }
  for (const port of [config.apiPort, config.sparkPort]) {
    if (yield* portInUse(port)) {
      return yield* fail(`port ${port} is in use: is another local stack running?`);
    }
  }
  const spark = yield* startSpark(paths, config);
  const studio = config.noStudio ? null : yield* startStudio(paths, path, config, spark.keys);
  const gatewayPid = yield* startGateway(paths, config, spark.keys);
  const state: SparkState = {
    keys: spark.keys,
    sparkPid: spark.pid,
    gatewayPid,
    studioContainer: studio,
    apiPort: config.apiPort,
    studioPort: config.studioPort,
    sparkPort: config.sparkPort,
  };
  yield* writeState(paths, state);
  if (studio !== null) {
    yield* waitUntil(
      "Studio",
      answers(`http://127.0.0.1:${config.studioPort}/api/platform/profile`),
      "120 seconds",
    );
  }
  yield* output.raw("Started supabase local development setup (experimental Spark backend).\n\n");
  yield* printStatus(state);
});

const printStatus = Effect.fn("spark.status.print")(function* (state: SparkState) {
  const output = yield* Output;
  const api = apiUrl(state);
  const rows: ReadonlyArray<readonly [string, string]> = [
    ["API URL", api],
    ["REST URL", `${api}/rest/v1`],
    ["Auth URL", `${api}/auth/v1`],
    [
      "Studio URL",
      state.studioContainer === null ? "(disabled)" : `http://127.0.0.1:${state.studioPort}`,
    ],
    ["Database", "spark (supabase/.temp/spark.db)"],
    ["Spark admin URL", `${sparkUrl(state)}/_spark/v1`],
    ["JWT secret", state.keys.jwt],
    ["anon key", state.keys.anon],
    ["service_role key", state.keys.service],
  ];
  if (output.format !== "text") {
    return yield* output.result({
      backend: "spark",
      api_url: api,
      rest_url: `${api}/rest/v1`,
      auth_url: `${api}/auth/v1`,
      studio_url: state.studioContainer === null ? null : `http://127.0.0.1:${state.studioPort}`,
      jwt_secret: state.keys.jwt,
      anon_key: state.keys.anon,
      service_role_key: state.keys.service,
    });
  }
  yield* output.raw(`${rows.map(([l, v]) => `${l.padStart(18)}: ${v}`).join("\n")}\n`);
});

const runningState = Effect.fn("spark.runningState")(function* (paths: SparkPaths) {
  const state = yield* readState(paths);
  if (state === undefined || !(yield* isAlive(state.sparkPid))) {
    return yield* fail("the Spark stack is not running: run `supabase start`");
  }
  return state;
});

/** `supabase status` on the Spark backend. */
export const sparkStatus = Effect.fn("spark.status")(function* () {
  const output = yield* Output;
  const { paths } = yield* context();
  const state = yield* runningState(paths);
  yield* printStatus(state);
  if (!(yield* isAlive(state.gatewayPid))) {
    yield* output.raw(
      `WARN: the Spark gateway is not running (log: ${paths.log("gateway")})\n`,
      "stderr",
    );
  }
});

/** `supabase stop` on the Spark backend; data in supabase/.temp/spark.db is kept. */
export const sparkStop = Effect.fn("spark.stop")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const { paths } = yield* context();
  const state = yield* readState(paths);
  if (state !== undefined) {
    yield* stopDaemon(state.gatewayPid);
    yield* stopDaemon(state.sparkPid);
    if (state.studioContainer !== null) yield* docker(["rm", "-f", state.studioContainer]);
    yield* fs.remove(paths.state, { force: true });
  }
  yield* output.raw("Stopped supabase local development setup.\n", "stderr");
});

const pgDelta = Effect.fn("spark.pgDelta")(function* (
  config: SparkSettings,
  args: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  return yield* runCaptured("spark.pgDelta", config.bunBin, [
    path.join(config.pgDeltaDir, "src", "cli", "main.ts"),
    "spark",
    ...args,
  ]);
});

const sparkAuth = (state: SparkState) => ["--url", sparkUrl(state), "--key", state.keys.service];

/** `supabase db diff -f <name>`: pg-delta plans supabase/schemas against Spark and proves it on scratch. */
export const sparkDbDiff = Effect.fn("spark.db.diff")(function* (file: string | undefined) {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const { paths, config, path } = yield* context();
  const state = yield* runningState(paths);
  if (!(yield* fs.exists(paths.schemas))) {
    return yield* fail("no supabase/schemas directory: run `supabase db pull` first");
  }
  const tmp = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-spark-plan-" });
  const planFile = path.join(tmp, "plan.sql");
  const run = yield* pgDelta(config, [
    "plan",
    ...sparkAuth(state),
    "--schema",
    paths.schemas,
    "--out-plan",
    planFile,
  ]);
  yield* output.raw(run.stderr, "stderr");
  if (run.code !== 0) return yield* fail(`pg-delta could not plan the change:\n${run.stdout}`);
  if (!(yield* fs.exists(planFile))) {
    yield* output.raw("No schema changes found\n");
    return;
  }
  const sql = yield* fs.readFileString(planFile);
  if (file === undefined) {
    yield* output.raw(sql);
    return;
  }
  const version = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  const name = `${version}_${file}.sql`;
  yield* fs.makeDirectory(paths.migrations, { recursive: true });
  yield* fs.writeFileString(path.join(paths.migrations, name), sql);
  yield* output.raw(`Created new migration at supabase/migrations/${name}\n`);
}, Effect.scoped);

/** `supabase db pull`: pg-delta exports Spark's schema to supabase/schemas. */
export const sparkDbPull = Effect.fn("spark.db.pull")(function* () {
  const output = yield* Output;
  const { paths, config } = yield* context();
  const state = yield* runningState(paths);
  const run = yield* pgDelta(config, ["export", ...sparkAuth(state), "--out", paths.schemas]);
  yield* output.raw(run.stdout + run.stderr, "stderr");
  if (run.code !== 0) return yield* fail("pg-delta export failed");
  yield* output.raw("Finished supabase db pull.\n");
});

interface MigrationStatus {
  readonly line: number;
  readonly status: string;
  readonly message?: string;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

/** `supabase db push`: dry-runs every pending migration on Spark, then applies them in order. */
export const sparkDbPush = Effect.fn("spark.db.push")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const output = yield* Output;
  const { paths, path } = yield* context();
  const state = yield* runningState(paths);
  const files = (yield* fs.exists(paths.migrations))
    ? (yield* fs.readDirectory(paths.migrations)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
    : [];
  const base = `${sparkUrl(state)}/_spark/v1/migrations`;
  const headers = { "content-type": "application/json", apikey: state.keys.service };
  const listed = yield* sparkHttp("GET", base, { headers });
  const applied = parseJson(listed.text);
  const done = new Set(
    Array.isArray(applied) ? applied.map((m) => String(field(m, "version"))) : [],
  );
  const pending = files.filter((f) => !done.has(f.split("_")[0] ?? ""));
  yield* Effect.annotateCurrentSpan({ "spark.migrations.pending": pending.length });
  if (pending.length === 0) {
    yield* output.raw("Remote database is up to date.\n");
    return;
  }
  const body = Effect.fnUntraced(function* (f: string) {
    const [version = "", ...rest] = f.replace(/\.sql$/, "").split("_");
    const sql = yield* fs.readFileString(path.join(paths.migrations, f));
    return JSON.stringify({ version, name: rest.join("_"), sql });
  });
  for (const f of pending) {
    const r = yield* sparkHttp("POST", `${base}?dry_run=1`, { headers, body: yield* body(f) });
    const out = parseJson(r.text);
    const statuses = field(out, "statuses");
    for (const s of (Array.isArray(statuses) ? statuses : []) as MigrationStatus[]) {
      if (s.status !== "ok") {
        yield* output.raw(
          `${f}:${s.line}: ${s.status}${s.message ? `: ${s.message}` : ""}\n`,
          "stderr",
        );
      }
    }
    if (r.status >= 400) return yield* fail(`${f}: ${String(field(out, "message"))}`);
    if (field(out, "ok") !== true)
      return yield* fail(`${f} does not apply on Spark; nothing was pushed`);
  }
  for (const f of pending) {
    yield* output.raw(`Applying migration ${f}...\n`, "stderr");
    const r = yield* sparkHttp("POST", base, { headers, body: yield* body(f) });
    if (r.status >= 400) return yield* fail(`${f}: ${String(field(parseJson(r.text), "message"))}`);
  }
  yield* syncGateway(apiUrl(state)).pipe(Effect.ignore);
  yield* output.raw("Finished supabase db push.\n");
});

/** `supabase db reset`: rebuilds Spark's database from migrations and seed files. */
export const sparkDbReset = Effect.fn("spark.db.reset")(function* () {
  const output = yield* Output;
  const { paths, config } = yield* context();
  const state = yield* readState(paths);
  const running = state !== undefined && (yield* isAlive(state.sparkPid));
  if (state !== undefined) yield* stopDaemon(state.sparkPid);
  const reset = yield* runCaptured("spark.db.reset.run", config.sparkBin, ["db", "reset"], {
    cwd: paths.root,
  });
  yield* output.raw(reset.stdout + reset.stderr, "stderr");
  if (reset.code !== 0) return yield* fail("spark db reset failed");
  if (running && state !== undefined) {
    const spark = yield* startSpark(paths, { ...config, sparkPort: state.sparkPort });
    yield* writeState(paths, { ...state, sparkPid: spark.pid, keys: spark.keys });
    yield* syncGateway(apiUrl(state)).pipe(Effect.ignore);
  }
  yield* output.raw("Finished supabase db reset.\n");
});

/** `supabase gen types typescript --local`: types from Spark's schema description. */
export const sparkGenTypes = Effect.fn("spark.gen.types")(function* (
  lang: string,
  schemas: ReadonlyArray<string>,
) {
  const output = yield* Output;
  if (lang !== "typescript") return yield* sparkUnsupported(`gen types ${lang}`);
  const { paths } = yield* context();
  const state = yield* runningState(paths);
  const query = schemas.length > 0 ? schemas.join(",") : "public";
  const r = yield* sparkHttp(
    "GET",
    `${apiUrl(state)}/_dev/types/typescript?included_schemas=${encodeURIComponent(query)}`,
  );
  if (r.status !== 200) return yield* fail(`the Spark gateway returned no types: ${r.text}`);
  yield* output.raw(r.text);
});
