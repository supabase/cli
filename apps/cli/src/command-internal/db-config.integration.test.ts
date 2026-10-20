import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  ConfigProvider,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Redacted,
  Stream,
} from "effect";
import * as TestClock from "effect/testing/TestClock";
import type { DatabaseInstance, Stack } from "@supabase/stack/effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "../../tests/helpers/mocks.ts";
import { VALID_TOKEN, mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import { pinnedConfigProvider } from "../../tests/helpers/config-env-pins.ts";
import { flagInput, withHermeticShellTier } from "../../tests/helpers/config-values-layer.ts";
import { unusedGateway } from "../../tests/helpers/unused-stack.ts";
import { assertBlockDrift } from "../../tests/helpers/permission-drift.ts";
import {
  primaryPoolerConfigs,
  stubManagementApi,
} from "../../tests/helpers/permission-real-layers.ts";
import { applicableOperations } from "../../tests/helpers/permission-registry.ts";
import type { ActiveFlags } from "../../tests/helpers/permission-registry.ts";
import {
  dbConfig,
  dbConfigLayer,
  dbConfigPoolerFallback,
  dbConfigResolverLayer,
} from "./db-config.layer.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "./global-flags.ts";
import { CliArgs } from "../shared/cli/cli-args.service.ts";
import { CliConfigFlagInputs, makeCliConfigFlagInputs } from "../config/cli-config-flags.ts";
import { commandTargetLayer } from "../shared/output/command-target.layer.ts";
import { cliConfigValuesLayer } from "../config/cli-config-values.layer.ts";
import { CliConfigValues } from "../config/cli-config-values.service.ts";
import { DebugLogger } from "../shared/output/debug-logger.service.ts";
import { identityStitchLayer } from "./identity-stitch.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import type { DbConnectionInput } from "./db-config.types.ts";
import { hostedMutationPreapproval } from "./hosted-consent/hosted-consent.ts";
import type { HostedMutationConsent } from "./hosted-consent/hosted-consent.token.ts";
import type { ResolvedTarget } from "./target/resolve-target.ts";
import { DbConnectError } from "./db-connection.errors.ts";
import { DbConnection, type DbSession, type PgConnInput } from "./db-connection.service.ts";
import { StackApi } from "./stack-api.ts";
import { stackBackendLayer } from "./stack-backend.ts";

// `--local` / `--db-url` never touch the Management API stack, so the resolver
// builds with simple ambient stubs. The `--linked` sub-flow (login-role,
// pooler, unban, backoff) requires the real management runtime with a mocked
// HTTP transport and is covered separately by the cli-e2e parity harness.
const mockDebugLogger = Layer.succeed(DebugLogger, {
  debug: () => Effect.void,
  http: () => Effect.void,
});

const mockDbConnection = Layer.succeed(DbConnection, {
  connect: () => Effect.die("unexpected connect() in --local/--db-url resolver test"),
});

const explicitEnv = (
  env: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(env ?? {}).flatMap(([name, value]): Array<[string, string]> =>
      value === undefined ? [] : [[name, value]],
    ),
  );

function buildResolver(
  workdir: string,
  opts: {
    readonly projectHost?: string;
    readonly poolerHost?: string;
    readonly dbConnection?: Layer.Layer<DbConnection>;
    readonly debugLogger?: Layer.Layer<DebugLogger>;
    readonly configEnv?: Record<string, string | undefined>;
    readonly stackApi?: Layer.Layer<StackApi>;
    readonly flagPassword?: string;
    readonly projectId?: string;
    readonly output?: ReturnType<typeof mockOutput>;
  } = {},
) {
  const out = opts.output ?? mockOutput();
  const deps = Layer.mergeAll(
    Layer.succeed(
      CliConfigFlagInputs,
      makeCliConfigFlagInputs(
        opts.flagPassword === undefined
          ? []
          : [flagInput("linkedDb.password", "password", opts.flagPassword)],
      ),
    ),
    mockCommandSettings({
      workdir,
      projectHost: opts.projectHost ?? "supabase.co",
      poolerHost: opts.poolerHost,
      projectId: Option.fromNullishOr(opts.projectId),
    }),
    opts.dbConnection ?? mockDbConnection,
    opts.debugLogger ?? mockDebugLogger,
    out.layer,
    commandTargetLayer.pipe(Layer.provide(out.layer)),
    mockAnalytics().layer,
    mockTelemetryRuntime(),
    mockTty(),
    mockRuntimeInfo(),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(WorkdirFlag, Option.some(workdir)),
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    // The resolver snapshots the one `IdentityStitch` for its lazy linked
    // stack; `--local`/`--db-url` never force it, but the layer reads it at build.
    identityStitchLayer.pipe(
      Layer.provide(mockAnalytics().layer),
      Layer.provide(mockTelemetryRuntime()),
      Layer.provide(BunServices.layer),
    ),
    BunServices.layer,
    Layer.effect(ConfigProvider.ConfigProvider, pinnedConfigProvider(explicitEnv(opts.configEnv))),
  );
  const hermeticValues = Layer.effect(
    CliConfigValues,
    Effect.map(Effect.service(CliConfigValues), (real) =>
      withHermeticShellTier(real, explicitEnv(opts.configEnv)),
    ),
  ).pipe(Layer.provide(cliConfigValuesLayer.pipe(Layer.provide(deps))));
  const depsWithValues = Layer.merge(deps, hermeticValues);
  return opts.stackApi === undefined
    ? dbConfigLayer.pipe(Layer.provide(depsWithValues))
    : dbConfigResolverLayer.pipe(Layer.provide(Layer.merge(depsWithValues, opts.stackApi)));
}

function withWorkdir(toml?: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "db-config-" });
    if (toml !== undefined) {
      yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "supabase", "config.toml"), toml);
    }
    return dir;
  });
}

const inputFor = (
  target: ResolvedTarget,
  overrides: Partial<DbConnectionInput> = {},
): DbConnectionInput => ({
  target,
  dnsResolver: "native",
  password: Option.none(),
  networkBanRemoval: Option.none(),
  ...overrides,
});

const localTarget: ResolvedTarget = { kind: "local" };
const dbUrlTarget = (url: string): ResolvedTarget => ({
  kind: "db-url",
  url: Redacted.make(url),
});
const linkedTarget = (
  ref: string,
  overrides: Partial<Extract<ResolvedTarget, { readonly kind: "linked" }>> = {},
): ResolvedTarget => ({
  kind: "linked",
  ref,
  source: "file",
  matchesLinkedRef: true,
  ...overrides,
});
const explicitRefTarget = (ref: string, overrides: { readonly matchesLinkedRef?: boolean } = {}) =>
  linkedTarget(ref, { source: "flag", ...overrides });

const approval = hostedMutationPreapproval.pipe(
  Effect.provide(
    Layer.mergeAll(Layer.succeed(YesFlag, true), Layer.succeed(CliArgs, { args: [] })),
  ),
);

const resolveConnection = (
  workdir: string,
  input: DbConnectionInput,
  opts?: Parameters<typeof buildResolver>[1],
) =>
  Effect.gen(function* () {
    const resolver = yield* DbConfigResolver;
    return yield* resolver.resolveConnection(input);
  }).pipe(
    Effect.provide(buildResolver(workdir, opts)),
    Effect.provideServiceEffect(
      ConfigProvider.ConfigProvider,
      pinnedConfigProvider(explicitEnv(opts?.configEnv)),
    ),
  );

const resolvePoolerFallback = (
  workdir: string,
  input: DbConnectionInput,
  opts?: Parameters<typeof buildResolver>[1],
) =>
  Effect.gen(function* () {
    const resolver = yield* DbConfigResolver;
    return yield* resolver.resolvePoolerFallback(input);
  }).pipe(
    Effect.provide(buildResolver(workdir, opts)),
    Effect.provideServiceEffect(
      ConfigProvider.ConfigProvider,
      pinnedConfigProvider(explicitEnv(opts?.configEnv)),
    ),
  );

const assertDbConfigDrift = (
  requests: ReadonlyArray<{ readonly method: string; readonly path: string }>,
  activeFlags: ActiveFlags,
) =>
  assertBlockDrift(dbConfig, {
    activeFlags,
    requests: requests.map((r) => ({
      method: r.method,
      url: `https://api.supabase.com${r.path}`,
    })),
  });

describe("dbConfigResolver (local + db-url)", () => {
  it.effect("local mode: uses 127.0.0.1 with config.toml db.port/password and is local", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir(
        ["[db]", "port = 55555", 'password = "hunter2"', ""].join("\n"),
      );
      return yield* resolveConnection(dir, inputFor(localTarget));
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn).toEqual({
            host: "127.0.0.1",
            port: 55555,
            user: "postgres",
            password: "hunter2",
            database: "postgres",
            // The resolver attaches the connect-failure suggestion context to every resolved
            // connection.
            suggestionContext: {
              dashboardUrl: "https://supabase.com/dashboard",
              profileName: "supabase",
            },
          });
          expect(r.isLocal).toBe(true);
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

  it.effect("local mode: honors SUPABASE_SERVICES_HOSTNAME for the connection host", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir();
      return yield* resolveConnection(dir, inputFor(localTarget), {
        configEnv: { SUPABASE_SERVICES_HOSTNAME: "host.docker.internal" },
      });
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.host).toBe("host.docker.internal");
          expect(r.isLocal).toBe(true);
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

  it.effect(
    "local mode on a linked checkout carries the --linked pointer in its connect hint",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* withWorkdir();
        yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
        yield* fs.writeFileString(
          path.join(dir, "supabase", ".temp", "project-ref"),
          "abcdefghijklmnopqrst",
        );
        const r = yield* resolveConnection(dir, inputFor(localTarget));
        expect(r.conn.suggestionContext).toMatchObject({ linkedCheckout: true });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect(
    "local mode with SUPABASE_PROJECT_ID set and no project-ref file carries the --linked pointer in its connect hint",
    () =>
      Effect.gen(function* () {
        const dir = yield* withWorkdir();
        const r = yield* resolveConnection(dir, inputFor(localTarget), {
          projectId: "abcdefghijklmnopqrst",
        });
        expect(r.conn.suggestionContext).toMatchObject({ linkedCheckout: true });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("local mode on an unlinked checkout adds no --linked pointer", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir();
      const r = yield* resolveConnection(dir, inputFor(localTarget));
      expect(r.conn.suggestionContext?.linkedCheckout).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("local mode: falls back to default port/password without a config.toml", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir();
      return yield* resolveConnection(dir, inputFor(localTarget));
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.port).toBe(54322);
          expect(r.conn.password).toBe("postgres");
          expect(r.isLocal).toBe(true);
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

  it.effect("db-url mode: parses the connection string and percent-decodes the password", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir();
      return yield* resolveConnection(
        dir,
        inputFor(dbUrlTarget("postgres://alice:p%40ss@example.com:6543/appdb")),
      );
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn).toEqual({
            host: "example.com",
            port: 6543,
            user: "alice",
            password: "p@ss",
            database: "appdb",
            suggestionContext: {
              dashboardUrl: "https://supabase.com/dashboard",
              profileName: "supabase",
            },
          });
          expect(r.isLocal).toBe(false);
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

  it.effect("db-url mode: a 127.0.0.1 url on the configured db.port is detected as local", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir();
      return yield* resolveConnection(
        dir,
        inputFor(dbUrlTarget("postgres://postgres:postgres@127.0.0.1:54322/postgres")),
      );
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.isLocal).toBe(true);
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

  it.effect("db-url mode: a multi-host url stays remote even when its primary is local", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir();
      return yield* resolveConnection(
        dir,
        inputFor(
          dbUrlTarget("postgres://postgres:pw@127.0.0.1:54322,db.example.com:5432/postgres"),
        ),
      );
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.fallbacks).toEqual([{ host: "db.example.com", port: 5432 }]);
          expect(r.isLocal).toBe(false);
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

  it.effect("db-url mode: a passwordless local url fills the password from config", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir(
        ["[db]", "port = 54322", 'password = "hunter2"', ""].join("\n"),
      );
      return yield* resolveConnection(
        dir,
        inputFor(dbUrlTarget("postgres://postgres@127.0.0.1:54322/postgres")),
      );
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.isLocal).toBe(true);
          expect(r.conn.password).toBe("hunter2");
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

  it.effect(
    "db-url mode: an invalid url fails with a parse error that redacts the password",
    () => {
      return Effect.gen(function* () {
        const dir = yield* withWorkdir();
        return yield* resolveConnection(
          dir,
          inputFor(dbUrlTarget("postgres://user:s3cret@ bad host/db")),
        );
      }).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const causeText = Cause.pretty(exit.cause);
              expect(causeText).toContain("DbConfigParseUrlError");
              expect(causeText).toContain("[REDACTED]");
              expect(causeText).not.toContain("s3cret");
            }
          }),
        ),
        Effect.scoped,
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect("db-url mode: preserves sslmode and the libpq options runtime param", () => {
    const url =
      "postgres://postgres:pw@example.com:5432/postgres?sslmode=verify-full&options=reference%3Dabcdefghijklmnop";
    return Effect.gen(function* () {
      const dir = yield* withWorkdir();
      return yield* resolveConnection(dir, inputFor(dbUrlTarget(url)));
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.sslmode).toBe("verify-full");
          expect(r.conn.options).toBe("reference=abcdefghijklmnop");
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    );
  });

  it.effect("db-url mode: accepts a libpq keyword/value DSN", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir();
      return yield* resolveConnection(
        dir,
        inputFor(dbUrlTarget("host=pg.example.com port=6543 user=admin dbname=app")),
      );
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.host).toBe("pg.example.com");
          expect(r.conn.port).toBe(6543);
          expect(r.conn.user).toBe("admin");
          expect(r.conn.database).toBe("app");
          expect(r.isLocal).toBe(false);
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    ),
  );

  it.effect(
    "db-url mode: a malformed percent escape is a redacted parse error, not a defect",
    () => {
      // `p%zz` is an invalid escape: `new URL` accepts it but `decodeURIComponent`
      // throws. It must surface as a normal parse failure, not an untyped defect.
      return Effect.gen(function* () {
        const dir = yield* withWorkdir();
        return yield* resolveConnection(
          dir,
          inputFor(dbUrlTarget("postgres://user:p%zz@example.com/db")),
        );
      }).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Option.isSome(Cause.findErrorOption(exit.cause))).toBe(true);
              const causeText = Cause.pretty(exit.cause);
              expect(causeText).toContain("DbConfigParseUrlError");
              expect(causeText).toContain("[REDACTED]");
              expect(causeText).not.toContain("p%zz");
            }
          }),
        ),
        Effect.scoped,
        Effect.provide(BunServices.layer),
      );
    },
  );
});

describe("dbConfigResolver (db-url under the stack backend)", () => {
  const STACK_SQL_PORT = 54329;
  const stackUrl = (port: number) =>
    `postgresql://supabase_admin:postgres@127.0.0.1:${port}/postgres?connect_timeout=10`;

  type StackState = "running" | "stopped" | "unregistered";

  const projectStackApi = (root: string, state: StackState) => {
    const unused = Effect.die("unused by the resolver");
    const database: DatabaseInstance = {
      id: "database-primary",
      service: "database",
      start: unused,
      ready: unused,
      stop: unused,
      restart: () => unused,
      destroy: unused,
      prepare: unused,
      status: Effect.succeed({
        id: "database-primary",
        endpoints:
          state === "running"
            ? [{ name: "sql", protocol: "tcp", host: "127.0.0.1", port: STACK_SQL_PORT }]
            : [],
        config: {
          service: "database",
          config: {
            version: "17.6.1.173",
            databasePassword: Redacted.make("stack-password"),
            jwtSecret: Redacted.make("secret"),
            jwtExpiry: 3600,
          },
          endpoints: {},
        },
        lifecycle: state === "running" ? "running" : "stopped",
        health: state === "running" ? "healthy" : undefined,
        error: undefined,
        exit: undefined,
        currentOperation: undefined,
        wakeEnabled: state === "running",
      }),
      followStatus: Stream.empty,
      readLogs: () => Stream.empty,
      credentials: () => unused,
      saveSnapshot: () => unused,
      restoreSnapshot: () => unused,
      resetData: unused,
    };
    const stack: Stack = {
      id: "b".repeat(64),
      services: { create: () => unused, get: () => Effect.succeed(database), list: unused },
      credentials: { get: unused },
      composition: {
        plan: () => unused,
        describe: Effect.succeed({
          members: [{ id: database.id, activation: "eager" }],
          dependencies: [],
        }),
        supabase: () => unused,
        configure: () => unused,
        start: unused,
        stop: unused,
        restart: unused,
      },
      startupEndpointChanges: unused,
      stop: unused,
      destroy: unused,
      gateway: unusedGateway,
      commands: { run: () => unused },
    };
    return Layer.succeed(StackApi, {
      create: () => unused,
      open: () => Effect.succeed(stack),
      discover: () => unused,
      find: () =>
        Effect.succeed(
          state !== "unregistered"
            ? Option.some({
                definition: {
                  id: stack.id,
                  identity: { projectRoot: root, branchContext: "main", stackName: "default" },
                  runtime: "native" as const,
                  instances: [],
                  lifetime: "detached" as const,
                  composition: { members: [], dependencies: [] },
                },
                host: undefined,
              })
            : Option.none(),
        ),
      findDeleted: () => Effect.die("unused"),
    });
  };

  const resolveOnStack = (
    dir: string,
    url: string,
    stackApi: Layer.Layer<StackApi> = projectStackApi(dir, "running"),
  ) =>
    resolveConnection(dir, inputFor(dbUrlTarget(url)), { stackApi }).pipe(
      Effect.provide(stackBackendLayer("stack")),
    );

  it.effect("treats the url printed by `stack status --env` as the local database", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveOnStack(yield* withWorkdir(), stackUrl(STACK_SQL_PORT));
      expect(resolved.isLocal).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("fills a passwordless stack url from the stack's credentials, not [db].password", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir(["[db]", 'password = "config-password"', ""].join("\n"));
      const resolved = yield* resolveOnStack(
        dir,
        `postgresql://postgres@127.0.0.1:${STACK_SQL_PORT}/postgres`,
      );
      expect(resolved.isLocal).toBe(true);
      expect(resolved.conn.password).toBe("stack-password");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("keeps a loopback url on another port remote so it still requires TLS", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveOnStack(yield* withWorkdir(), stackUrl(STACK_SQL_PORT + 1));
      expect(resolved.isLocal).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("fills from the stack's credentials when the stack port is also [db].port", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir(
        ["[db]", `port = ${STACK_SQL_PORT}`, 'password = "config-password"', ""].join("\n"),
      );
      const resolved = yield* resolveOnStack(
        dir,
        `postgresql://postgres@127.0.0.1:${STACK_SQL_PORT}/postgres`,
      );
      expect(resolved.isLocal).toBe(true);
      expect(resolved.conn.password).toBe("stack-password");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  for (const state of ["unregistered", "stopped"] as const) {
    it.effect(`resolves the stack url as remote when the project stack is ${state}`, () =>
      Effect.gen(function* () {
        const dir = yield* withWorkdir();
        const resolved = yield* resolveOnStack(
          dir,
          stackUrl(STACK_SQL_PORT),
          projectStackApi(dir, state),
        );
        expect(resolved.isLocal).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  }

  it.effect("keeps a multi-host url remote even when its primary is the stack endpoint", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveOnStack(
        yield* withWorkdir(),
        `postgresql://postgres:pw@127.0.0.1:${STACK_SQL_PORT},db.example.com:5432/postgres`,
      );
      expect(resolved.conn.fallbacks).toEqual([{ host: "db.example.com", port: 5432 }]);
      expect(resolved.isLocal).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("does not consult the stack for a non-loopback host", () =>
    Effect.gen(function* () {
      const untouchedStackApi = Layer.succeed(StackApi, {
        create: () => Effect.die("unexpected stack create"),
        open: () => Effect.die("unexpected stack open"),
        discover: () => Effect.die("unexpected stack discover"),
        find: () => Effect.die("unexpected stack lookup"),
        findDeleted: () => Effect.die("unexpected stack lookup"),
      });
      const resolved = yield* resolveOnStack(
        yield* withWorkdir(),
        `postgresql://postgres:pw@db.example.com:${STACK_SQL_PORT}/postgres`,
        untouchedStackApi,
      );
      expect(resolved.isLocal).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

describe("dbConfigResolver (linked config ordering)", () => {
  it.effect("validates the ref-merged config before any network work", () => {
    // The ref is sourced from the config's top-level project_id; the matching remote block
    // sets an unsupported major_version. If validation happened after the connection work,
    // `mockDbConnection.connect()` would die first.
    const ref = "abcdefghijklmnopqrst";
    return Effect.gen(function* () {
      const dir = yield* withWorkdir(
        [
          `project_id = "${ref}"`,
          "[db]",
          "major_version = 15",
          `[remotes.${ref.slice(0, 4)}]`,
          `project_id = "${ref}"`,
          `[remotes.${ref.slice(0, 4)}.db]`,
          "major_version = 99",
          "",
        ].join("\n"),
      );
      return yield* resolveConnection(dir, inputFor(linkedTarget(ref)));
    }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(Cause.pretty(exit.cause)).toContain(
              "Failed reading config: Invalid db.major_version: 99.",
            );
          }
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    );
  });

  it.effect("ad-hoc project refs ignore the linked workdir password and saved pooler URL", () => {
    const linkedRef = "abcdefghijklmnopqrst";
    const adHocRef = "qrstabcdefghijklmnop";

    const previousFetch = globalThis.fetch;
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const connections: Array<{
      readonly conn: PgConnInput;
      readonly dnsResolver: "native" | "https";
      readonly isLocal: boolean;
    }> = [];
    const session: DbSession = {
      exec: () => Effect.void,
      execBatch: () => Effect.void,
      query: () => Effect.succeed([]),
      extensionExists: () => Effect.succeed(false),
      copyToCsv: () => Effect.succeed(new Uint8Array()),
      queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "SELECT 1" }),
    };
    const dbConnection = Layer.succeed(DbConnection, {
      connect: (conn, options) =>
        Effect.sync(() => {
          connections.push({ conn, ...options });
          return session;
        }),
    });
    const fetchMock = Object.assign(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        requests.push({ method, path: url.pathname });

        if (
          method === "GET" &&
          url.pathname === `/v1/projects/${adHocRef}/config/database/pooler`
        ) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  identifier: "primary",
                  database_type: "PRIMARY",
                  is_using_scram_auth: true,
                  db_user: "postgres",
                  db_host: "db.example",
                  db_port: 5432,
                  db_name: "postgres",
                  connection_string: `postgres://postgres.${adHocRef}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                  connectionString: `postgres://postgres.${adHocRef}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                  default_pool_size: null,
                  max_client_conn: null,
                  pool_mode: "transaction",
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        if (method === "POST" && url.pathname === `/v1/projects/${adHocRef}/cli/login-role`) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                role: "cli_login_role",
                password: "temporary-role-password",
                ttl_seconds: 3600,
              }),
              { status: 201, headers: { "content-type": "application/json" } },
            ),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ message: "unexpected request" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      },
      { preconnect: previousFetch.preconnect },
    );

    globalThis.fetch = fetchMock;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* withWorkdir(
        [`project_id = "${linkedRef}"`, "[db]", "major_version = 15", ""].join("\n"),
      );
      yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "supabase", ".temp", "project-ref"), linkedRef);
      yield* fs.writeFileString(
        path.join(dir, "supabase", ".temp", "pooler-url"),
        `postgres://postgres.${linkedRef}:saved-workdir-password@stale.pooler.supabase.com:6543/postgres`,
      );
      return yield* resolveConnection(
        dir,
        inputFor(explicitRefTarget(adHocRef, { matchesLinkedRef: false })),
        {
          projectHost: "invalid",
          dbConnection,
          configEnv: {
            SUPABASE_ACCESS_TOKEN: VALID_TOKEN,
            SUPABASE_DB_PASSWORD: "ambient-linked-password",
          },
        },
      );
    }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn).toEqual({
            host: "aws-0-us-east-1.pooler.supabase.com",
            port: 5432,
            user: `cli_login_role.${adHocRef}`,
            password: "temporary-role-password",
            database: "postgres",
            suggestionContext: {
              dashboardUrl: "https://supabase.com/dashboard",
              profileName: "supabase",
            },
          });
          expect(r.ref).toEqual(Option.some(adHocRef));
          expect(requests).toEqual([
            {
              method: "GET",
              path: `/v1/projects/${adHocRef}/config/database/pooler`,
            },
            {
              method: "POST",
              path: `/v1/projects/${adHocRef}/cli/login-role`,
            },
          ]);
          expect(connections).toEqual([
            {
              conn: {
                host: "aws-0-us-east-1.pooler.supabase.com",
                port: 5432,
                user: `cli_login_role.${adHocRef}`,
                password: "temporary-role-password",
                database: "postgres",
              },
              isLocal: false,
              dnsResolver: "native",
            },
          ]);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.fetch = previousFetch;
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    );
  });

  it.effect(
    "ad-hoc pooler fallback ignores the linked workdir password and saved pooler URL",
    () => {
      const linkedRef = "abcdefghijklmnopqrst";
      const adHocRef = "qrstabcdefghijklmnop";

      const previousFetch = globalThis.fetch;
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const connections: Array<{
        readonly conn: PgConnInput;
        readonly dnsResolver: "native" | "https";
        readonly isLocal: boolean;
      }> = [];
      const session: DbSession = {
        exec: () => Effect.void,
        execBatch: () => Effect.void,
        query: () => Effect.succeed([]),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "SELECT 1" }),
      };
      const dbConnection = Layer.succeed(DbConnection, {
        connect: (conn, options) =>
          Effect.sync(() => {
            connections.push({ conn, ...options });
            return session;
          }),
      });
      const fetchMock = Object.assign(
        (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          requests.push({ method, path: url.pathname });

          if (
            method === "GET" &&
            url.pathname === `/v1/projects/${adHocRef}/config/database/pooler`
          ) {
            return Promise.resolve(
              new Response(
                JSON.stringify([
                  {
                    identifier: "primary",
                    database_type: "PRIMARY",
                    is_using_scram_auth: true,
                    db_user: "postgres",
                    db_host: "db.example",
                    db_port: 5432,
                    db_name: "postgres",
                    connection_string: `postgres://postgres.${adHocRef}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                    connectionString: `postgres://postgres.${adHocRef}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                    default_pool_size: null,
                    max_client_conn: null,
                    pool_mode: "transaction",
                  },
                ]),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }

          if (method === "POST" && url.pathname === `/v1/projects/${adHocRef}/cli/login-role`) {
            return Promise.resolve(
              new Response(
                JSON.stringify({
                  role: "cli_login_role",
                  password: "temporary-role-password",
                  ttl_seconds: 3600,
                }),
                { status: 201, headers: { "content-type": "application/json" } },
              ),
            );
          }

          return Promise.resolve(
            new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            }),
          );
        },
        { preconnect: previousFetch.preconnect },
      );

      globalThis.fetch = fetchMock;

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* withWorkdir(
          [`project_id = "${linkedRef}"`, "[db]", "major_version = 15", ""].join("\n"),
        );
        yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
        yield* fs.writeFileString(path.join(dir, "supabase", ".temp", "project-ref"), linkedRef);
        yield* fs.writeFileString(
          path.join(dir, "supabase", ".temp", "pooler-url"),
          `postgres://postgres.${linkedRef}:saved-workdir-password@stale.pooler.supabase.com:6543/postgres`,
        );
        return yield* resolvePoolerFallback(
          dir,
          inputFor(explicitRefTarget(adHocRef, { matchesLinkedRef: false })),
          {
            dbConnection,
            configEnv: {
              SUPABASE_ACCESS_TOKEN: VALID_TOKEN,
              SUPABASE_DB_PASSWORD: "ambient-linked-password",
            },
          },
        );
      }).pipe(
        Effect.tap((connOpt) =>
          Effect.sync(() => {
            expect(Option.isSome(connOpt)).toBe(true);
            if (Option.isSome(connOpt)) {
              expect(connOpt.value).toEqual({
                host: "aws-0-us-east-1.pooler.supabase.com",
                port: 5432,
                user: `cli_login_role.${adHocRef}`,
                password: "temporary-role-password",
                database: "postgres",
                suggestionContext: {
                  dashboardUrl: "https://supabase.com/dashboard",
                  profileName: "supabase",
                },
              });
            }
            expect(requests).toEqual([
              {
                method: "GET",
                path: `/v1/projects/${adHocRef}/config/database/pooler`,
              },
              {
                method: "POST",
                path: `/v1/projects/${adHocRef}/cli/login-role`,
              },
            ]);
            expect(connections).toEqual([
              {
                conn: {
                  host: "aws-0-us-east-1.pooler.supabase.com",
                  port: 5432,
                  user: `cli_login_role.${adHocRef}`,
                  password: "temporary-role-password",
                  database: "postgres",
                },
                isLocal: false,
                dnsResolver: "native",
              },
            ]);
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = previousFetch;
          }),
        ),
        Effect.scoped,
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect("linked pooler fallback fetches API config when the saved pooler URL is stale", () => {
    const linkedRef = "abcdefghijklmnopqrst";

    const previousFetch = globalThis.fetch;
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const connections: Array<{
      readonly conn: PgConnInput;
      readonly dnsResolver: "native" | "https";
      readonly isLocal: boolean;
    }> = [];
    const session: DbSession = {
      exec: () => Effect.void,
      execBatch: () => Effect.void,
      query: () => Effect.succeed([]),
      extensionExists: () => Effect.succeed(false),
      copyToCsv: () => Effect.succeed(new Uint8Array()),
      queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "SELECT 1" }),
    };
    const dbConnection = Layer.succeed(DbConnection, {
      connect: (conn, options) =>
        Effect.sync(() => {
          connections.push({ conn, ...options });
          return session;
        }),
    });
    const fetchMock = Object.assign(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        requests.push({ method, path: url.pathname });

        if (
          method === "GET" &&
          url.pathname === `/v1/projects/${linkedRef}/config/database/pooler`
        ) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                {
                  identifier: "primary",
                  database_type: "PRIMARY",
                  is_using_scram_auth: true,
                  db_user: "postgres",
                  db_host: "db.example",
                  db_port: 5432,
                  db_name: "postgres",
                  connection_string: `postgres://postgres.${linkedRef}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                  connectionString: `postgres://postgres.${linkedRef}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                  default_pool_size: null,
                  max_client_conn: null,
                  pool_mode: "transaction",
                },
              ]),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
        }

        return Promise.resolve(
          new Response(JSON.stringify({ message: "unexpected request" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          }),
        );
      },
      { preconnect: previousFetch.preconnect },
    );

    globalThis.fetch = fetchMock;

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* withWorkdir(
        [`project_id = "${linkedRef}"`, "[db]", "major_version = 15", ""].join("\n"),
      );
      yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "supabase", ".temp", "project-ref"), linkedRef);
      yield* fs.writeFileString(
        path.join(dir, "supabase", ".temp", "pooler-url"),
        "postgres://postgres.qrstabcdefghijklmnop:saved-workdir-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
      );
      return yield* resolvePoolerFallback(dir, inputFor(explicitRefTarget(linkedRef)), {
        projectHost: "supabase.co",
        dbConnection,
        configEnv: {
          SUPABASE_ACCESS_TOKEN: VALID_TOKEN,
          SUPABASE_DB_PASSWORD: "linked-password",
        },
      });
    }).pipe(
      Effect.tap((connOpt) =>
        Effect.sync(() => {
          expect(Option.isSome(connOpt)).toBe(true);
          if (Option.isSome(connOpt)) {
            expect(connOpt.value).toEqual({
              host: "aws-0-us-east-1.pooler.supabase.com",
              port: 5432,
              user: `postgres.${linkedRef}`,
              password: "linked-password",
              database: "postgres",
              suggestionContext: {
                dashboardUrl: "https://supabase.com/dashboard",
                profileName: "supabase",
              },
            });
          }
          expect(requests).toEqual([
            {
              method: "GET",
              path: `/v1/projects/${linkedRef}/config/database/pooler`,
            },
          ]);
          expect(connections).toEqual([]);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.fetch = previousFetch;
        }),
      ),
      Effect.scoped,
      Effect.provide(BunServices.layer),
    );
  });
});

// An explicit `--project-ref` must unlock the Management API pooler fetch on an IPv4-only
// network, even when it names the linked project, rather than staying confined to the workdir's
// saved `.temp/pooler-url` the way the plain `--linked` path is.
describe("dbConfigResolver (an explicit --project-ref fetches the pooler config)", () => {
  it.effect(
    "an unlinked workdir + explicit --project-ref resolves via the API pooler config, honoring the ambient password with no login-role mint",
    () => {
      const ref = "targetprojectrefabcd";

      const previousFetch = globalThis.fetch;
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const dbConnection = Layer.succeed(DbConnection, {
        connect: () =>
          Effect.die("unexpected connect() — the explicit password path never verify-connects"),
      });
      const fetchMock = Object.assign(
        (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          requests.push({ method, path: url.pathname });

          if (method === "GET" && url.pathname === `/v1/projects/${ref}/config/database/pooler`) {
            return Promise.resolve(
              new Response(
                JSON.stringify([
                  {
                    identifier: "primary",
                    database_type: "PRIMARY",
                    is_using_scram_auth: true,
                    db_user: "postgres",
                    db_host: "db.example",
                    db_port: 5432,
                    db_name: "postgres",
                    connection_string: `postgres://postgres.${ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                    connectionString: `postgres://postgres.${ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                    default_pool_size: null,
                    max_client_conn: null,
                    pool_mode: "transaction",
                  },
                ]),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }

          return Promise.resolve(
            new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            }),
          );
        },
        { preconnect: previousFetch.preconnect },
      );

      globalThis.fetch = fetchMock;

      // Fully unlinked: `withWorkdir()` creates no `supabase/` directory at all,
      // so there is no `.temp/project-ref` and no `.temp/pooler-url` to reuse.
      return Effect.gen(function* () {
        const dir = yield* withWorkdir();
        return yield* resolveConnection(
          dir,
          inputFor(explicitRefTarget(ref, { matchesLinkedRef: false })),
          {
            projectHost: "invalid",
            dbConnection,
            configEnv: {
              SUPABASE_ACCESS_TOKEN: VALID_TOKEN,
              SUPABASE_DB_PASSWORD: "ambient-password",
            },
          },
        );
      }).pipe(
        Effect.tap((r) =>
          Effect.sync(() => {
            expect(r.conn).toEqual({
              host: "aws-0-us-east-1.pooler.supabase.com",
              port: 5432,
              user: `postgres.${ref}`,
              password: "ambient-password",
              database: "postgres",
              suggestionContext: {
                dashboardUrl: "https://supabase.com/dashboard",
                profileName: "supabase",
              },
            });
            expect(r.ref).toEqual(Option.some(ref));
            expect(requests).toEqual([
              { method: "GET", path: `/v1/projects/${ref}/config/database/pooler` },
            ]);
            assertDbConfigDrift(requests, { linked: true, "project-ref": ref });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = previousFetch;
          }),
        ),
        Effect.scoped,
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "a saved pooler URL for a DIFFERENT project than --project-ref is rejected and the target ref's pooler is fetched",
    () => {
      const linkedRef = "workdirlinkedrefabcd";
      const targetRef = "targetprojectrefabcd";

      const previousFetch = globalThis.fetch;
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const dbConnection = Layer.succeed(DbConnection, {
        connect: () =>
          Effect.die("unexpected connect() — the ambient password path never verify-connects"),
      });
      const fetchMock = Object.assign(
        (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          requests.push({ method, path: url.pathname });

          if (
            method === "GET" &&
            url.pathname === `/v1/projects/${targetRef}/config/database/pooler`
          ) {
            return Promise.resolve(
              new Response(
                JSON.stringify([
                  {
                    identifier: "primary",
                    database_type: "PRIMARY",
                    is_using_scram_auth: true,
                    db_user: "postgres",
                    db_host: "db.example",
                    db_port: 5432,
                    db_name: "postgres",
                    connection_string: `postgres://postgres.${targetRef}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                    connectionString: `postgres://postgres.${targetRef}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
                    default_pool_size: null,
                    max_client_conn: null,
                    pool_mode: "transaction",
                  },
                ]),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }

          return Promise.resolve(
            new Response(JSON.stringify({ message: "unexpected request" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            }),
          );
        },
        { preconnect: previousFetch.preconnect },
      );

      globalThis.fetch = fetchMock;

      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* withWorkdir(
          [`project_id = "${linkedRef}"`, "[db]", "major_version = 15", ""].join("\n"),
        );
        yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
        yield* fs.writeFileString(path.join(dir, "supabase", ".temp", "project-ref"), linkedRef);
        yield* fs.writeFileString(
          path.join(dir, "supabase", ".temp", "pooler-url"),
          `postgres://postgres.${linkedRef}:saved-workdir-password@stale.pooler.supabase.com:6543/postgres`,
        );
        return yield* resolveConnection(
          dir,
          inputFor(explicitRefTarget(targetRef, { matchesLinkedRef: false })),
          {
            projectHost: "invalid",
            dbConnection,
            flagPassword: "flag-password",
            configEnv: {
              SUPABASE_ACCESS_TOKEN: VALID_TOKEN,
              SUPABASE_DB_PASSWORD: "ambient-password",
            },
          },
        );
      }).pipe(
        Effect.tap((r) =>
          Effect.sync(() => {
            expect(r.conn).toEqual({
              host: "aws-0-us-east-1.pooler.supabase.com",
              port: 5432,
              user: `postgres.${targetRef}`,
              password: "flag-password",
              database: "postgres",
              suggestionContext: {
                dashboardUrl: "https://supabase.com/dashboard",
                profileName: "supabase",
              },
            });
            expect(r.ref).toEqual(Option.some(targetRef));
            expect(requests).toEqual([
              { method: "GET", path: `/v1/projects/${targetRef}/config/database/pooler` },
            ]);
            assertDbConfigDrift(requests, { linked: true, "project-ref": targetRef });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = previousFetch;
          }),
        ),
        Effect.scoped,
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "an ad-hoc --remote=<ref> with no pooler configured suggests the pooler URL, not re-linking",
    () => {
      const ref = "adhocnopoolerrefabcd";
      const previousFetch = globalThis.fetch;
      const dbConnection = Layer.succeed(DbConnection, {
        connect: () => Effect.die("unexpected connect()"),
      });
      globalThis.fetch = Object.assign(
        (): Promise<Response> =>
          Promise.resolve(
            new Response("[]", { status: 200, headers: { "content-type": "application/json" } }),
          ),
        { preconnect: previousFetch.preconnect },
      );

      return Effect.gen(function* () {
        const dir = yield* withWorkdir();
        return yield* resolveConnection(
          dir,
          inputFor(explicitRefTarget(ref, { matchesLinkedRef: false })),
          {
            projectHost: "invalid",
            dbConnection,
            configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
          },
        );
      }).pipe(
        Effect.flip,
        Effect.tap((error) =>
          Effect.sync(() => {
            expect(error).toMatchObject({
              _tag: "DbConfigIpv6Error",
              remedy: "pooler-url",
              suggestion:
                "Pass the project's connection pooler URL with --remote=<pooler db-url> to connect over IPv4.",
            });
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = previousFetch;
          }),
        ),
        Effect.scoped,
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect(
    "the plain --linked path (no --project-ref) keeps the IPv6 error when the API has no pooler config either",
    () => {
      const ref = "plainlinkedrefabcdef";
      const requests: Array<{ readonly method: string; readonly path: string }> = [];

      return Effect.gen(function* () {
        yield* stubManagementApi(requests, (method, path) =>
          method === "GET" && path === `/v1/projects/${ref}/config/database/pooler`
            ? Response.json([])
            : undefined,
        );
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* withWorkdir(
          [`project_id = "${ref}"`, "[db]", "major_version = 15", ""].join("\n"),
        );
        yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
        yield* fs.writeFileString(path.join(dir, "supabase", ".temp", "project-ref"), ref);
        return yield* resolveConnection(dir, inputFor(linkedTarget(ref)), {
          projectHost: "invalid",
          configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        });
      }).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(requests).toEqual([
              { method: "GET", path: `/v1/projects/${ref}/config/database/pooler` },
            ]);
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const causeText = Cause.pretty(exit.cause);
              expect(causeText).toContain("DbConfigIpv6Error");
              const error = Cause.findErrorOption(exit.cause);
              expect(Option.isSome(error)).toBe(true);
              if (Option.isSome(error)) {
                expect(error.value).toMatchObject({
                  remedy: "link",
                  suggestion: `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
                });
              }
            }
          }),
        ),
        Effect.scoped,
        Effect.provide(BunServices.layer),
      );
    },
  );
});

/** Replaces `globalThis.fetch` for the scope: `respond` answers a request, anything else gets a 404. */
describe("dbConfigResolver (Management API calls)", () => {
  const noDirectConnect = Layer.succeed(DbConnection, {
    connect: () => Effect.die("unexpected connect()"),
  });
  const noApiCalls = (
    requests: ReadonlyArray<{ readonly method: string; readonly path: string }>,
    activeFlags: ActiveFlags,
  ) => {
    expect(requests).toEqual([]);
    expect(
      applicableOperations(
        { status: "mapped", operations: dbConfig.operations, noApiEffectFlags: [] },
        activeFlags,
      ),
    ).toEqual([]);
    assertDbConfigDrift(requests, activeFlags);
  };

  it.effect("--local makes no Management API request and the block declares none", () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      const dir = yield* withWorkdir();
      const r = yield* resolveConnection(dir, inputFor(localTarget));
      expect(r.isLocal).toBe(true);
      noApiCalls(requests, { local: true });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("--db-url makes no Management API request and the block declares none", () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      const dir = yield* withWorkdir();
      const r = yield* resolveConnection(
        dir,
        inputFor(dbUrlTarget("postgres://alice:secret@example.com:6543/appdb")),
      );
      expect(r.isLocal).toBe(false);
      noApiCalls(requests, { "db-url": true });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect(
    "a 403 on the pooler config fails with the IPv6 error when the direct host is unreachable",
    () => {
      const ref = "targetprojectrefabcd";
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, (method, path) =>
          method === "GET" && path === `/v1/projects/${ref}/config/database/pooler`
            ? Response.json({ message: "Forbidden" }, { status: 403 })
            : undefined,
        );
        const dir = yield* withWorkdir();
        return yield* resolveConnection(
          dir,
          inputFor(explicitRefTarget(ref, { matchesLinkedRef: false })),
          {
            projectHost: "invalid",
            dbConnection: noDirectConnect,
            configEnv: {
              SUPABASE_ACCESS_TOKEN: VALID_TOKEN,
              SUPABASE_DB_PASSWORD: "ambient-password",
            },
          },
        );
      }).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(Cause.pretty(exit.cause)).toContain("DbConfigIpv6Error");
            }
            expect(requests).toEqual([
              { method: "GET", path: `/v1/projects/${ref}/config/database/pooler` },
            ]);
            assertDbConfigDrift(requests, { linked: true, "project-ref": ref });
          }),
        ),
        Effect.scoped,
        Effect.provide(BunServices.layer),
      );
    },
  );

  it.effect("an empty --password still mints a login role", () => {
    const ref = "emptypasswordrefabcd";
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    const session: DbSession = {
      exec: () => Effect.void,
      execBatch: () => Effect.void,
      query: () => Effect.succeed([]),
      extensionExists: () => Effect.succeed(false),
      copyToCsv: () => Effect.succeed(new Uint8Array()),
      queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "SELECT 1" }),
    };
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, (method, path) => {
        if (method === "GET" && path === `/v1/projects/${ref}/config/database/pooler`) {
          return Response.json(primaryPoolerConfigs(ref));
        }
        if (method === "POST" && path === `/v1/projects/${ref}/cli/login-role`) {
          return Response.json(
            { role: "cli_login_role", password: "temporary-role-password", ttl_seconds: 3600 },
            { status: 201 },
          );
        }
        return undefined;
      });
      const dir = yield* withWorkdir();
      const r = yield* resolveConnection(
        dir,
        inputFor(explicitRefTarget(ref, { matchesLinkedRef: false }), {
          password: Option.some(""),
        }),
        {
          projectHost: "invalid",
          dbConnection: Layer.succeed(DbConnection, { connect: () => Effect.succeed(session) }),
          configEnv: {
            SUPABASE_ACCESS_TOKEN: VALID_TOKEN,
            SUPABASE_DB_PASSWORD: "ambient-password",
          },
        },
      );
      expect(r.conn).toMatchObject({
        user: `cli_login_role.${ref}`,
        password: "temporary-role-password",
      });
      expect(requests.map((request) => request.path)).toContain(
        `/v1/projects/${ref}/cli/login-role`,
      );
      assertDbConfigDrift(requests, { linked: true, "project-ref": ref, password: "" });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  for (const forbidden of ["retrieve", "delete"] as const) {
    it.effect(
      `still connects with the login role when the network-ban ${forbidden} is forbidden`,
      () => {
        const ref = "banforbiddenrefabcde";
        const requests: Array<{ readonly method: string; readonly path: string }> = [];
        let connectAttempts = 0;
        const session: DbSession = {
          exec: () => Effect.void,
          execBatch: () => Effect.void,
          query: () => Effect.succeed([]),
          extensionExists: () => Effect.succeed(false),
          copyToCsv: () => Effect.succeed(new Uint8Array()),
          queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "SELECT 1" }),
        };
        const dbConnection = Layer.succeed(DbConnection, {
          connect: () =>
            Effect.suspend(() => {
              connectAttempts += 1;
              return connectAttempts <= 3
                ? Effect.fail(new DbConnectError({ message: "password authentication failed" }))
                : Effect.succeed(session);
            }),
        });
        const forbiddenResponse = () => Response.json({ message: "Forbidden" }, { status: 403 });
        return Effect.gen(function* () {
          yield* stubManagementApi(requests, (method, path) => {
            if (method === "GET" && path === `/v1/projects/${ref}/config/database/pooler`) {
              return Response.json(primaryPoolerConfigs(ref));
            }
            if (method === "POST" && path === `/v1/projects/${ref}/cli/login-role`) {
              return Response.json(
                { role: "cli_login_role", password: "temporary-role-password", ttl_seconds: 3600 },
                { status: 201 },
              );
            }
            if (method === "POST" && path === `/v1/projects/${ref}/network-bans/retrieve`) {
              return forbidden === "retrieve"
                ? forbiddenResponse()
                : Response.json({ banned_ipv4_addresses: ["203.0.113.7"] });
            }
            if (method === "DELETE" && path === `/v1/projects/${ref}/network-bans`) {
              return forbiddenResponse();
            }
            return undefined;
          });
          const retries = yield* Queue.unbounded<string>();
          const debugLogger = Layer.succeed(DebugLogger, {
            debug: (message) =>
              message.startsWith("Retry (") ? Queue.offer(retries, message) : Effect.void,
            http: () => Effect.void,
          });
          const dir = yield* withWorkdir();
          const resolved = yield* resolveConnection(
            dir,
            inputFor(explicitRefTarget(ref, { matchesLinkedRef: false }), {
              networkBanRemoval: yield* approval,
            }),
            {
              projectHost: "invalid",
              dbConnection,
              debugLogger,
              configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
            },
          ).pipe(Effect.forkChild({ startImmediately: true }));
          for (let failedConnects = 1; failedConnects <= 3; failedConnects++) {
            yield* Queue.take(retries).pipe(Effect.raceFirst(Fiber.join(resolved)));
            yield* TestClock.adjust("10 seconds");
          }
          const r = yield* Fiber.join(resolved);
          expect(r.conn).toMatchObject({ user: `cli_login_role.${ref}` });
          expect(connectAttempts).toBe(4);
          expect(requests).toContainEqual(
            forbidden === "retrieve"
              ? { method: "POST", path: `/v1/projects/${ref}/network-bans/retrieve` }
              : { method: "DELETE", path: `/v1/projects/${ref}/network-bans` },
          );
          assertDbConfigDrift(requests, { linked: true, "project-ref": ref });
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
      },
    );
  }
});

describe("dbConfigResolver (container pooler fallback)", () => {
  const ref = "fallbackrefabcdefghi";
  const poolerPath = `/v1/projects/${ref}/config/database/pooler`;
  const loginRolePath = `/v1/projects/${ref}/cli/login-role`;
  const session: DbSession = {
    exec: () => Effect.void,
    execBatch: () => Effect.void,
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "SELECT 1" }),
  };
  const connects = Layer.succeed(DbConnection, { connect: () => Effect.succeed(session) });
  const assertFallbackDrift = (
    requests: ReadonlyArray<{ readonly method: string; readonly path: string }>,
    activeFlags: ActiveFlags,
  ) =>
    assertBlockDrift(dbConfigPoolerFallback, {
      activeFlags,
      requests: requests.map((r) => ({
        method: r.method,
        url: `https://api.supabase.com${r.path}`,
      })),
      exact: true,
    });

  it.effect("fetches the pooler config, then mints a login role when no password is set", () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, (method, path) => {
        if (method === "GET" && path === poolerPath)
          return Response.json(primaryPoolerConfigs(ref));
        if (method === "POST" && path === loginRolePath) {
          return Response.json(
            { role: "cli_login_role", password: "temporary-role-password", ttl_seconds: 3600 },
            { status: 201 },
          );
        }
        return undefined;
      });
      const dir = yield* withWorkdir();
      const pooler = yield* resolvePoolerFallback(dir, inputFor(explicitRefTarget(ref)), {
        dbConnection: connects,
        configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
      });
      expect(Option.isSome(pooler)).toBe(true);
      if (Option.isSome(pooler)) {
        expect(pooler.value).toMatchObject({
          host: "aws-0-us-east-1.pooler.supabase.com",
          user: `cli_login_role.${ref}`,
          password: "temporary-role-password",
        });
      }
      expect(requests).toEqual([
        { method: "GET", path: poolerPath },
        { method: "POST", path: loginRolePath },
      ]);
      assertFallbackDrift(requests, { linked: true });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("fetches the pooler config but mints no login role when a password is set", () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, (method, path) =>
        method === "GET" && path === poolerPath
          ? Response.json(primaryPoolerConfigs(ref))
          : undefined,
      );
      const dir = yield* withWorkdir();
      const pooler = yield* resolvePoolerFallback(
        dir,
        inputFor(explicitRefTarget(ref), { password: Option.some("secret") }),
        { dbConnection: connects, configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN } },
      );
      expect(pooler).toEqual(
        Option.some(expect.objectContaining({ user: `postgres.${ref}`, password: "secret" })),
      );
      expect(requests).toEqual([{ method: "GET", path: poolerPath }]);
      assertFallbackDrift(requests, { linked: true, password: "secret" });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("returns no pooler when the pooler config is forbidden", () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, (method, path) =>
        method === "GET" && path === poolerPath
          ? Response.json({ message: "Forbidden" }, { status: 403 })
          : undefined,
      );
      const dir = yield* withWorkdir();
      const pooler = yield* resolvePoolerFallback(dir, inputFor(explicitRefTarget(ref)), {
        dbConnection: connects,
        configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
      });
      expect(Option.isNone(pooler)).toBe(true);
      expect(requests).toEqual([{ method: "GET", path: poolerPath }]);
      assertFallbackDrift(requests, { linked: true });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect("--local returns no pooler and makes no Management API request", () => {
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      const dir = yield* withWorkdir();
      const pooler = yield* resolvePoolerFallback(dir, inputFor(localTarget));
      expect(Option.isNone(pooler)).toBe(true);
      expect(requests).toEqual([]);
      assertFallbackDrift(requests, { local: true });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });
});

describe("dbConfigResolver.resolveConnection", () => {
  const failureText = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
  const session: DbSession = {
    exec: () => Effect.void,
    execBatch: () => Effect.void,
    query: () => Effect.succeed([]),
    extensionExists: () => Effect.succeed(false),
    copyToCsv: () => Effect.succeed(new Uint8Array()),
    queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "SELECT 1" }),
  };

  it.effect("local target connects to the local stack and announces it", () =>
    Effect.gen(function* () {
      const output = mockOutput();
      const dir = yield* withWorkdir(
        ["[db]", "port = 55555", 'password = "hunter2"', ""].join("\n"),
      );
      const r = yield* resolveConnection(dir, inputFor({ kind: "local" }), { output });
      expect(r.conn).toMatchObject({ host: "127.0.0.1", port: 55555, password: "hunter2" });
      expect(r.isLocal).toBe(true);
      expect(r.target).toEqual({ kind: "local" });
      expect(output.stderrText).toBe("Target: local stack (127.0.0.1:55555)\n");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("db-url target announces the host and never the credentials", () =>
    Effect.gen(function* () {
      const output = mockOutput();
      const dir = yield* withWorkdir();
      const url = Redacted.make("postgres://alice:secret@db.example.com:6543/appdb");
      const r = yield* resolveConnection(dir, inputFor({ kind: "db-url", url }), { output });
      expect(r.conn).toMatchObject({ host: "db.example.com", port: 6543, user: "alice" });
      expect(r.isLocal).toBe(false);
      expect(output.stderrText).toBe("Target: custom Postgres (db.example.com:6543)\n");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.effect("a db-url that fails to parse echoes the url with the password redacted", () =>
    Effect.gen(function* () {
      const dir = yield* withWorkdir();
      const url = Redacted.make("postgres://alice:secret@:notaport/appdb");
      const exit = yield* Effect.exit(resolveConnection(dir, inputFor({ kind: "db-url", url })));
      expect(failureText(exit)).toContain("DbConfigParseUrlError");
      expect(failureText(exit)).not.toContain("secret");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  const directTargets: ReadonlyArray<readonly [string, ResolvedTarget]> = [
    ["local", { kind: "local" }],
    [
      "db-url",
      { kind: "db-url", url: Redacted.make("postgres://u:p@db.example.com:5432/postgres") },
    ],
  ];
  for (const [label, target] of directTargets) {
    it.effect(`rejects --password for a ${label} target before announcing it`, () =>
      Effect.gen(function* () {
        const output = mockOutput();
        const dir = yield* withWorkdir();
        const exit = yield* Effect.exit(
          resolveConnection(dir, inputFor(target, { password: Option.some("pw") }), { output }),
        );
        expect(failureText(exit)).toContain("TargetPasswordConflictError");
        expect(output.stderrText).toBe("");
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );

    it.effect(`accepts an empty --password for a ${label} target`, () =>
      Effect.gen(function* () {
        const dir = yield* withWorkdir();
        yield* resolveConnection(dir, inputFor(target, { password: Option.some("") }));
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
    );
  }

  it.effect("a linked target that matches the linked workdir reuses the saved pooler URL", () => {
    const ref = "savedpoolerrefabcdef";
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* withWorkdir();
      yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "supabase", ".temp", "pooler-url"),
        `postgres://postgres.${ref}:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres`,
      );
      const output = mockOutput();
      const target = linkedTarget(ref);
      const r = yield* resolveConnection(dir, inputFor(target, { password: Option.some("pw") }), {
        projectHost: "invalid",
        output,
      });
      expect(r.conn).toMatchObject({
        host: "aws-0-us-east-1.pooler.supabase.com",
        user: `postgres.${ref}`,
        password: "pw",
      });
      expect(r.ref).toEqual(Option.some(ref));
      expect(r.target).toEqual(target);
      expect(requests).toEqual([]);
      expect(output.stderrText).toBe("");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  it.effect(
    "a linked target with no saved pooler URL fetches the pooler config from the API",
    () => {
      const ref = "bareremoterefabcdefg";
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, (method, path) =>
          method === "GET" && path === `/v1/projects/${ref}/config/database/pooler`
            ? Response.json(primaryPoolerConfigs(ref))
            : undefined,
        );
        const dir = yield* withWorkdir();
        const r = yield* resolveConnection(
          dir,
          inputFor(linkedTarget(ref), { password: Option.some("pw") }),
          { projectHost: "invalid", configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN } },
        );
        expect(r.conn).toMatchObject({
          host: "aws-0-us-east-1.pooler.supabase.com",
          user: `postgres.${ref}`,
          password: "pw",
        });
        expect(requests).toEqual([
          { method: "GET", path: `/v1/projects/${ref}/config/database/pooler` },
        ]);
        assertDbConfigDrift(requests, { remote: true });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
    },
  );

  const unusableTokens: ReadonlyArray<readonly [string, Record<string, string>]> = [
    ["no access token", { SUPABASE_NO_KEYRING: "1" }],
    [
      "a malformed access token",
      { SUPABASE_NO_KEYRING: "1", SUPABASE_ACCESS_TOKEN: "not-a-token" },
    ],
  ];
  for (const [label, configEnv] of unusableTokens) {
    it.effect(
      `a linked target with a password and ${label} keeps the IPv6 error and makes no API request`,
      () => {
        const ref = "tokenlessrefabcdefgh";
        const requests: Array<{ readonly method: string; readonly path: string }> = [];
        return Effect.gen(function* () {
          yield* stubManagementApi(requests, () => undefined);
          const dir = yield* withWorkdir();
          return yield* resolveConnection(
            dir,
            inputFor(linkedTarget(ref), { password: Option.some("pw") }),
            { projectHost: "invalid", configEnv },
          );
        }).pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              expect(error).toMatchObject({
                _tag: "DbConfigIpv6Error",
                remedy: "link",
                suggestion: `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
              });
              expect(requests).toEqual([]);
            }),
          ),
          Effect.scoped,
          Effect.provide(BunServices.layer),
        );
      },
    );
  }

  it.effect("a linked target that is not the linked workdir ignores the saved pooler URL", () => {
    const linkedRef = "abcdefghijklmnopqrst";
    const ref = "otherpoolerrefabcdef";
    const requests: Array<{ readonly method: string; readonly path: string }> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, (method, path) =>
        method === "GET" && path === `/v1/projects/${ref}/config/database/pooler`
          ? Response.json(primaryPoolerConfigs(ref))
          : undefined,
      );
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* withWorkdir();
      yield* fs.makeDirectory(path.join(dir, "supabase", ".temp"), { recursive: true });
      yield* fs.writeFileString(
        path.join(dir, "supabase", ".temp", "pooler-url"),
        `postgres://postgres.${linkedRef}:[YOUR-PASSWORD]@stale.pooler.supabase.com:6543/postgres`,
      );
      const r = yield* resolveConnection(
        dir,
        inputFor(linkedTarget(ref, { source: "flag", matchesLinkedRef: false }), {
          password: Option.some("pw"),
        }),
        { projectHost: "invalid", configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN } },
      );
      expect(r.conn).toMatchObject({
        host: "aws-0-us-east-1.pooler.supabase.com",
        user: `postgres.${ref}`,
      });
      expect(requests).toEqual([
        { method: "GET", path: `/v1/projects/${ref}/config/database/pooler` },
      ]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
  });

  describe("network bans on the temporary login role", () => {
    const ref = "banrecoveryrefabcdef";
    const bannedRequests = (
      requests: Array<{ readonly method: string; readonly path: string }>,
      bans: ReadonlyArray<string>,
    ) =>
      stubManagementApi(requests, (method, path) => {
        if (method === "GET" && path === `/v1/projects/${ref}/config/database/pooler`) {
          return Response.json(primaryPoolerConfigs(ref));
        }
        if (method === "POST" && path === `/v1/projects/${ref}/cli/login-role`) {
          return Response.json(
            { role: "cli_login_role", password: "temporary-role-password", ttl_seconds: 3600 },
            { status: 201 },
          );
        }
        if (method === "POST" && path === `/v1/projects/${ref}/network-bans/retrieve`) {
          return Response.json({ banned_ipv4_addresses: bans });
        }
        if (method === "DELETE" && path === `/v1/projects/${ref}/network-bans`) {
          return Response.json({});
        }
        return undefined;
      });
    const failingConnect = (failures: number) => {
      const attempts = { count: 0 };
      const layer = Layer.succeed(DbConnection, {
        connect: () =>
          Effect.suspend(() => {
            attempts.count += 1;
            return attempts.count <= failures
              ? Effect.fail(new DbConnectError({ message: "password authentication failed" }))
              : Effect.succeed(session);
          }),
      });
      return { attempts, layer };
    };
    const forkResolve = (
      input: DbConnectionInput,
      connection: Layer.Layer<DbConnection>,
      output?: ReturnType<typeof mockOutput>,
    ) =>
      Effect.gen(function* () {
        const retries = yield* Queue.unbounded<string>();
        const debugLogger = Layer.succeed(DebugLogger, {
          debug: (message) =>
            message.startsWith("Retry (") ? Queue.offer(retries, message) : Effect.void,
          http: () => Effect.void,
        });
        const dir = yield* withWorkdir();
        const fiber = yield* resolveConnection(dir, input, {
          projectHost: "invalid",
          dbConnection: connection,
          debugLogger,
          configEnv: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
          output,
        }).pipe(Effect.forkChild({ startImmediately: true }));
        const advance = (retryMessages: number) =>
          Effect.gen(function* () {
            for (let seen = 1; seen <= retryMessages; seen++) {
              yield* Queue.take(retries).pipe(Effect.raceFirst(Fiber.join(fiber)));
              yield* TestClock.adjust("1 minute");
            }
          });
        return { fiber, advance };
      });

    it.effect.each([{ matchesLinkedRef: false }, { matchesLinkedRef: true }])(
      "reports the listed bans and names the project once the retries run out and removes nothing (matchesLinkedRef: $matchesLinkedRef)",
      ({ matchesLinkedRef }) => {
        const requests: Array<{ readonly method: string; readonly path: string }> = [];
        const connection = failingConnect(Number.POSITIVE_INFINITY);
        return Effect.gen(function* () {
          yield* bannedRequests(requests, ["203.0.113.7", "198.51.100.2"]);
          const { fiber, advance } = yield* forkResolve(
            inputFor(linkedTarget(ref, { source: "flag", matchesLinkedRef })),
            connection.layer,
          );
          yield* advance(8);
          const exit = yield* Fiber.await(fiber);
          expect(failureText(exit)).toContain("LinkedDbNetworkBannedError");
          const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
          expect(error).toEqual(
            Option.some(
              expect.objectContaining({
                message: expect.stringContaining("203.0.113.7, 198.51.100.2"),
                suggestion: `Re-run with --yes to remove them, or run supabase network-bans remove --db-unban-ip 203.0.113.7,198.51.100.2 --experimental --yes --remote=${ref}`,
              }),
            ),
          );
          expect(connection.attempts.count).toBe(9);
          expect(requests.some((request) => request.method === "DELETE")).toBe(false);
        }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
      },
    );

    it.effect("connects without removing bans that are not blocking the caller", () => {
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const connection = failingConnect(3);
      return Effect.gen(function* () {
        yield* bannedRequests(requests, ["203.0.113.7"]);
        const { fiber, advance } = yield* forkResolve(
          inputFor(linkedTarget(ref, { source: "flag", matchesLinkedRef: false })),
          connection.layer,
        );
        yield* advance(3);
        const r = yield* Fiber.join(fiber);
        expect(r.conn).toMatchObject({ user: `cli_login_role.${ref}` });
        expect(connection.attempts.count).toBe(4);
        expect(requests.some((request) => request.method === "DELETE")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
    });

    it.effect("keeps retrying without removing anything when no ban is listed", () => {
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const connection = failingConnect(3);
      return Effect.gen(function* () {
        yield* bannedRequests(requests, []);
        const { fiber, advance } = yield* forkResolve(
          inputFor(linkedTarget(ref, { source: "flag", matchesLinkedRef: false })),
          connection.layer,
        );
        yield* advance(3);
        const r = yield* Fiber.join(fiber);
        expect(r.conn).toMatchObject({ user: `cli_login_role.${ref}` });
        expect(connection.attempts.count).toBe(4);
        expect(requests.some((request) => request.method === "DELETE")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
    });

    it.effect("removes the bans and says so once the caller holds a --yes approval", () => {
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const connection = failingConnect(3);
      const output = mockOutput();
      return Effect.gen(function* () {
        yield* bannedRequests(requests, ["203.0.113.7"]);
        const { fiber, advance } = yield* forkResolve(
          inputFor(linkedTarget(ref, { source: "flag", matchesLinkedRef: false }), {
            networkBanRemoval: yield* approval,
          }),
          connection.layer,
          output,
        );
        yield* advance(3);
        const r = yield* Fiber.join(fiber);
        expect(r.conn).toMatchObject({ user: `cli_login_role.${ref}` });
        expect(connection.attempts.count).toBe(4);
        expect(requests).toContainEqual({
          method: "DELETE",
          path: `/v1/projects/${ref}/network-bans`,
        });
        expect(output.stderrText).toContain("Removing network bans (203.0.113.7)...\n");
        assertDbConfigDrift(requests, { linked: true, "project-ref": ref });
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
    });

    it.effect("does not remove bans for an approval obtained by prompting", () => {
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const connection = failingConnect(Number.POSITIVE_INFINITY);
      // The brand is type-only; only the consent module mints tokens in production.
      const promptApproval = Option.some({
        action: "Push",
        via: "prompt",
      } as HostedMutationConsent);
      return Effect.gen(function* () {
        yield* bannedRequests(requests, ["203.0.113.7"]);
        const { fiber, advance } = yield* forkResolve(
          inputFor(linkedTarget(ref, { source: "flag", matchesLinkedRef: false }), {
            networkBanRemoval: promptApproval,
          }),
          connection.layer,
        );
        yield* advance(8);
        const exit = yield* Fiber.await(fiber);
        expect(failureText(exit)).toContain("LinkedDbNetworkBannedError");
        expect(requests.some((request) => request.method === "DELETE")).toBe(false);
      }).pipe(Effect.scoped, Effect.provide(BunServices.layer));
    });
  });
});
