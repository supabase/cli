import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer, Option, Path } from "effect";
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
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { MigrationsReadError } from "../../../command-internal/migration.errors.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { WorkspaceTargetError } from "../../../command-internal/workspace-target.ts";
import { MigrationPasswordFlagsError, MigrationTargetFlagsError } from "../migration.errors.ts";
import { migrationList } from "./list.handler.ts";
import type { MigrationListFlags } from "./list.command.ts";

const LIST_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

interface SetupOpts {
  readonly explicitWorkdir?: boolean;
  readonly format?: OutputFormat;
  readonly args?: ReadonlyArray<string>;
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

  const resolverCalls: Array<DbConfigFlags> = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolve: (flags: DbConfigFlags) => {
      resolverCalls.push(flags);
      return Effect.succeed({
        conn: {
          host: "127.0.0.1",
          port: 54322,
          user: "postgres",
          password: "x",
          database: "postgres",
        },
        isLocal: opts.isLocal ?? false,
        ref: Option.some(VALID_REF),
      } satisfies ResolvedDbConfig);
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
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0 ? flagValue.value : VALID_REF,
      ),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });

  const http = recordingProjectHttpClient(VALID_REF);
  const layer = Layer.mergeAll(
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
    mockCommandSettings({ workdir, explicitWorkdir: opts.explicitWorkdir }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
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
  linked: over.linked ?? true,
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

const tmp = useTempWorkdir();

describe("migration list", () => {
  it.effect("lists merged local + remote migrations for the linked project by default", () => {
    const ctx = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql", "20240103000000_c.sql"]);
      yield* migrationList(flags());
      expect(stripAnsi(ctx.out.stderrText)).toContain("Connecting to remote database...");
      const stdout = stripAnsi(ctx.out.stdoutText);
      expect(stdout).toContain("Local");
      expect(stdout).toContain("Time (UTC)");
      expect(stdout).toContain("`20240101000000`");
      expect(stdout).toContain("`20240102000000`");
      expect(stdout).toContain("`20240103000000`");
      expect(ctx.resolverCalls[0]?.connType).toBe("linked");
      expect(ctx.cache.cachedRef).toBe(VALID_REF);
    }).pipe(Effect.provide(ctx.layer));
  });

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

  it.effect("lists the project given via --project-ref, overriding the default linked ref", () => {
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

  it.effect("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const ctx = setup(tmp.current, { args: ["--local"], isLocal: true, remote: [] });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
      const error = yield* migrationList(
        flags({ linked: false, local: true, projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationTargetFlagsError);
      expect(error.message).toBe(
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      );
      expect(ctx.resolverCalls).toEqual([]);
      expect(ctx.cache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect("targets the local database with --local and skips the linked cache", () => {
    const ctx = setup(tmp.current, {
      args: ["--local"],
      isLocal: true,
      remote: [],
    });
    return Effect.gen(function* () {
      yield* seedMigrations(tmp.current, ["20240101000000_a.sql"]);
      yield* migrationList(flags({ linked: false, local: true }));
      expect(ctx.resolverCalls[0]?.connType).toBe("local");
      expect(ctx.cache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(ctx.layer));
  });

  it.effect("rejects --db-url combined with --linked", () => {
    const { layer } = setup(tmp.current, { args: ["--db-url", "postgresql://x", "--linked"] });
    return Effect.gen(function* () {
      const error = yield* migrationList(
        flags({ dbUrl: Option.some("postgresql://x"), linked: true }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationTargetFlagsError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --db-url combined with --password", () => {
    const { layer } = setup(tmp.current, { args: ["--db-url", "postgresql://x"] });
    return Effect.gen(function* () {
      const error = yield* migrationList(
        flags({ dbUrl: Option.some("postgresql://x"), password: Option.some("pw") }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationPasswordFlagsError);
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
      args: ["migration", "list", "--project-ref", VALID_REF],
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
      args: ["migration", "list", "--local"],
      isLocal: true,
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* migrationList(flags({ linked: false, local: true }));
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

  it.effect("fetches the pooler config but mints no login role when --password is given", () => {
    const ctx = setup(tmp.current, {
      args: ["migration", "list", "--password", "pw", "--project-ref", VALID_REF],
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

  describe("workspace target", () => {
    const OTHER_REF = "abcdefghijklmnopqrst";
    const envLayer = (env: Record<string, string> = {}) =>
      ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true }));
    const writeTarget = Effect.fnUntraced(function* (target: string) {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(`${tmp.current}/supabase`, { recursive: true });
      yield* fs.writeFileString(`${tmp.current}/supabase/config.toml`, `target = "${target}"\n`);
    });

    it.effect("target = local lists the local database without a warning", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true, isLocal: true });
      return Effect.gen(function* () {
        yield* writeTarget("local");
        yield* migrationList(flags());
        expect(ctx.resolverCalls[0]?.connType).toBe("local");
        expect(ctx.cache.cached).toBe(false);
        expect(ctx.out.stderrText).not.toContain("Warning:");
      }).pipe(Effect.provide(Layer.mergeAll(ctx.layer, envLayer())));
    });

    it.effect("target = remote lists the linked project and names the source", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true });
      return Effect.gen(function* () {
        yield* writeTarget("remote");
        yield* migrationList(flags());
        expect(ctx.resolverCalls[0]?.connType).toBe("linked");
        expect(ctx.out.stderrText).toContain(
          'Targeting the linked project (target = "remote" from supabase/config.toml)',
        );
        expect(ctx.out.stderrText).not.toContain("Warning:");
      }).pipe(Effect.provide(Layer.mergeAll(ctx.layer, envLayer())));
    });

    it.effect("fails instead of dropping --password when target = local", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true, isLocal: true });
      return Effect.gen(function* () {
        yield* writeTarget("local");
        const error = yield* migrationList(flags({ password: Option.some("pw") })).pipe(
          Effect.flip,
        );
        expect(error).toBeInstanceOf(MigrationPasswordFlagsError);
        expect(error).toMatchObject({
          message: expect.stringContaining(
            "--password only applies when targeting the linked project",
          ),
        });
        expect(ctx.resolverCalls).toEqual([]);
      }).pipe(Effect.provide(Layer.mergeAll(ctx.layer, envLayer())));
    });

    it.effect("keeps --password with target = remote", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true });
      return Effect.gen(function* () {
        yield* writeTarget("remote");
        yield* migrationList(flags({ password: Option.some("pw") }));
        expect(ctx.resolverCalls[0]).toMatchObject({
          connType: "linked",
          password: Option.some("pw"),
        });
      }).pipe(Effect.provide(Layer.mergeAll(ctx.layer, envLayer())));
    });

    it.effect("keeps --password and warns about the default flip when no target is set", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true });
      return Effect.gen(function* () {
        yield* migrationList(flags({ password: Option.some("pw") }));
        expect(ctx.resolverCalls[0]).toMatchObject({
          connType: "linked",
          password: Option.some("pw"),
        });
        expect(ctx.out.stderrText.match(/Warning:/g)).toHaveLength(1);
      }).pipe(Effect.provide(Layer.mergeAll(ctx.layer, envLayer())));
    });

    it.effect("--project-ref resolves to the linked project when target = remote", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true });
      return Effect.gen(function* () {
        yield* writeTarget("remote");
        yield* migrationList(flags({ projectRef: Option.some(OTHER_REF) }));
        expect(ctx.resolverCalls[0]).toMatchObject({
          connType: "linked",
          linkedProjectRef: Option.some(OTHER_REF),
        });
        expect(ctx.cache.cachedRef).toBe(OTHER_REF);
      }).pipe(Effect.provide(Layer.mergeAll(ctx.layer, envLayer())));
    });

    it.effect("--project-ref without a target neither warns nor reads the config target", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true });
      return Effect.gen(function* () {
        yield* migrationList(flags({ projectRef: Option.some(OTHER_REF) }));
        expect(ctx.resolverCalls[0]?.connType).toBe("linked");
        expect(ctx.out.stderrText).not.toContain("Warning:");
        expect(ctx.out.stderrText).not.toContain("Targeting the linked project");
      }).pipe(Effect.provide(Layer.mergeAll(ctx.layer, envLayer())));
    });

    it.effect("fails on a malformed project env file before any API call or connection", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true, realLayers: true });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
        yield* fs.makeDirectory(`${tmp.current}/supabase`, { recursive: true });
        yield* fs.writeFileString(
          `${tmp.current}/supabase/.env`,
          "SUPABASE_TARGET=local\nBAD LINE!\n",
        );
        const error = yield* migrationList(flags()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(DbConfigLoadError);
        expect(error.message).toBe("failed to parse environment file: .env");
        expect(requests).toEqual([]);
        expect(ctx.http.calls).toEqual([]);
        expect(ctx.out.stderrText).not.toContain("Connecting to");
        expect(ctx.telemetry.flushed).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(ctx.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    });

    it.effect("flushes telemetry when the workspace target is invalid", () => {
      const ctx = setup(tmp.current, { explicitWorkdir: true });
      return Effect.gen(function* () {
        const error = yield* migrationList(flags()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(WorkspaceTargetError);
        expect(ctx.telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(Layer.mergeAll(ctx.layer, envLayer({ SUPABASE_TARGET: "prod" }))));
    });
  });
});
