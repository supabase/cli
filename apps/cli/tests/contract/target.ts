import { BunCrypto, BunServices } from "@effect/platform-bun";
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Schema, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { CommandPlatformApiFactory } from "../../src/auth/command-platform-api-factory.service.ts";
import { spawnContainerCli } from "../../src/command-internal/container-cli.ts";
import { dbConnectionLayer } from "../../src/command-internal/db-connection.sql-pg.layer.ts";
import {
  cliProjectFilterValue,
  serviceContainerName,
} from "../../src/command-internal/docker-ids.ts";
import { dockerRemoveAll } from "../../src/command-internal/docker-remove-all.ts";
import { dockerRunLayer } from "../../src/command-internal/docker-run.layer.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../src/command-internal/global-flags.ts";
import { localDockerEngineLayer } from "../../src/command-internal/db-bootstrap/local-db-running.ts";
import { resetLocalDatabase } from "../../src/command-internal/db-bootstrap/reset-local-database.ts";
import { type StackBackend, stackBackendLayer } from "../../src/command-internal/stack-backend.ts";
import { stackCatalogSetupLayer } from "../../src/command-internal/stack-catalog-setup.ts";
import {
  StackApi,
  stackApiLayer,
  stackTargetResolverLayer,
} from "../../src/command-internal/stack-target.ts";
import { stackStart } from "../../src/commands/experimental/stack/start/start.handler.ts";
import { KONG_LOCAL_TLS_CERT } from "../../src/commands/start/templates/kong-local-tls.ts";
import { start } from "../../src/commands/start/start.handler.ts";
import { CliArgs } from "../../src/shared/cli/cli-args.service.ts";
import { sanitizeProjectId } from "../../src/shared/config/project-id.ts";
import { processControlLayer } from "../../src/shared/runtime/process-control.layer.ts";
import { runtimeInfoLayer } from "../../src/shared/runtime/runtime-info.layer.ts";
import { RuntimeInfo } from "../../src/shared/runtime/runtime-info.service.ts";
import { stdinLayer } from "../../src/shared/runtime/stdin.layer.ts";
import { pickFreePort } from "../helpers/cli.ts";
import { mockCommandSettings, mockTelemetryStateTracked } from "../helpers/command-mocks.ts";
import { cliConfigValuesTestLayer } from "../helpers/config-values-layer.ts";
import { mockAnalytics, mockOutput, mockTty } from "../helpers/mocks.ts";
import { stackArtifactCacheRoot } from "../helpers/stack-artifacts.ts";
import { destroyTestStacks } from "../helpers/stack-cleanup.ts";

/** Only the configured invite template carries this, so a mail holding it proves the fetch. */
export const inviteTemplateMarker = "contract invite template marker";

/** Host ports a legacy project binds; stack projects leave them out and get automatic ports. */
interface LegacyPorts {
  readonly api: number;
  readonly db: number;
  readonly mailpit: number;
}

const port = (value: number | undefined) => (value === undefined ? "" : `port = ${value}\n`);

/** `default` serves `api.tls` with legacy's embedded pair; `custom` with a project pair. */
type ContractTls = "default" | "custom";

const tlsSection = (tls: ContractTls | undefined) =>
  tls === undefined
    ? ""
    : `[api.tls]
enabled = true
${tls === "custom" ? 'cert_path = "certs/api.crt"\nkey_path = "certs/api.key"\n' : ""}`;

const config = (
  projectId: string,
  ports: LegacyPorts | undefined,
  tls?: ContractTls,
) => `project_id = "${projectId}"

[api]
${port(ports?.api)}
${tlsSection(tls)}
[db]
${port(ports?.db)}
[db.pooler]
enabled = false

[db.seed]
sql_paths = ["./seeds/zz.sql", "./seeds/*.sql"]

[auth.email]
enable_confirmations = true

[auth.email.template.invite]
subject = "Contract invite"
content_path = "./supabase/templates/invite.html"

[local_smtp]
enabled = true
${port(ports?.mailpit)}
[realtime]
enabled = true

[storage]
enabled = true

[storage.buckets.config-public]
public = true
objects_path = "./buckets/public"

[storage.buckets.config-private]
public = false

[storage.vector.buckets.config-vectors]

[storage.analytics]
enabled = true

[edge_runtime]
enabled = true

[functions.echo]
verify_jwt = true

[studio]
enabled = false

[analytics]
enabled = false
`;

/* Migrations and seeds log to contract_log in run order: 0, 10, 2026, 9, skipping notes.sql and nested/,
   then zz once, then aa and mm. 10 creates config-public private, so the last seed mm seeing
   public=false and a public bucket at the end prove config buckets seed after every seed. */
const projectFiles = (projectId: string, ports: LegacyPorts | undefined, tls?: ContractTls) => ({
  "config.toml": config(projectId, ports, tls),
  "migrations/9_after_10.sql": `insert into public.contract_log (source) values ('migration 9');
`,
  "migrations/20260101000000_contract.sql": `create table public.contract_items (id int primary key, label text not null);
insert into public.contract_items values (1, 'contract');
grant select, insert on public.contract_items to anon;
insert into public.contract_log (source) values ('migration 20260101000000');
`,
  "migrations/10_buckets.sql": `insert into storage.buckets (id, name, public) values ('config-public', 'config-public', false);
insert into public.contract_log (source) values ('migration 10');
`,
  "migrations/0_log.sql": `create table public.contract_log (seq int generated always as identity primary key, source text not null);
alter table public.contract_log enable row level security;
grant select on public.contract_log to service_role;
insert into public.contract_log (source) select format('migration 0 sees auth=%s storage=%s realtime=%s', (to_regclass('auth.flow_state') is not null)::text, (to_regclass('storage.s3_multipart_uploads') is not null)::text, (to_regclass('realtime.messages') is not null)::text);
`,
  "migrations/notes.sql": `insert into public.contract_log (source) values ('notes.sql');
`,
  "migrations/nested/1_nested.sql": `insert into public.contract_log (source) values ('nested/1_nested.sql');
`,
  "seeds/mm.sql": `insert into public.contract_log (source) select 'seed mm sees public=' || public from storage.buckets where id = 'config-public';
`,
  "seeds/aa.sql": `insert into public.contract_log (source) values ('seed aa');
`,
  "seeds/zz.sql": `insert into public.contract_log (source) values ('seed zz');
`,
  "buckets/public/a.txt": "seeded object\n",
  "buckets/public/nested/b.txt": "nested object\n",
  "functions/echo/index.ts": `Deno.serve(() => Response.json({ ok: true }));
`,
  "templates/shared/invite.html": `<p>${inviteTemplateMarker}</p><a href="{{ .ConfirmationURL }}">Accept</a>
`,
});

/** Writes the one project every contract setup starts. */
const writeContractProject = Effect.fn("Contract.writeProject")(function* (
  root: string,
  projectId: string,
  ports?: LegacyPorts,
  tls?: ContractTls,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [name, content] of Object.entries(projectFiles(projectId, ports, tls))) {
    const file = path.join(root, "supabase", name);
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, content);
  }
  /* The invite template is an in-root symlink, which every setup serves like legacy. */
  yield* fs.symlink("shared/invite.html", path.join(root, "supabase", "templates/invite.html"));
});

const ContractEnv = Schema.StructWithRest(
  Schema.Struct({
    API_URL: Schema.String,
    FUNCTIONS_URL: Schema.String,
    MAILPIT_URL: Schema.String,
    PUBLISHABLE_KEY: Schema.String,
    SECRET_KEY: Schema.String,
    ANON_KEY: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.String)],
);

/** The certificate a client trusts for the setup's HTTPS API, or `undefined` over plain HTTP. */
export class ContractTrust extends Context.Service<ContractTrust, string | undefined>()(
  "supabase/tests/ContractTrust",
) {}

/* A pair standing in for a project's own `cert_path`/`key_path`, valid for 127.0.0.1. */
const customPair = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const certs = path.join(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "..",
    "packages",
    "stack",
    "tests",
    "certs",
  );
  return {
    cert: yield* fs.readFileString(path.join(certs, "trusted.crt")),
    key: yield* fs.readFileString(path.join(certs, "localhost.key")),
  };
});

/** The env `start` reports for one running local setup, every reported name kept. */
export class ContractTarget extends Context.Service<ContractTarget, typeof ContractEnv.Type>()(
  "supabase/tests/ContractTarget",
) {}

export class ContractTargetError extends Data.TaggedError("ContractTargetError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** Resets the running setup's local database through the path `db reset` takes on its backend. */
export class ContractReset extends Context.Service<
  ContractReset,
  Effect.Effect<void, ContractTargetError>
>()("supabase/tests/ContractReset") {}

const resetOn = (backend: StackBackend) =>
  resetLocalDatabase().pipe(
    Effect.scoped,
    Effect.provide(Layer.mergeAll(stackBackendLayer(backend), localDockerEngineLayer)),
    Effect.mapError((cause) => new ContractTargetError({ message: "db reset failed", cause })),
  );

const startedEnv = <A>(
  output: ReturnType<typeof mockOutput>,
  schema: Schema.Decoder<A>,
): Effect.Effect<A, ContractTargetError> =>
  Schema.decodeEffect(schema)(
    output.messages.findLast(({ type, data }) => type === "success" && data !== undefined)?.data,
  ).pipe(
    Effect.mapError(
      (cause) => new ContractTargetError({ message: "start reported no consumer env", cause }),
    ),
  );

/* `[api.tls]` must reach the started stack: an https API_URL that a client without the trusted
   certificate can't verify, so plain URLs never pass the TLS suites. */
const servesApiTls = Effect.fn("Contract.servesApiTls")(function* (apiUrl: string) {
  if (!apiUrl.startsWith("https://"))
    return yield* new ContractTargetError({
      message: `start with [api.tls] reported API_URL ${apiUrl}`,
      cause: undefined,
    });
  const fetch = yield* FetchHttpClient.Fetch;
  const untrusted = yield* Effect.tryPromise({
    try: (signal) => fetch(`${apiUrl}/rest/v1/`, { signal }).then(({ status }) => status),
    catch: (cause) =>
      new ContractTargetError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  }).pipe(
    Effect.match({
      onSuccess: (status) => `HTTP ${status}`,
      onFailure: (error) => error.message,
    }),
  );
  if (!/certificate/iu.test(untrusted))
    return yield* new ContractTargetError({
      message: `a client without the [api.tls] certificate got ${untrusted}`,
      cause: undefined,
    });
});

/* Interrupts a stuck start so its own rollback runs before the layer guard tears the fixture down. */
const guardStart = <A, E, R>(start: Effect.Effect<A, E, R>) =>
  Effect.timeoutOrElse(start, {
    duration: "4 minutes",
    orElse: () =>
      Effect.fail(
        new ContractTargetError({ message: "start ran past 4 minutes", cause: undefined }),
      ),
  });

const hostServices = Layer.mergeAll(BunServices.layer, BunCrypto.layer, runtimeInfoLayer);

const sharedLayers = (output: ReturnType<typeof mockOutput>, args: string[]) => {
  const tty = mockTty({ stdinIsTty: false, stdoutIsTty: false });
  return Layer.mergeAll(
    cliConfigValuesTestLayer,
    FetchHttpClient.layer,
    runtimeInfoLayer,
    output.layer,
    mockTelemetryStateTracked().layer,
    dbConnectionLayer,
    Layer.succeed(DebugFlag, false),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(YesFlag, false),
    Layer.succeed(CliArgs, { args }),
    Layer.succeed(CommandPlatformApiFactory, { make: Effect.die("unused by local start") }),
    Layer.succeed(NetworkIdFlag, Option.none()),
    dockerRunLayer.pipe(Layer.provideMerge(processControlLayer)),
    stdinLayer.pipe(Layer.provide(tty)),
    tty,
  );
};

/**
 * One stack project in-process with automatic ports, its stacks destroyed when the scope closes:
 * `start` runs `stack start` there.
 */
const stackProject = Effect.fn("Contract.stackProject")(function* (
  runtime: "native" | "docker",
  tls?: ContractTls,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* RuntimeInfo;
  const root = yield* fs.makeTempDirectoryScoped({
    prefix: `contract-${runtime}-`,
    /* Linux Edge Runtime overlays /tmp with a private worker filesystem, so native functions need a visible host path. */
    ...(runtime === "native" && host.platform === "linux" ? { directory: host.homeDir } : {}),
  });
  yield* writeContractProject(root, sanitizeProjectId(path.basename(root)), undefined, tls);
  const trust =
    tls === undefined
      ? undefined
      : tls === "default"
        ? KONG_LOCAL_TLS_CERT
        : yield* customPair.pipe(
            Effect.tap(({ cert, key }) =>
              Effect.all([
                fs.makeDirectory(path.join(root, "supabase", "certs"), { recursive: true }),
                fs.writeFileString(path.join(root, "supabase", "certs", "api.crt"), cert),
                fs.writeFileString(path.join(root, "supabase", "certs", "api.key"), key),
              ]),
            ),
            Effect.map(({ cert }) => cert),
          );
  const cacheRoot = path.join(root, "cache", "stack");
  const stateRoot = path.join(root, "stacks");
  yield* fs.makeDirectory(stackArtifactCacheRoot, { recursive: true });
  yield* fs.makeDirectory(path.dirname(cacheRoot), { recursive: true });
  yield* fs.symlink(stackArtifactCacheRoot, cacheRoot);
  const output = mockOutput({ format: "json" });
  const layers = Layer.mergeAll(
    sharedLayers(output, ["stack", "start"]),
    stackTargetResolverLayer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(mockCommandSettings({ workdir: root, supabaseHome: root }), stackApiLayer),
      ),
    ),
    stackCatalogSetupLayer,
  );
  const context = yield* Layer.build(layers.pipe(Layer.provideMerge(hostServices)));
  yield* Effect.addFinalizer(() =>
    StackApi.use((stackApi) => destroyTestStacks(stackApi, stateRoot, cacheRoot)).pipe(
      Effect.provide(context),
    ),
  );
  const start = stackStart({
    exclude: [],
    stack: Option.none(),
    stackId: Option.none(),
    runtime,
    preparation: "background",
    frozen: false,
    eager: false,
  }).pipe(Effect.provide(context), guardStart);
  const stackIds = StackApi.use((stackApi) => stackApi.discover({ stateRoot })).pipe(
    Effect.map((found) => found.map(({ definition }) => definition.id)),
    Effect.provide(context),
  );
  return { context, output, trust, start, stackIds };
});

/** Starts one stack in-process with automatic ports and destroys it when the scope closes. */
export const stackTarget = (runtime: "native" | "docker", tls?: ContractTls) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const { context, output, trust, start } = yield* stackProject(runtime, tls);
      yield* start;
      const { env } = yield* startedEnv(output, Schema.Struct({ env: ContractEnv }));
      if (trust !== undefined) yield* servesApiTls(env.API_URL).pipe(Effect.provide(context));
      const reset = resetOn("stack").pipe(Effect.provide(context));
      return Context.make(ContractTarget, env).pipe(
        Context.add(ContractReset, reset),
        Context.add(ContractTrust, trust),
      );
    }),
  ).pipe(Layer.provide(hostServices));

/**
 * Runs `stack start` for a container stack serving `[api.tls]` with legacy's embedded pair,
 * expecting it to fail: answers its error, the project's stack ids, and the service containers of
 * each still running afterwards (the stack-wide volume helper outlives its services by design).
 */
export const refusedTlsStart = Effect.gen(function* () {
  const { start, stackIds } = yield* stackProject("docker", "default");
  const error = yield* Effect.flip(start);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const ids = yield* stackIds;
  const running = yield* Effect.forEach(ids, (id) =>
    spawnContainerCli(
      spawner,
      [
        "ps",
        "--filter",
        `label=com.supabase.stack=${id}`,
        "--filter",
        "label=com.supabase.service",
        "--format",
        "{{.Names}}",
      ],
      { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
    ).pipe(
      Effect.flatMap((child) =>
        Effect.all(
          [
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        ),
      ),
      Effect.scoped,
      Effect.map(([names, stderr, code]) => ({
        code: Number(code),
        stderr,
        names: names.split("\n").filter((name) => name.length > 0),
      })),
    ),
  );
  return { message: error.message, ids, running };
}).pipe(Effect.scoped, Effect.provide(hostServices));

/* Works around a legacy start readiness gap: Realtime seeds through a throwaway node on :4000 before
   it execs the server, so its healthcheck can pass early. Wait for the line the stack treats as ready. */
const realtimeServerListening = Effect.fn("Contract.realtimeServerListening")(function* (
  projectId: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const listening = yield* spawnContainerCli(
    spawner,
    ["logs", "--follow", serviceContainerName("realtime", projectId)],
    { stdin: "ignore", stdout: "pipe", stderr: "ignore" },
  ).pipe(
    Effect.flatMap((logs) =>
      logs.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.dropWhile((line) => !line.includes("Starting Realtime")),
        Stream.filter((line) => line.includes("Running RealtimeWeb.Endpoint")),
        Stream.runHead,
      ),
    ),
    Effect.scoped,
    Effect.mapError(
      (cause) => new ContractTargetError({ message: "reading Realtime logs failed", cause }),
    ),
  );
  if (Option.isNone(listening))
    return yield* new ContractTargetError({
      message: "Realtime logs ended before its server listened",
      cause: undefined,
    });
});

/* Works around a legacy start gap: Auth fetches its templates before Kong's template server listens,
   keeps its built-in invite, and refetches every few seconds. Wait for a refetch that succeeded. */
const authInviteTemplateLoaded = Effect.fn("Contract.authInviteTemplateLoaded")(function* (
  projectId: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const loaded = yield* spawnContainerCli(
    spawner,
    ["logs", "--follow", serviceContainerName("auth", projectId)],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  ).pipe(
    Effect.flatMap((logs) =>
      Stream.merge(logs.stdout, logs.stderr).pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.includes('"mail_type":"invite"')),
        Stream.mapAccum(
          () => false,
          (failed, line) => {
            const reloaded = line.includes("templatemailer_reloader_template_update");
            return [reloaded ? false : line.includes("_error"), [reloaded && !failed]];
          },
        ),
        Stream.filter((ok) => ok),
        Stream.runHead,
      ),
    ),
    Effect.scoped,
    Effect.mapError(
      (cause) => new ContractTargetError({ message: "reading Auth logs failed", cause }),
    ),
  );
  if (Option.isNone(loaded))
    return yield* new ContractTargetError({
      message: "Auth logs ended before its invite template loaded",
      cause: undefined,
    });
});

/** Starts the legacy Docker stack in-process and removes everything labelled with its project id. */
export const legacyTarget = Layer.effectContext(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "contract-legacy-" });
    const projectId = sanitizeProjectId(path.basename(root));
    /* Legacy Docker binds the fixed host ports in config.toml, so probing them first is intrinsic.
       It skips 8915, the fixed API port start.native.integration.test.ts binds. */
    const legacyPort = pickFreePort.pipe(
      Effect.repeat({ until: (port) => port !== 8_915, times: 3 }),
    );
    yield* writeContractProject(root, projectId, {
      api: yield* legacyPort,
      db: yield* legacyPort,
      mailpit: yield* legacyPort,
    });
    const output = mockOutput({ format: "json" });
    const context = yield* Layer.build(
      Layer.mergeAll(
        sharedLayers(output, ["start"]),
        mockCommandSettings({ workdir: root, supabaseHome: root }),
        stackApiLayer,
        mockAnalytics().layer,
      ).pipe(Layer.provideMerge(hostServices)),
    );
    yield* Effect.addFinalizer(() =>
      ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        dockerRemoveAll(spawner, cliProjectFilterValue(projectId), true),
      ).pipe(Effect.orDie),
    );
    yield* start({ exclude: [], ignoreHealthCheck: false, preview: false }).pipe(
      Effect.provide(context),
      Effect.andThen(realtimeServerListening(projectId)),
      Effect.andThen(authInviteTemplateLoaded(projectId)),
      guardStart,
    );
    const env = yield* startedEnv(output, ContractEnv);
    const reset = resetOn("legacy").pipe(Effect.provide(context));
    return Context.make(ContractTarget, env).pipe(
      Context.add(ContractReset, reset),
      Context.add(ContractTrust, undefined),
    );
  }),
).pipe(Layer.provide(hostServices));
