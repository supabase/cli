import type { ServiceDef } from "@supabase/process-compose";
import { Deferred, Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { defaultPublishableKey, defaultSecretKey, generateJwt } from "../../src/JwtGenerator.ts";
import type { ResolvedStackConfig, StackConfig } from "../../src/StackBuilder.ts";
import {
  enabledServicesForConfig,
  StackBuilder,
  versionsForConfig,
} from "../../src/StackBuilder.ts";
import type { StackPreparationInput } from "../../src/StackPreparation.ts";
import { StackPreparation } from "../../src/StackPreparation.ts";
import { DEFAULT_VERSIONS } from "../../src/versions.ts";
import { mockBinaryResolver } from "./mocks.ts";

const encoder = new TextEncoder();

/**
 * Mirrors the local helper of the same name in `src/StackBuilder.unit.test.ts` /
 * `src/prefetch.unit.test.ts`. Not centralized in `mocks.ts` to avoid touching those
 * pre-existing test files for this change; only the exit code matters here since the
 * fixtures below never enable any docker-only service (no registry pulls happen).
 */
function mockSequenceSpawner(
  results: ReadonlyArray<{ readonly exitCode: number; readonly stderr?: string[] }>,
) {
  let index = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((_command) =>
      Effect.gen(function* () {
        const result = results[index] ?? { exitCode: 0 };
        index += 1;
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(3000 + index),
          stdout: Stream.empty,
          stderr: Stream.fromIterable(
            (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`)),
          ),
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(true),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );
}

const testJwtSecret = "super-secret-jwt-token-with-at-least-32-characters";

const basePorts = {
  apiPort: 3000,
  dbPort: 5432,
  authPort: 9999,
  postgrestPort: 3001,
  postgrestAdminPort: 3002,
  edgeRuntimePort: 3003,
  edgeRuntimeInspectorPort: 3004,
  realtimePort: 3010,
  storagePort: 3011,
  imgproxyPort: 3012,
  mailpitPort: 3013,
  mailpitSmtpPort: 3014,
  mailpitPop3Port: 3015,
  pgmetaPort: 3016,
  studioPort: 3017,
  analyticsPort: 3018,
  poolerPort: 3019,
  poolerApiPort: 3020,
};

/**
 * Minimal ResolvedStackConfig fixture with every optional service disabled. Mirrors
 * `baseConfig` in `src/StackBuilder.unit.test.ts`; kept in sync manually since the two
 * currently have no shared export.
 */
const baseConfig: ResolvedStackConfig = {
  cacheRoot: "/tmp/supabase-cache",
  stackRoot: "/tmp/supabase-stack",
  runtimeRoot: "/tmp/supabase-runtime",
  projectDir: "/tmp/supabase-project",
  mode: "auto",
  jwtSecret: testJwtSecret,
  lazyServices: false,
  ports: basePorts,
  apiPort: 3000,
  dbPort: 5432,
  publishableKey: defaultPublishableKey,
  secretKey: defaultSecretKey,
  functions: false,
  autoManagedPaths: [],
  anonJwt: generateJwt(testJwtSecret, "anon"),
  serviceRoleJwt: generateJwt(testJwtSecret, "service_role"),
  postgres: {
    port: 5432,
    dataDir: "/tmp/pg-data",
    version: DEFAULT_VERSIONS.postgres,
    password: "postgres",
    autoExposeNewTables: true,
  },
  postgrest: false,
  auth: false,
  edgeRuntime: false,
  realtime: false,
  storage: false,
  imgproxy: false,
  mailpit: false,
  pgmeta: false,
  studio: false,
  analytics: false,
  vector: false,
  pooler: false,
};

/**
 * Builds the ServiceDef list produced by `StackBuilder.build()` for a partial
 * `StackConfig`, with every service other than postgres disabled by default and no real
 * process spawning (BinaryResolver and ChildProcessSpawner are both mocked). Only the
 * `postgres` sub-config and `mode` are honored from the provided partial config; this stays
 * intentionally narrow because it currently only backs the `provisioned`/`profile` wiring tests.
 */
export async function buildServicesForTest(
  partial: Pick<StackConfig, "postgres"> & Pick<Partial<StackConfig>, "mode">,
): Promise<ReadonlyArray<ServiceDef>> {
  const config: ResolvedStackConfig = {
    ...baseConfig,
    mode: partial.mode ?? baseConfig.mode,
    postgres: {
      ...baseConfig.postgres,
      ...partial.postgres,
    },
  };

  const resolver = mockBinaryResolver();
  const layer = Layer.mergeAll(
    StackBuilder.layer,
    StackPreparation.layer.pipe(
      Layer.provide(resolver.layer),
      Layer.provide(mockSequenceSpawner([{ exitCode: 0 }])),
    ),
  );

  const program = Effect.gen(function* () {
    const builder = yield* StackBuilder;
    const preparation = yield* StackPreparation;
    const input: StackPreparationInput = {
      mode: config.mode,
      services: enabledServicesForConfig(config),
      versions: versionsForConfig(config),
    };
    const prepared = yield* preparation.prepare(input);
    const { graph } = yield* builder.build(config, prepared);
    return graph.startOrder;
  }).pipe(Effect.provide(layer));

  return Effect.runPromise(program as Effect.Effect<ReadonlyArray<ServiceDef>, unknown>);
}
