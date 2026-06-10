import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";

import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockTelemetryRuntime,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import { mockLegacyCliConfig } from "../../../tests/helpers/legacy-mocks.ts";
import {
  LegacyDebugFlag,
  LegacyOutputFlag,
  LegacyProfileFlag,
  LegacyWorkdirFlag,
} from "../../shared/legacy/global-flags.ts";
import { LegacyDebugLogger } from "./legacy-debug-logger.service.ts";
import { legacyDbConfigLayer } from "./legacy-db-config.layer.ts";
import { LegacyDbConfigResolver } from "./legacy-db-config.service.ts";
import type { LegacyDbConfigFlags } from "./legacy-db-config.types.ts";
import { LegacyDbConnection } from "./legacy-db-connection.service.ts";

// `--local` / `--db-url` never touch the Management API stack, so the resolver
// builds with simple ambient stubs. The `--linked` sub-flow (login-role,
// pooler, unban, backoff) requires the real management runtime with a mocked
// HTTP transport and is covered separately by the cli-e2e parity harness.
const mockDebugLogger = Layer.succeed(LegacyDebugLogger, {
  debug: () => Effect.void,
  http: () => Effect.void,
});

const mockDbConnection = Layer.succeed(LegacyDbConnection, {
  connect: () => Effect.die("unexpected connect() in --local/--db-url resolver test"),
});

function buildResolver(workdir: string) {
  const deps = Layer.mergeAll(
    mockLegacyCliConfig({ workdir, projectHost: "supabase.co", projectId: Option.none() }),
    mockDbConnection,
    mockDebugLogger,
    mockOutput().layer,
    mockAnalytics().layer,
    mockTelemetryRuntime(),
    mockTty(),
    mockRuntimeInfo(),
    Layer.succeed(LegacyProfileFlag, "supabase"),
    Layer.succeed(LegacyWorkdirFlag, Option.some(workdir)),
    Layer.succeed(LegacyOutputFlag, Option.none()),
    Layer.succeed(LegacyDebugFlag, false),
    BunServices.layer,
  );
  return legacyDbConfigLayer.pipe(Layer.provide(deps));
}

function withWorkdir(toml?: string) {
  const dir = mkdtempSync(join(tmpdir(), "legacy-db-config-"));
  if (toml !== undefined) {
    mkdirSync(join(dir, "supabase"), { recursive: true });
    writeFileSync(join(dir, "supabase", "config.toml"), toml);
  }
  return dir;
}

const resolve = (workdir: string, flags: LegacyDbConfigFlags) =>
  Effect.gen(function* () {
    const resolver = yield* LegacyDbConfigResolver;
    return yield* resolver.resolve(flags);
  }).pipe(Effect.provide(buildResolver(workdir)));

const localFlags: LegacyDbConfigFlags = {
  dbUrl: Option.none(),
  linked: false,
  local: true,
  dnsResolver: "native",
};
const dbUrlFlags = (url: string): LegacyDbConfigFlags => ({
  dbUrl: Option.some(url),
  linked: false,
  local: false,
  dnsResolver: "native",
});

describe("legacyDbConfigResolver (local + db-url)", () => {
  // The resolver derives the local host from `legacyGetHostname()`, which reads
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
          });
          expect(r.isLocal).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.effect("local mode: honors SUPABASE_SERVICES_HOSTNAME for the connection host", () => {
    // Dev-container / remote-Docker parity (Go's utils.Config.Hostname).
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
    // Go's ConnectLocalPostgres fills an empty password from `[db].password`
    // for local connections, so a passwordless local DSN still authenticates.
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
              expect(json).toContain("LegacyDbConfigParseUrlError");
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
          // Go's `pgconn.ParseConfig` keeps both in `pgconn.Config`; the URL
          // parser must not discard the query string.
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
          // Go's `pgconn.ParseConfig` accepts keyword/value DSNs, not just URLs.
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
              expect(json).toContain("LegacyDbConfigParseUrlError");
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
