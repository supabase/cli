import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Option, Path } from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput } from "../../../../tests/helpers/mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  asRecordedRequests,
  provideEnv,
  realDbConfigResolver,
  realLinkedProjectCache,
  recordingProjectHttpClient,
  serveLinkedDatabase,
  stubManagementApi,
  type StubbedRequest,
} from "../../../../tests/helpers/permission-real-layers.ts";
import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { MigrationsReadError } from "../../../command-internal/migration.errors.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import {
  TargetPasswordConflictError,
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
import { migrationList } from "./list.handler.ts";
import type { MigrationListFlags } from "./list.command.ts";

const LIST_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

interface SetupOpts {
  readonly format?: OutputFormat;
  readonly isLocal?: boolean;
  readonly remote?: ReadonlyArray<string>;
  readonly remoteError?: DbExecError;
  /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
  readonly realLayers?: boolean;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  const resolverCalls: Array<DbConnectionInput> = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) => {
      resolverCalls.push(input);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? input.target.kind === "local",
        ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
        target: input.target,
      } satisfies ResolvedDbConnection);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(DbConnection, {
    connect: () =>
      Effect.succeed({
        exec: () => Effect.void,
        execBatch: () => Effect.void,
        query: (sql: string) =>
          Effect.suspend(() => {
            if (sql === LIST_SQL) {
              if (opts.remoteError !== undefined) return Effect.fail(opts.remoteError);
              return Effect.succeed((opts.remote ?? []).map((version) => ({ version })));
            }
            return Effect.succeed([]);
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
      }),
  });

  // Gives an explicit --project-ref flag precedence over the VALID_REF fallback, so a
  // test can prove the flag drives the linked ref.
  const projectRef = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      Effect.succeed({
        ref: Option.getOrElse(flagValue, () => VALID_REF),
        source: Option.isSome(flagValue) ? "flag" : "file",
        matchesLinkedRef: Option.isNone(flagValue),
      }),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });

  const http = recordingProjectHttpClient(VALID_REF);
  const layer = Layer.mergeAll(
    cliConfigValuesTestLayer,
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    Layer.succeed(YesFlag, false),
    out.layer,
    telemetry.layer,
    opts.realLayers === true
      ? realLinkedProjectCache({
          httpClient: http.layer,
          cliSettings: mockCommandSettings({ workdir }),
        })
      : cache.layer,
    opts.realLayers === true
      ? realDbConfigResolver({
          workdir,
          dbConnection: connection,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        })
      : resolver,
    connection,
    projectRef,
    mockCommandSettings({ workdir }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: [] }),
    BunServices.layer,
  );
  return {
    layer,
    out,
    telemetry,
    cache,
    http,
    resolverCalls,
  };
}

const flags = (over: Partial<MigrationListFlags> = {}): MigrationListFlags => ({
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
  password: over.password ?? Option.none(),
});

const seedMigrations = Effect.fnUntraced(function* (workdir: string, names: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(workdir, "supabase", "migrations");
  yield* fs.makeDirectory(dir, { recursive: true });
  for (const name of names) yield* fs.writeFileString(path.join(dir, name), "select 1;\n");
});

const writeConfig = Effect.fnUntraced(function* (workdir: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(workdir, "supabase"), { recursive: true });
  yield* fs.writeFileString(path.join(workdir, "supabase", "config.toml"), body);
});

const tmp = useTempWorkdir();

describe("migration list", () => {
  it.effect("lists merged local + remote migrations for the local database by default", () => {
    const ctx = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql", "20240103000000_c.sql"]);
      yield* migrationList(flags());
      const stdout = stripAnsi(ctx.out.stdoutText);
      expect(stdout).toContain("Local DB");
      expect(stdout).not.toContain("Remote");
      expect(stdout).toContain("Time (UTC)");
      expect(stdout).toContain("`20240101000000`");
      expect(stdout).toContain("`20240102000000`");
      expect(stdout).toContain("`20240103000000`");
      expect(ctx.resolverCalls[0]?.target).toEqual({ kind: "local" });
      expect(ctx.cache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect(
    "lists the linked project and fills the cache when the workspace target is remote",
    () => {
      const ctx = setup(tmp.current, { remote: ["20240101000000"] });
      return Effect.gen(function* () {
        yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
        yield* writeConfig(tmp.current, 'target = "remote"\n');
        yield* migrationList(flags());
        expect(ctx.resolverCalls[0]?.target).toMatchObject({ kind: "linked", ref: VALID_REF });
        expect(ctx.cache.cachedRef).toBe(VALID_REF);
        const stdout = stripAnsi(ctx.out.stdoutText);
        expect(stdout).toContain("Remote");
        expect(stdout).not.toContain("Local DB");
      }).pipe(Effect.provide(ctx.layer));
    },
  );

  it.effect("shows an empty Remote column when the history table is absent (42P01)", () => {
    const { layer, out } = setup(tmp.current, {
      remoteError: new DbExecError({
        message: 'relation "supabase_migrations.schema_migrations" does not exist',
        code: "42P01",
      }),
    });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
      yield* migrationList(flags());
      const stdout = stripAnsi(out.stdoutText);
      expect(stdout).toContain("`20240101000000`");
      expect(stdout).toContain("` `"); // empty Remote cell
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips init-schema and non-migration files when loading local versions", () => {
    const { layer, out } = setup(tmp.current, { remote: [] });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, [
        "20211208000000_init.sql", // pre-cutoff init → skipped
        "not-a-migration.txt", // non-matching → skipped
        "20240105000000_keep.sql",
      ]);
      yield* migrationList(flags());
      const stdout = stripAnsi(out.stdoutText);
      expect(stdout).toContain("`20240105000000`");
      expect(stdout).not.toContain("20211208000000");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lists the project given via --project-ref, which implies --linked", () => {
    // VALID_REF is the fake resolver's fallback; the flag must win over it and drive
    // the cached ref.
    const FLAG_REF = "flagflagflagflagflag";
    const ctx = setup(tmp.current, { remote: ["20240101000000"] });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
      yield* migrationList(flags({ projectRef: Option.some(FLAG_REF) }));
      expect(ctx.cache.cachedRef).toBe(FLAG_REF);
      expect(ctx.cache.cachedRef).not.toBe(VALID_REF);
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect("rejects --project-ref combined with --local before connecting", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const ctx = setup(tmp.current, { remote: [] });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
      const error = yield* migrationList(
        flags({ local: true, projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetProjectRefConflictError);
      expect(ctx.resolverCalls).toEqual([]);
      expect(ctx.cache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect("targets the local database with --local and skips the linked cache", () => {
    const ctx = setup(tmp.current, { remote: [] });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
      yield* migrationList(flags({ local: true }));
      expect(ctx.resolverCalls[0]?.target).toEqual({ kind: "local" });
      expect(ctx.cache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect("rejects --db-url combined with --linked", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* migrationList(
        flags({ dbUrl: Option.some("postgresql://x"), linked: true }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetSelectorConflictError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits structured migrations in json", () => {
    const { layer, out } = setup(tmp.current, { format: "json", remote: ["20240102000000"] });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240103000000_c.sql"]);
      yield* migrationList(flags());
      expect(out.stdoutText).toBe(""); // no glamour table on stdout in json mode
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migrations listed",
          data: {
            migrations: [
              { local: "", remote: "20240102000000", time: "2024-01-02 00:00:00" },
              { local: "20240103000000", remote: "", time: "2024-01-03 00:00:00" },
            ],
          },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("propagates a non-undefined-table remote read failure", () => {
    const { layer } = setup(tmp.current, {
      remoteError: new DbExecError({
        message: "permission denied for schema",
        code: "42501",
      }),
    });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
      const error = yield* migrationList(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationsReadError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const ctx = setup(tmp.current, {
      realLayers: true,
      remote: ["20240101000000"],
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
      yield* migrationList(flags({ projectRef: Option.some(VALID_REF) }));
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(ctx.http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "migration list",
        activeFlags: { "project-ref": VALID_REF },
        requests: [...asRecordedRequests(requests), ...ctx.http.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("makes no Management API request for --local through the real resolver", () => {
    const ctx = setup(tmp.current, {
      isLocal: true,
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* migrationList(flags({ local: true }));
      expect(requests).toEqual([]);
      expect(ctx.http.calls).toEqual([]);
      assertPermissionDrift({
        command: "migration list",
        activeFlags: { local: true },
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("rejects --password combined with --db-url through the real resolver", () => {
    const ctx = setup(tmp.current, { realLayers: true });
    return Effect.gen(function* () {
      const error = yield* migrationList(
        flags({ dbUrl: Option.some("postgresql://x"), password: Option.some("pw") }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetPasswordConflictError);
    }).pipe(Effect.scoped, Effect.provide(ctx.layer));
  });

  it.effect("fetches the pooler config but mints no login role when --password is given", () => {
    const ctx = setup(tmp.current, {
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* migrationList(
        flags({ password: Option.some("pw"), projectRef: Option.some(VALID_REF) }),
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
      ]);
      assertPermissionDrift({
        command: "migration list",
        activeFlags: { password: true, "project-ref": VALID_REF },
        requests: [...asRecordedRequests(requests), ...ctx.http.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });
});
