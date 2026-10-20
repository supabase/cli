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
  sequentialExecBatch,
  withConfigEnv,
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import {
  assertTargetDefaultWarning,
  setLinkedRefFile,
} from "../../../../tests/helpers/target-default-warning.ts";
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
import { DnsResolverFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { type DbSession, DbConnection } from "../../../command-internal/db-connection.service.ts";
import {
  MigrationFileNotFoundError,
  MigrationInvalidVersionError,
  MigrationTargetFlagsError,
  OperationCanceledError,
} from "../migration.errors.ts";
import { MigrationRepairUpdateError } from "./repair.errors.ts";
import { migrationRepair, type MigrationRepairInput } from "./repair.handler.ts";

interface SetupOpts {
  /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
  readonly realLayers?: boolean;
  readonly format?: OutputFormat;
  readonly isTTY?: boolean;
  readonly pipedInput?: string;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly args?: ReadonlyArray<string>;
  readonly failSql?: string;
  readonly failResolve?: boolean;
  readonly noProjectId?: boolean;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  const execs: Array<string> = [];
  const queries: Array<{ sql: string; params?: ReadonlyArray<unknown> }> = [];

  const resolver = Layer.succeed(DbConfigResolver, {
    resolve: (_flags: DbConfigFlags) =>
      opts.failResolve === true
        ? Effect.fail(
            new ProjectRefNotLinkedError({
              message: "Cannot find project ref. Have you run link?",
            }),
          )
        : Effect.succeed({
            conn: {
              host: "127.0.0.1",
              port: 54322,
              user: "postgres",
              password: "x",
              database: "postgres",
            },
            isLocal: false,
            ref: Option.some(VALID_REF),
          } satisfies ResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            return opts.failSql !== undefined && sql.includes(opts.failSql)
              ? Effect.fail(new DbExecError({ message: "boom" }))
              : Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            return opts.failSql !== undefined && sql.includes(opts.failSql)
              ? Effect.fail(new DbExecError({ message: "boom" }))
              : Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
          }),
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        // Replays each statement through exec/query so recordings and failure injection apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
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
    mockCommandSettings({
      workdir,
      ...(opts.noProjectId === true ? { projectId: Option.none() } : {}),
    }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    mockTty({ stdinIsTty: opts.isTTY ?? true }),
    mockStdin(
      opts.isTTY ?? true,
      // Migration prompts read stdin directly, so the confirm answer is piped in.
      opts.pipedInput ?? (opts.confirm === undefined ? undefined : opts.confirm ? "y\n" : "n\n"),
    ),
    BunServices.layer,
  );
  return { layer, http, out, telemetry, execs, queries, cache };
}

const input = (over: Partial<MigrationRepairInput> = {}): MigrationRepairInput => ({
  versions: over.versions ?? [],
  status: over.status ?? "applied",
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? true,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
  password: over.password ?? Option.none(),
});

const seedMigration = Effect.fnUntraced(function* (workdir: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(workdir, "supabase", "migrations");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, name), body);
});

const writeProjectFile = Effect.fnUntraced(function* (workdir: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, name), body);
});

const tmp = useTempWorkdir();

describe("migration repair", () => {
  it.effect("marks a version as applied by upserting from its local file", () => {
    const { layer, execs, queries, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
      expect(stripAnsi(out.stderrText)).toContain("Connecting to remote database...");
      expect(execs).toContain("BEGIN");
      expect(execs).toContain("COMMIT");
      expect(execs).not.toContain("ROLLBACK");
      const upsert = queries.find((q) => q.sql.includes("ON CONFLICT"));
      expect(upsert?.params).toEqual(["20240101000000", "init", ["create table a"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the DB target before parsing positional versions", () => {
    const { layer } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["not-a-number"], status: "applied" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("caches the linked project even when the repair-all prompt is declined", () => {
    const { layer, cache } = setup(tmp.current, { confirm: false });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(OperationCanceledError);
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("marks versions as reverted by deleting them", () => {
    const { layer, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* migrationRepair(
        input({ versions: ["20240101000000", "20240102000000"], status: "reverted" }),
      );
      const del = queries.find((q) => q.sql.includes("WHERE version = ANY"));
      expect(del?.params).toEqual([["20240101000000", "20240102000000"]]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a non-numeric version", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["not-a-number"], status: "applied" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationInvalidVersionError);
      // Unlike db reset's bare message, migration repair keeps the "failed to parse <v>:" wrapper.
      expect(error.message).toBe("failed to parse not-a-number: invalid version number");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a version outside Go's int range before any DB mutation", () => {
    const { layer, execs, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["99999999999999999999"], status: "applied" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationInvalidVersionError);
      expect(execs).not.toContain("BEGIN");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("repair-all truncates and reapplies local files on confirm", () => {
    const { layer, execs, queries } = setup(tmp.current, { confirm: true });
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(input({ versions: [], status: "applied" }));
      expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "repair-all with --status reverted wipes the whole history (no upserts, no deletes)",
    () => {
      // repair-all + reverted only queues TRUNCATE; DELETE is the non-repair-all path
      // and UPSERT is the applied path.
      const { layer, execs, queries } = setup(tmp.current, { confirm: true });
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
        yield* migrationRepair(input({ versions: [], status: "reverted" }));
        expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
        expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(false);
        expect(queries.some((q) => q.sql.includes("WHERE version = ANY"))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("repair-all cancels on a declined prompt", () => {
    const { layer, execs } = setup(tmp.current, { confirm: false });
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      const error = yield* migrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(OperationCanceledError);
      expect(execs).not.toContain("TRUNCATE supabase_migrations.schema_migrations");
    }).pipe(Effect.provide(layer));
  });

  it.effect("repair-all without a TTY and no piped answer falls back to NO (cancel)", () => {
    // isTTY only changes the read timeout; stdin is still read either way.
    const { layer, out } = setup(tmp.current, { isTTY: false });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(OperationCanceledError);
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("repair-all honors a piped 'y' answer without a TTY (proceeds)", () => {
    // Piped stdin is read even without a TTY, overriding the default no.
    const { layer, execs, queries } = setup(tmp.current, { isTTY: false, pipedInput: "y\n" });
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(input({ versions: [], status: "applied" }));
      expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("auto-confirms repair-all via SUPABASE_YES (no --yes flag)", () => {
    const { layer, execs, queries } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(input({ versions: [], status: "applied" }));
      expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
      expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
    }).pipe(Effect.provide(layer), (body) => withConfigEnv({ SUPABASE_YES: "1" }, body));
  });

  it.effect(
    "auto-confirms repair-all via SUPABASE_YES in the project .env (Go loadNestedEnv)",
    () => {
      // SUPABASE_YES lives only in supabase/.env; the project env loads it before the prompt.
      const { layer, execs, queries } = setup(tmp.current);
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
        yield* writeProjectFile(tmp.current, ".env", "SUPABASE_YES=true\n");
        yield* migrationRepair(input({ versions: [], status: "applied" }));
        expect(execs).toContain("TRUNCATE supabase_migrations.schema_migrations");
        expect(queries.some((q) => q.sql.includes("ON CONFLICT"))).toBe(true);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("surfaces a DB-config error before prompting (repair-all, unlinked)", () => {
    const { layer, out } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(input({ versions: [], status: "applied" })).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints the repaired, finished, and suggestion lines on success", () => {
    const { layer, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "applied" }));
      const stderr = stripAnsi(out.stderrText);
      const stdout = stripAnsi(out.stdoutText);
      expect(stderr).toContain("Repaired migration history: [20240101000000] => applied");
      expect(stdout).toContain("Finished supabase migration repair.");
      expect(stderr).toContain(
        "Run supabase migration list to show the updated migration history.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints multiple repaired versions using Go's %v slice format", () => {
    // The established format is space-separated and bracketed, with no commas; a
    // `.join(", ")` cleanup would silently change established output.
    const { layer, out } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* seedMigration(tmp.current, "20240102000000_more.sql", "create table b;\n");
      yield* migrationRepair(
        input({ versions: ["20240101000000", "20240102000000"], status: "applied" }),
      );
      expect(stripAnsi(out.stderrText)).toContain(
        "Repaired migration history: [20240101000000 20240102000000] => applied",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a missing local file in applied mode", () => {
    const { layer } = setup(tmp.current); // no seeded file
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["20240101000000"], status: "applied" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationFileNotFoundError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rolls back and reports an update failure", () => {
    const { layer, execs } = setup(tmp.current, { failSql: "WHERE version = ANY" });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({ versions: ["20240101000000"], status: "reverted" }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationRepairUpdateError);
      expect(execs).toContain("ROLLBACK");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --db-url combined with --linked", () => {
    const { layer } = setup(tmp.current, { args: ["--db-url", "postgresql://x", "--linked"] });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          dbUrl: Option.some("postgresql://x"),
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationTargetFlagsError);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "repairs the project given via --project-ref, overriding the default linked ref",
    () => {
      // VALID_REF is the fake resolver's fallback; the flag must win over it and drive
      // the cached ref.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, cache } = setup(tmp.current);
      return Effect.gen(function* () {
        yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
        yield* migrationRepair(
          input({
            versions: ["20240101000000"],
            status: "applied",
            projectRef: Option.some(FLAG_REF),
          }),
        );
        expect(cache.cached).toBe(true);
        expect(cache.cachedRef).toBe(FLAG_REF);
        expect(cache.cachedRef).not.toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("rejects --project-ref combined with an explicit --local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, execs, queries, cache } = setup(tmp.current, { args: ["--local"] });
    return Effect.gen(function* () {
      const error = yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          linked: false,
          local: true,
          projectRef: Option.some(FLAG_REF),
        }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationTargetFlagsError);
      expect(error.message).toBe(
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      );
      expect(execs).toEqual([]);
      expect(queries).toEqual([]);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured result in json mode", () => {
    const { layer, out } = setup(tmp.current, { format: "json" });
    return Effect.gen(function* () {
      yield* migrationRepair(input({ versions: ["20240101000000"], status: "reverted" }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migration history repaired",
          data: { versions: ["20240101000000"], status: "reverted", repairAll: false },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const ctx = setup(tmp.current, {
      args: ["migration", "repair", "--project-ref", VALID_REF],
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          projectRef: Option.some(VALID_REF),
        }),
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(ctx.http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "migration repair",
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
      args: ["migration", "repair", "--local"],
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(
        input({ versions: ["20240101000000"], status: "applied", linked: false, local: true }),
      );
      expect(requests).toEqual([]);
      expect(ctx.http.calls).toEqual([]);
      assertPermissionDrift({
        command: "migration repair",
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
      args: ["migration", "repair", "--password", "pw", "--project-ref", VALID_REF],
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* seedMigration(tmp.current, "20240101000000_init.sql", "create table a;\n");
      yield* migrationRepair(
        input({
          versions: ["20240101000000"],
          status: "applied",
          password: Option.some("pw"),
          projectRef: Option.some(VALID_REF),
        }),
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
      ]);
      assertPermissionDrift({
        command: "migration repair",
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

describe("migration repair target default warning", () => {
  const selectors = [
    { label: "--linked", args: ["--linked"], over: {} },
    { label: "--linked=false", args: ["--linked=false"], over: { linked: false } },
    { label: "--local", args: ["--local"], over: { linked: false, local: true } },
    {
      label: "--db-url",
      args: ["--db-url", "postgresql://x"],
      over: { dbUrl: Option.some("postgresql://x") },
    },
    {
      label: "--project-ref",
      args: ["--project-ref", VALID_REF],
      over: { projectRef: Option.some(VALID_REF) },
    },
  ] as const;

  const runWith = (linked: boolean) => (selector: (typeof selectors)[number] | undefined) => {
    setLinkedRefFile(tmp.current, linked);
    const { layer, out } = setup(tmp.current, {
      args: selector?.args ?? [],
      noProjectId: true,
    });
    return migrationRepair(
      input({ versions: ["20240101000000"], status: "reverted", ...selector?.over }),
    ).pipe(
      Effect.provide(layer),
      Effect.map(() => ({ stdout: out.stdoutText, stderr: out.stderrText })),
    );
  };

  it.effect(
    "warns on a bare run in a linked workdir and stays silent with every selector or when unlinked",
    () =>
      assertTargetDefaultWarning({
        command: "migration repair",
        sameTarget: selectors[0],
        selectors,
        run: runWith(true),
        runUnlinked: runWith(false),
      }),
  );
});
