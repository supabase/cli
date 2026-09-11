import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option, Redacted, Stream } from "effect";
import { CAPABILITY_NAMES, StackIdSchema, type EffectStack } from "@supabase/stack/effect";

import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "../../tests/helpers/mocks.ts";
import { VALID_TOKEN, mockCommandSettings } from "../../tests/helpers/command-mocks.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
} from "./global-flags.ts";
import { DebugLogger } from "./debug-logger.service.ts";
import { identityStitchLayer } from "./identity-stitch.ts";
import { dbConfigLayer, dbConfigResolverLayer } from "./db-config.layer.ts";
import { DbConfigResolver } from "./db-config.service.ts";
import type { DbConfigFlags } from "./db-config.types.ts";
import { DbConnection, type DbSession, type PgConnInput } from "./db-connection.service.ts";
import { stackBackendLayer } from "../commands/experimental/stack/stack-backend.ts";
import { StackApi } from "../commands/experimental/stack/stack.shared.ts";

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

function buildResolver(
  workdir: string,
  opts: {
    readonly projectHost?: string;
    readonly poolerHost?: string;
    readonly dbConnection?: Layer.Layer<DbConnection>;
    readonly stackApi?: Layer.Layer<StackApi>;
    readonly stackBackend?: "legacy" | "stack";
  } = {},
) {
  const deps = Layer.mergeAll(
    mockCommandSettings({
      workdir,
      projectHost: opts.projectHost ?? "supabase.co",
      poolerHost: opts.poolerHost,
      projectId: Option.none(),
    }),
    opts.dbConnection ?? mockDbConnection,
    mockDebugLogger,
    mockOutput().layer,
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
  );
  const resolver =
    opts.stackApi !== undefined
      ? dbConfigResolverLayer.pipe(Layer.provide(opts.stackApi), Layer.provide(deps))
      : dbConfigLayer.pipe(Layer.provide(deps));
  return Layer.mergeAll(
    resolver,
    opts.stackBackend !== undefined ? stackBackendLayer(opts.stackBackend) : Layer.empty,
  );
}

function withWorkdir(toml?: string) {
  const dir = mkdtempSync(join(tmpdir(), "db-config-"));
  if (toml !== undefined) {
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(join(dir, "supabase", "config.toml"), toml);
  }
  return dir;
}

const resolve = (
  workdir: string,
  flags: DbConfigFlags,
  opts?: Parameters<typeof buildResolver>[1],
) =>
  Effect.gen(function* () {
    const resolver = yield* DbConfigResolver;
    return yield* resolver.resolve(flags);
  }).pipe(Effect.provide(buildResolver(workdir, opts)));

const resolvePoolerFallback = (
  workdir: string,
  flags: DbConfigFlags,
  opts?: Parameters<typeof buildResolver>[1],
) =>
  Effect.gen(function* () {
    const resolver = yield* DbConfigResolver;
    return yield* resolver.resolvePoolerFallback(flags);
  }).pipe(Effect.provide(buildResolver(workdir, opts)));

const localFlags: DbConfigFlags = {
  dbUrl: Option.none(),
  connType: "local",
  dnsResolver: "native",
};
const dbUrlFlags = (url: string): DbConfigFlags => ({
  dbUrl: Option.some(url),
  connType: "db-url",
  dnsResolver: "native",
});
const linkedFlags: DbConfigFlags = {
  dbUrl: Option.none(),
  connType: "linked",
  dnsResolver: "native",
};

describe("dbConfigResolver (local + db-url)", () => {
  // The resolver derives the local host from `getHostname()`, which reads
  // SUPABASE_SERVICES_HOSTNAME and DOCKER_HOST. Clear both so the local-host
  // assertions are deterministic regardless of the runner's Docker config.
  let savedServicesHostname: string | undefined;
  let savedDockerHost: string | undefined;
  beforeEach(() => {
    savedServicesHostname = process.env["SUPABASE_SERVICES_HOSTNAME"];
    savedDockerHost = process.env["DOCKER_HOST"];
    delete process.env["SUPABASE_SERVICES_HOSTNAME"];
    delete process.env["DOCKER_HOST"];
  });
  afterEach(() => {
    if (savedServicesHostname === undefined) delete process.env["SUPABASE_SERVICES_HOSTNAME"];
    else process.env["SUPABASE_SERVICES_HOSTNAME"] = savedServicesHostname;
    if (savedDockerHost === undefined) delete process.env["DOCKER_HOST"];
    else process.env["DOCKER_HOST"] = savedDockerHost;
  });

  it.effect("local mode: uses 127.0.0.1 with config.toml db.port/password and is local", () => {
    const dir = withWorkdir(["[db]", "port = 55555", 'password = "hunter2"', ""].join("\n"));
    return resolve(dir, localFlags).pipe(
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
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("local mode: uses the stack credentials URL when the stack backend is on", () => {
    const dir = withWorkdir(["[db]", "port = 55555", 'password = "hunter2"', ""].join("\n"));
    const unused = () => Effect.die("unused");
    const unusedEffect = Effect.die("unused");
    const stackId = StackIdSchema.make("a".repeat(64));
    const stack: EffectStack = {
      id: stackId,
      status: Effect.succeed({
        id: stackId,
        lifecycle: "running",
        desiredLifecycle: "running",
        runtime: { kind: "native" },
        endpoints: {},
        versions: {},
        capabilities: CAPABILITY_NAMES.map((name) => ({
          name,
          activation: name === "database" ? "eager" : "lazy",
          state: name === "database" ? "ready" : "dormant",
        })),
        artifacts: [],
      }),
      credentials: Effect.succeed({
        database: {
          url: Redacted.make("postgresql://postgres:stack-secret@127.0.0.1:54329/postgres"),
          password: Redacted.make("stack-secret"),
        },
        api: {
          publishableKey: "anon",
          secretKey: Redacted.make("service"),
          anonJwt: "anon",
          serviceRoleJwt: Redacted.make("service"),
        },
      }),
      prepare: unused,
      start: unused,
      stop: unusedEffect,
      destroy: unusedEffect,
      resetDatabase: unusedEffect,
      logs: unused,
      followLogs: () => Stream.empty,
    };
    const stackApi = Layer.succeed(StackApi, {
      createStack: unused,
      findStack: () =>
        Effect.succeed(
          Option.some({
            id: stackId,
            projectRoot: dir,
            name: "default",
            branchContext: "main",
            runtime: { kind: "native" },
            desiredLifecycle: "running",
          }),
        ),
      discoverStacks: unused,
      openStack: () => Effect.succeed(stack),
      inspectStack: unused,
    });
    return resolve(dir, localFlags, { stackBackend: "stack", stackApi }).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.host).toBe("127.0.0.1");
          expect(r.conn.port).toBe(54329);
          expect(r.conn.password).toBe("stack-secret");
          expect(r.isLocal).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("local mode: honors SUPABASE_SERVICES_HOSTNAME for the connection host", () => {
    process.env["SUPABASE_SERVICES_HOSTNAME"] = "host.docker.internal";
    const dir = withWorkdir();
    return resolve(dir, localFlags).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.host).toBe("host.docker.internal");
          expect(r.isLocal).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("local mode: falls back to default port/password without a config.toml", () => {
    const dir = withWorkdir();
    return resolve(dir, localFlags).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.port).toBe(54322);
          expect(r.conn.password).toBe("postgres");
          expect(r.isLocal).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("db-url mode: parses the connection string and percent-decodes the password", () => {
    const dir = withWorkdir();
    return resolve(dir, dbUrlFlags("postgres://alice:p%40ss@example.com:6543/appdb")).pipe(
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
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("db-url mode: a 127.0.0.1 url on the configured db.port is detected as local", () => {
    const dir = withWorkdir();
    return resolve(dir, dbUrlFlags("postgres://postgres:postgres@127.0.0.1:54322/postgres")).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.isLocal).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("db-url mode: a passwordless local url fills the password from config", () => {
    const dir = withWorkdir(["[db]", "port = 54322", 'password = "hunter2"', ""].join("\n"));
    return resolve(dir, dbUrlFlags("postgres://postgres@127.0.0.1:54322/postgres")).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.isLocal).toBe(true);
          expect(r.conn.password).toBe("hunter2");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "db-url mode: an invalid url fails with a parse error that redacts the password",
    () => {
      const dir = withWorkdir();
      return resolve(dir, dbUrlFlags("postgres://user:s3cret@ bad host/db")).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const json = JSON.stringify(exit.cause);
              expect(json).toContain("DbConfigParseUrlError");
              expect(json).toContain("[REDACTED]");
              expect(json).not.toContain("s3cret");
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("db-url mode: preserves sslmode and the libpq options runtime param", () => {
    const dir = withWorkdir();
    const url =
      "postgres://postgres:pw@example.com:5432/postgres?sslmode=verify-full&options=reference%3Dabcdefghijklmnop";
    return resolve(dir, dbUrlFlags(url)).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.sslmode).toBe("verify-full");
          expect(r.conn.options).toBe("reference=abcdefghijklmnop");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("db-url mode: accepts a libpq keyword/value DSN", () => {
    const dir = withWorkdir();
    return resolve(dir, dbUrlFlags("host=pg.example.com port=6543 user=admin dbname=app")).pipe(
      Effect.tap((r) =>
        Effect.sync(() => {
          expect(r.conn.host).toBe("pg.example.com");
          expect(r.conn.port).toBe(6543);
          expect(r.conn.user).toBe("admin");
          expect(r.conn.database).toBe("app");
          expect(r.isLocal).toBe(false);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "db-url mode: a malformed percent escape is a redacted parse error, not a defect",
    () => {
      const dir = withWorkdir();
      // `p%zz` is an invalid escape: `new URL` accepts it but `decodeURIComponent`
      // throws. It must surface as a normal parse failure, not an untyped defect.
      return resolve(dir, dbUrlFlags("postgres://user:p%zz@example.com/db")).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const json = JSON.stringify(exit.cause);
              expect(json).toContain("DbConfigParseUrlError");
              expect(json).toContain("[REDACTED]");
              expect(json).not.toContain("p%zz");
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});

describe("dbConfigResolver (linked config ordering)", () => {
  it.effect(
    "validates the ref-merged config before any network work (Go ParseDatabaseConfig order)",
    () => {
      // The ref is sourced from the config's top-level project_id; the matching remote block
      // sets an unsupported major_version. If validation happened after the connection work,
      // `mockDbConnection.connect()` would die first.
      const ref = "abcdefghijklmnopqrst";
      const dir = withWorkdir(
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
      // The linked ref is sourced via the project-ref resolver's env fallback.
      process.env["SUPABASE_PROJECT_ID"] = ref;
      return resolve(dir, linkedFlags).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              expect(JSON.stringify(exit.cause)).toContain(
                "Failed reading config: Invalid db.major_version: 99.",
              );
            }
            delete process.env["SUPABASE_PROJECT_ID"];
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("surfaces a project-ref read failure instead of reporting not-linked", () => {
    // The ref file is seeded as a directory (not a file), with no project_id or env fallback,
    // to force a real read error.
    const dir = withWorkdir();
    mkdirSync(join(dir, "supabase", ".temp", "project-ref"), { recursive: true });
    return resolve(dir, linkedFlags).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const json = JSON.stringify(exit.cause);
            expect(json).toContain("failed to load project ref");
            expect(json).not.toContain("Cannot find project ref");
          }
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("ad-hoc project refs ignore the linked workdir password and saved pooler URL", () => {
    const linkedRef = "abcdefghijklmnopqrst";
    const adHocRef = "qrstabcdefghijklmnop";
    const dir = withWorkdir(
      [`project_id = "${linkedRef}"`, "[db]", "major_version = 15", ""].join("\n"),
    );
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".temp", "project-ref"), linkedRef);
    writeFileSync(
      join(dir, "supabase", ".temp", "pooler-url"),
      `postgres://postgres.${linkedRef}:saved-workdir-password@stale.pooler.supabase.com:6543/postgres`,
    );

    const previousAccessToken = process.env["SUPABASE_ACCESS_TOKEN"];
    const previousPassword = process.env["SUPABASE_DB_PASSWORD"];
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
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        requests.push({ method, path: url.pathname });

        if (
          method === "GET" &&
          url.pathname === `/v1/projects/${adHocRef}/config/database/pooler`
        ) {
          return new Response(
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
          );
        }

        if (method === "POST" && url.pathname === `/v1/projects/${adHocRef}/cli/login-role`) {
          return new Response(
            JSON.stringify({
              role: "cli_login_role",
              password: "temporary-role-password",
              ttl_seconds: 3600,
            }),
            { status: 201, headers: { "content-type": "application/json" } },
          );
        }

        return new Response(JSON.stringify({ message: "unexpected request" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: previousFetch.preconnect },
    );

    process.env["SUPABASE_ACCESS_TOKEN"] = VALID_TOKEN;
    process.env["SUPABASE_DB_PASSWORD"] = "ambient-linked-password";
    globalThis.fetch = fetchMock;

    return resolve(
      dir,
      {
        ...linkedFlags,
        linkedProjectRef: Option.some(adHocRef),
        adHocProjectRef: true,
      },
      { projectHost: "invalid", dbConnection },
    ).pipe(
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
          if (previousAccessToken === undefined) delete process.env["SUPABASE_ACCESS_TOKEN"];
          else process.env["SUPABASE_ACCESS_TOKEN"] = previousAccessToken;
          if (previousPassword === undefined) delete process.env["SUPABASE_DB_PASSWORD"];
          else process.env["SUPABASE_DB_PASSWORD"] = previousPassword;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect(
    "ad-hoc pooler fallback ignores the linked workdir password and saved pooler URL",
    () => {
      const linkedRef = "abcdefghijklmnopqrst";
      const adHocRef = "qrstabcdefghijklmnop";
      const dir = withWorkdir(
        [`project_id = "${linkedRef}"`, "[db]", "major_version = 15", ""].join("\n"),
      );
      mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
      writeFileSync(join(dir, "supabase", ".temp", "project-ref"), linkedRef);
      writeFileSync(
        join(dir, "supabase", ".temp", "pooler-url"),
        `postgres://postgres.${linkedRef}:saved-workdir-password@stale.pooler.supabase.com:6543/postgres`,
      );

      const previousAccessToken = process.env["SUPABASE_ACCESS_TOKEN"];
      const previousPassword = process.env["SUPABASE_DB_PASSWORD"];
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
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          requests.push({ method, path: url.pathname });

          if (
            method === "GET" &&
            url.pathname === `/v1/projects/${adHocRef}/config/database/pooler`
          ) {
            return new Response(
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
            );
          }

          if (method === "POST" && url.pathname === `/v1/projects/${adHocRef}/cli/login-role`) {
            return new Response(
              JSON.stringify({
                role: "cli_login_role",
                password: "temporary-role-password",
                ttl_seconds: 3600,
              }),
              { status: 201, headers: { "content-type": "application/json" } },
            );
          }

          return new Response(JSON.stringify({ message: "unexpected request" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        },
        { preconnect: previousFetch.preconnect },
      );

      process.env["SUPABASE_ACCESS_TOKEN"] = VALID_TOKEN;
      process.env["SUPABASE_DB_PASSWORD"] = "ambient-linked-password";
      globalThis.fetch = fetchMock;

      return resolvePoolerFallback(
        dir,
        {
          ...linkedFlags,
          linkedProjectRef: Option.some(adHocRef),
          adHocProjectRef: true,
        },
        { dbConnection },
      ).pipe(
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
            if (previousAccessToken === undefined) delete process.env["SUPABASE_ACCESS_TOKEN"];
            else process.env["SUPABASE_ACCESS_TOKEN"] = previousAccessToken;
            if (previousPassword === undefined) delete process.env["SUPABASE_DB_PASSWORD"];
            else process.env["SUPABASE_DB_PASSWORD"] = previousPassword;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect("linked pooler fallback fetches API config when the saved pooler URL is stale", () => {
    const linkedRef = "abcdefghijklmnopqrst";
    const dir = withWorkdir(
      [`project_id = "${linkedRef}"`, "[db]", "major_version = 15", ""].join("\n"),
    );
    mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(dir, "supabase", ".temp", "project-ref"), linkedRef);
    writeFileSync(
      join(dir, "supabase", ".temp", "pooler-url"),
      "postgres://postgres.qrstabcdefghijklmnop:saved-workdir-password@aws-0-us-east-1.pooler.supabase.com:6543/postgres",
    );

    const previousAccessToken = process.env["SUPABASE_ACCESS_TOKEN"];
    const previousPassword = process.env["SUPABASE_DB_PASSWORD"];
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
      async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        const method = init?.method ?? (input instanceof Request ? input.method : "GET");
        requests.push({ method, path: url.pathname });

        if (
          method === "GET" &&
          url.pathname === `/v1/projects/${linkedRef}/config/database/pooler`
        ) {
          return new Response(
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
          );
        }

        return new Response(JSON.stringify({ message: "unexpected request" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: previousFetch.preconnect },
    );

    process.env["SUPABASE_ACCESS_TOKEN"] = VALID_TOKEN;
    process.env["SUPABASE_DB_PASSWORD"] = "linked-password";
    globalThis.fetch = fetchMock;

    return resolvePoolerFallback(
      dir,
      {
        ...linkedFlags,
        linkedProjectRef: Option.some(linkedRef),
      },
      { projectHost: "supabase.co", dbConnection },
    ).pipe(
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
          if (previousAccessToken === undefined) delete process.env["SUPABASE_ACCESS_TOKEN"];
          else process.env["SUPABASE_ACCESS_TOKEN"] = previousAccessToken;
          if (previousPassword === undefined) delete process.env["SUPABASE_DB_PASSWORD"];
          else process.env["SUPABASE_DB_PASSWORD"] = previousPassword;
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });
});

// An explicit `--project-ref`/`linkedProjectRef` on a non-ad-hoc `db` command must
// independently unlock the Management API pooler fetch on an IPv4-only network — it must not
// stay confined to the workdir's saved `.temp/pooler-url` the way the plain `--linked` default
// path is.
describe("dbConfigResolver (--project-ref pooler fetch decoupled from adHocProjectRef)", () => {
  it.effect(
    "an unlinked workdir + explicit --project-ref resolves via the API pooler config, honoring the ambient password with no login-role mint",
    () => {
      const ref = "targetprojectrefabcd";
      // Fully unlinked: `withWorkdir()` creates no `supabase/` directory at all,
      // so there is no `.temp/project-ref` and no `.temp/pooler-url` to reuse.
      const dir = withWorkdir();

      const previousAccessToken = process.env["SUPABASE_ACCESS_TOKEN"];
      const previousPassword = process.env["SUPABASE_DB_PASSWORD"];
      const previousFetch = globalThis.fetch;
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const dbConnection = Layer.succeed(DbConnection, {
        connect: () =>
          Effect.die("unexpected connect() — the ambient password path never verify-connects"),
      });
      const fetchMock = Object.assign(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          requests.push({ method, path: url.pathname });

          if (method === "GET" && url.pathname === `/v1/projects/${ref}/config/database/pooler`) {
            return new Response(
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
            );
          }

          return new Response(JSON.stringify({ message: "unexpected request" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        },
        { preconnect: previousFetch.preconnect },
      );

      process.env["SUPABASE_ACCESS_TOKEN"] = VALID_TOKEN;
      process.env["SUPABASE_DB_PASSWORD"] = "ambient-password";
      globalThis.fetch = fetchMock;

      return resolve(
        dir,
        {
          ...linkedFlags,
          linkedProjectRef: Option.some(ref),
        },
        { projectHost: "invalid", dbConnection },
      ).pipe(
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
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = previousFetch;
            if (previousAccessToken === undefined) delete process.env["SUPABASE_ACCESS_TOKEN"];
            else process.env["SUPABASE_ACCESS_TOKEN"] = previousAccessToken;
            if (previousPassword === undefined) delete process.env["SUPABASE_DB_PASSWORD"];
            else process.env["SUPABASE_DB_PASSWORD"] = previousPassword;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "a saved pooler URL for a DIFFERENT project than --project-ref is rejected and the target ref's pooler is fetched",
    () => {
      const linkedRef = "workdirlinkedrefabcd";
      const targetRef = "targetprojectrefabcd";
      const dir = withWorkdir(
        [`project_id = "${linkedRef}"`, "[db]", "major_version = 15", ""].join("\n"),
      );
      mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
      writeFileSync(join(dir, "supabase", ".temp", "project-ref"), linkedRef);
      writeFileSync(
        join(dir, "supabase", ".temp", "pooler-url"),
        `postgres://postgres.${linkedRef}:saved-workdir-password@stale.pooler.supabase.com:6543/postgres`,
      );

      const previousAccessToken = process.env["SUPABASE_ACCESS_TOKEN"];
      const previousPassword = process.env["SUPABASE_DB_PASSWORD"];
      const previousFetch = globalThis.fetch;
      const requests: Array<{ readonly method: string; readonly path: string }> = [];
      const dbConnection = Layer.succeed(DbConnection, {
        connect: () =>
          Effect.die("unexpected connect() — the ambient password path never verify-connects"),
      });
      const fetchMock = Object.assign(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = new URL(
            typeof input === "string" || input instanceof URL ? input : input.url,
          );
          const method = init?.method ?? (input instanceof Request ? input.method : "GET");
          requests.push({ method, path: url.pathname });

          if (
            method === "GET" &&
            url.pathname === `/v1/projects/${targetRef}/config/database/pooler`
          ) {
            return new Response(
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
            );
          }

          return new Response(JSON.stringify({ message: "unexpected request" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          });
        },
        { preconnect: previousFetch.preconnect },
      );

      process.env["SUPABASE_ACCESS_TOKEN"] = VALID_TOKEN;
      process.env["SUPABASE_DB_PASSWORD"] = "ambient-password";
      globalThis.fetch = fetchMock;

      return resolve(
        dir,
        {
          ...linkedFlags,
          linkedProjectRef: Option.some(targetRef),
        },
        { projectHost: "invalid", dbConnection },
      ).pipe(
        Effect.tap((r) =>
          Effect.sync(() => {
            expect(r.conn).toEqual({
              host: "aws-0-us-east-1.pooler.supabase.com",
              port: 5432,
              user: `postgres.${targetRef}`,
              password: "ambient-password",
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
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            globalThis.fetch = previousFetch;
            if (previousAccessToken === undefined) delete process.env["SUPABASE_ACCESS_TOKEN"];
            else process.env["SUPABASE_ACCESS_TOKEN"] = previousAccessToken;
            if (previousPassword === undefined) delete process.env["SUPABASE_DB_PASSWORD"];
            else process.env["SUPABASE_DB_PASSWORD"] = previousPassword;
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );

  it.effect(
    "the plain --linked path (no --project-ref) keeps the IPv6 error when no pooler URL is saved",
    () => {
      const ref = "plainlinkedrefabcdef";
      const dir = withWorkdir(
        [`project_id = "${ref}"`, "[db]", "major_version = 15", ""].join("\n"),
      );
      mkdirSync(join(dir, "supabase", ".temp"), { recursive: true });
      writeFileSync(join(dir, "supabase", ".temp", "project-ref"), ref);

      return resolve(dir, linkedFlags, { projectHost: "invalid" }).pipe(
        Effect.exit,
        Effect.tap((exit) =>
          Effect.sync(() => {
            expect(Exit.isFailure(exit)).toBe(true);
            if (Exit.isFailure(exit)) {
              const json = JSON.stringify(exit.cause);
              expect(json).toContain("DbConfigIpv6Error");
              expect(json).toContain(
                `Run supabase link --project-ref ${ref} to setup IPv4 connection.`,
              );
            }
            rmSync(dir, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});
