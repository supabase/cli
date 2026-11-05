import { BunCrypto, BunServices } from "@effect/platform-bun";
import { Context, Data, Effect, FileSystem, Layer, Option, Path, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { CommandPlatformApiFactory } from "../../src/auth/command-platform-api-factory.service.ts";
import { dbConnectionLayer } from "../../src/command-internal/db-connection.sql-pg.layer.ts";
import { cliProjectFilterValue } from "../../src/command-internal/docker-ids.ts";
import { dockerRemoveAll } from "../../src/command-internal/docker-remove-all.ts";
import { dockerRunLayer } from "../../src/command-internal/docker-run.layer.ts";
import {
  DebugFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  YesFlag,
} from "../../src/command-internal/global-flags.ts";
import { stackCatalogSetupLayer } from "../../src/command-internal/stack-catalog-setup.ts";
import {
  StackApi,
  stackApiLayer,
  stackTargetResolverLayer,
} from "../../src/commands/experimental/stack/stack.shared.ts";
import { stackStart } from "../../src/commands/experimental/stack/start/start.handler.ts";
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

/** Host ports a legacy project binds; stack projects leave them out and get automatic ports. */
interface LegacyPorts {
  readonly api: number;
  readonly db: number;
  readonly mailpit: number;
}

const port = (value: number | undefined) => (value === undefined ? "" : `port = ${value}\n`);

const config = (projectId: string, ports: LegacyPorts | undefined) => `project_id = "${projectId}"

[api]
${port(ports?.api)}
[db]
${port(ports?.db)}
[db.pooler]
enabled = false

[auth.email]
enable_confirmations = true

[local_smtp]
enabled = true
${port(ports?.mailpit)}
[realtime]
enabled = true

[storage]
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

const migration = `create table public.contract_items (id int primary key, label text not null);
insert into public.contract_items values (1, 'contract');
grant select, insert on public.contract_items to anon;
`;

const echoFunction = `Deno.serve(() => Response.json({ ok: true }));
`;

/** Writes the one project every contract setup starts. */
const writeContractProject = Effect.fn("Contract.writeProject")(function* (
  root: string,
  projectId: string,
  ports?: LegacyPorts,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supabase = path.join(root, "supabase");
  yield* fs.makeDirectory(path.join(supabase, "migrations"), { recursive: true });
  yield* fs.makeDirectory(path.join(supabase, "functions", "echo"), { recursive: true });
  yield* fs.writeFileString(path.join(supabase, "config.toml"), config(projectId, ports));
  yield* fs.writeFileString(
    path.join(supabase, "migrations", "20260101000000_contract.sql"),
    migration,
  );
  yield* fs.writeFileString(path.join(supabase, "functions", "echo", "index.ts"), echoFunction);
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

/** The `status` env a consumer copies from one running local setup, every reported name kept. */
export class ContractTarget extends Context.Service<ContractTarget, typeof ContractEnv.Type>()(
  "supabase/tests/ContractTarget",
) {}

class ContractTargetError extends Data.TaggedError("ContractTargetError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

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
    stdinLayer.pipe(Layer.provide(tty)),
    tty,
  );
};

/** Starts one stack in-process with automatic ports and destroys it when the scope closes. */
export const stackTarget = (runtime: "native" | "docker") =>
  Layer.effect(
    ContractTarget,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* RuntimeInfo;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: `contract-${runtime}-`,
        /* Linux Edge Runtime overlays /tmp with a private worker filesystem, so native functions need a visible host path. */
        ...(runtime === "native" && host.platform === "linux" ? { directory: host.homeDir } : {}),
      });
      yield* writeContractProject(root, sanitizeProjectId(path.basename(root)));
      const cacheRoot = path.join(root, "cache", "stack");
      yield* fs.makeDirectory(stackArtifactCacheRoot, { recursive: true });
      yield* fs.makeDirectory(path.dirname(cacheRoot), { recursive: true });
      yield* fs.symlink(stackArtifactCacheRoot, cacheRoot);
      const output = mockOutput({ format: "json" });
      const layers = Layer.mergeAll(
        sharedLayers(output, ["stack", "start"]),
        stackTargetResolverLayer.pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              mockCommandSettings({ workdir: root, supabaseHome: root }),
              stackApiLayer,
            ),
          ),
        ),
        stackCatalogSetupLayer,
      );
      const context = yield* Layer.build(layers);
      yield* Effect.addFinalizer(() =>
        StackApi.use((stackApi) =>
          destroyTestStacks(stackApi, path.join(root, "stacks"), cacheRoot),
        ).pipe(Effect.provide(context)),
      );
      yield* stackStart({
        exclude: [],
        stack: Option.none(),
        stackId: Option.none(),
        runtime,
        preparation: "background",
        frozen: false,
        eager: false,
      }).pipe(Effect.provide(context), guardStart);
      return (yield* startedEnv(output, Schema.Struct({ env: ContractEnv }))).env;
    }),
  ).pipe(Layer.provide(hostServices));

/** Starts the legacy Docker stack in-process and removes everything labelled with its project id. */
export const legacyTarget = Layer.effect(
  ContractTarget,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "contract-legacy-" });
    const projectId = sanitizeProjectId(path.basename(root));
    /* Legacy Docker binds the fixed host ports in config.toml, so probing them first is intrinsic.
       This is the only integration allocator below the stack's 10000+ auto ports. */
    yield* writeContractProject(root, projectId, {
      api: yield* pickFreePort,
      db: yield* pickFreePort,
      mailpit: yield* pickFreePort,
    });
    const output = mockOutput({ format: "json" });
    const layers = Layer.mergeAll(
      sharedLayers(output, ["start"]),
      mockCommandSettings({ workdir: root, supabaseHome: root }),
      stackApiLayer,
      dockerRunLayer.pipe(Layer.provideMerge(processControlLayer)),
      mockAnalytics().layer,
      Layer.succeed(NetworkIdFlag, Option.none()),
    );
    yield* Effect.addFinalizer(() =>
      ChildProcessSpawner.ChildProcessSpawner.use((spawner) =>
        dockerRemoveAll(spawner, cliProjectFilterValue(projectId), true),
      ).pipe(Effect.orDie),
    );
    yield* start({ exclude: [], ignoreHealthCheck: false, preview: false }).pipe(
      Effect.provide(layers),
      guardStart,
    );
    return yield* startedEnv(output, ContractEnv);
  }),
).pipe(Layer.provide(hostServices));
