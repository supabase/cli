import { createHash } from "node:crypto";
import { NodeServices } from "@effect/platform-node";
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
} from "../../../../tests/helpers/command-mocks.ts";
import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
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
import { DnsResolverFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { DbConfigFlags, ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import { type DbSession, DbConnection } from "../../../command-internal/db-connection.service.ts";
import { MigrationDropError } from "../../../command-internal/drop-objects.ts";
import { MigrationSeedError } from "../../../command-internal/seed.ts";
import { MigrationTargetFlagsError, OperationCanceledError } from "../migration.errors.ts";
import { MigrationLastTooLargeError, MigrationLastZeroError } from "./down.errors.ts";
import { migrationDown } from "./down.handler.ts";
import type { MigrationDownFlags } from "./down.command.ts";
import { stubRemoteTarget } from "../../../../tests/helpers/remote-target.ts";

const LIST_SQL = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version";

interface SetupOpts {
  /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
  readonly realLayers?: boolean;
  readonly format?: OutputFormat;
  readonly isTTY?: boolean;
  readonly pipedInput?: string;
  readonly args?: ReadonlyArray<string>;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly remote?: ReadonlyArray<string>;
  readonly failResolve?: boolean;
  readonly failDrop?: boolean;
  readonly failSeed?: boolean;
  readonly seedTable?: ReadonlyArray<{ path: string; hash: string }>;
}

const SELECT_SEED = "SELECT path, hash FROM supabase_migrations.seed_files";

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
            isLocal: true,
            ref: Option.none(),
          } satisfies ResolvedDbConfig),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            if (opts.failDrop === true && sql.startsWith("do $$")) {
              return Effect.fail(new DbExecError({ message: "permission denied" }));
            }
            if (opts.failSeed === true && sql.startsWith("insert into")) {
              return Effect.fail(new DbExecError({ message: "boom" }));
            }
            return Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            queries.push({ sql, params });
            if (sql === LIST_SQL)
              return Effect.succeed((opts.remote ?? []).map((version) => ({ version })));
            if (sql === SELECT_SEED) return Effect.succeed([...(opts.seedTable ?? [])]);
            return Effect.succeed<ReadonlyArray<Record<string, unknown>>>([]);
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
  const projectRef = stubRemoteTarget({
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    load: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0 ? flagValue.value : VALID_REF,
      ),
    prompt: () => Effect.succeed(VALID_REF),
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
    mockCommandSettings({ workdir }),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(YesFlag, opts.yes ?? false),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
    mockTty({ stdinIsTty: opts.isTTY ?? true }),
    mockStdin(
      opts.isTTY ?? true,
      // Migration prompts read stdin directly, so the confirm answer is piped in.
      opts.pipedInput ?? (opts.confirm === undefined ? undefined : opts.confirm ? "y\n" : "n\n"),
    ),
    NodeServices.layer,
  );
  return { layer, http, out, telemetry, execs, queries, cache };
}

const flags = (over: Partial<MigrationDownFlags> = {}): MigrationDownFlags => ({
  last: over.last ?? 1,
  dbUrl: over.dbUrl ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? true,
  projectRef: over.projectRef ?? Option.none(),
});

const seed = Effect.fnUntraced(function* (
  workdir: string,
  name: string,
  body = "create table a;\n",
) {
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

describe("migration down", () => {
  it.effect("rejects --last 0", () => {
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      const error = yield* migrationDown(flags({ last: 0 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationLastZeroError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves the DB target before rejecting --last 0", () => {
    const { layer } = setup(tmp.current, { failResolve: true });
    return Effect.gen(function* () {
      const error = yield* migrationDown(flags({ last: 0 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(ProjectRefNotLinkedError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --last >= total applied migrations", () => {
    const { layer } = setup(tmp.current, { remote: ["20240101000000"] });
    return Effect.gen(function* () {
      const error = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationLastTooLargeError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reverts to the target version on confirm (drop + migrate&seed)", () => {
    const { layer, out, execs, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).toContain("Connecting to local database...");
      expect(stripAnsi(out.stderrText)).toContain("Resetting database to version: 20240101000000");
      expect(execs.some((sql) => sql.startsWith("do $$"))).toBe(true);
      expect(
        queries.some(
          (q) =>
            q.sql.includes("INSERT INTO supabase_migrations") && q.params?.[0] === "20240101000000",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "reverts on the project given via --project-ref --linked, overriding the linked ref",
    () => {
      // VALID_REF is the fake resolver's fallback, representing whatever the
      // workdir would resolve to without the flag override.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, cache } = setup(tmp.current, {
        args: ["--linked"],
        confirm: true,
        remote: ["20240101000000", "20240102000000"],
      });
      return Effect.gen(function* () {
        yield* seed(tmp.current, "20240101000000_a.sql");
        yield* migrationDown(
          flags({ last: 1, linked: true, local: false, projectRef: Option.some(FLAG_REF) }),
        );
        expect(cache.cached).toBe(true);
        expect(cache.cachedRef).toBe(FLAG_REF);
        expect(cache.cachedRef).not.toBe(VALID_REF);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("rejects --project-ref on the default local target", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, execs, queries, cache } = setup(tmp.current, {
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      const error = yield* migrationDown(
        flags({ last: 1, projectRef: Option.some(FLAG_REF) }),
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

  it.effect("cancels on a declined prompt", () => {
    const { layer, execs } = setup(tmp.current, {
      confirm: false,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      const error = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OperationCanceledError);
      expect(execs.some((sql) => sql.startsWith("do $$"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("falls back to NO (cancels) without a TTY and no piped answer", () => {
    // isTTY only changes the read timeout; stdin is still read either way.
    const { layer, out } = setup(tmp.current, {
      isTTY: false,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      const error = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OperationCanceledError);
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a structured result in json with --yes", () => {
    const { layer, out } = setup(tmp.current, {
      format: "json",
      yes: true,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(flags({ last: 1 }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migrations reverted",
          data: { version: "20240101000000", last: 1 },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("auto-confirms from SUPABASE_YES in the project .env (Go loadNestedEnv)", () => {
    // SUPABASE_YES lives only in supabase/.env; the project env loads it before the prompt.
    const { layer, out } = setup(tmp.current, {
      format: "json",
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, ".env", "SUPABASE_YES=true\n");
      yield* migrationDown(flags({ last: 1 }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migrations reverted",
          data: { version: "20240101000000", last: 1 },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a drop-schema failure", () => {
    const { layer } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
      failDrop: true,
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      const error = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationDropError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("seeds data from a new seed file and records its hash", () => {
    const { layer, out, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "seed.sql", "insert into a values (1);\n");
      yield* migrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).toContain("Seeding data from supabase/seed.sql...");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a seed-apply failure", () => {
    const { layer } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
      failSeed: true,
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "seed.sql", "insert into a values (1);\n");
      const error = yield* migrationDown(flags({ last: 1 })).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationSeedError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips an unchanged seed file", () => {
    const body = "insert into a values (1);\n";
    const hash = createHash("sha256").update(body).digest("hex");
    const { layer, out, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
      seedTable: [{ path: "supabase/seed.sql", hash }],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "seed.sql", body);
      yield* migrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).not.toContain("Seeding data from");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("updates the recorded hash (without re-running) for a changed seed file", () => {
    const { layer, out, execs, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
      seedTable: [{ path: "supabase/seed.sql", hash: "stale-hash-does-not-match" }],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "seed.sql", "insert into a values (2);\n");
      yield* migrationDown(flags({ last: 1 }));
      expect(stripAnsi(out.stderrText)).toContain("Updating seed hash to supabase/seed.sql...");
      expect(
        queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations.seed_files")),
      ).toBe(true);
      expect(execs).not.toContain("insert into a values (2)");
    }).pipe(Effect.provide(layer));
  });

  it.effect("skips migration apply when db.migrations.enabled = false", () => {
    const { layer, queries } = setup(tmp.current, {
      confirm: true,
      remote: ["20240101000000", "20240102000000"],
    });
    return Effect.gen(function* () {
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* writeProjectFile(tmp.current, "config.toml", "[db.migrations]\nenabled = false\n");
      yield* migrationDown(flags({ last: 1 }));
      expect(queries.some((q) => q.sql.includes("INSERT INTO supabase_migrations"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const ctx = setup(tmp.current, {
      args: ["migration", "down", "--linked", "--project-ref", VALID_REF],
      confirm: true,
      realLayers: true,
      remote: ["20240101000000", "20240102000000"],
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(
        flags({ last: 1, linked: true, local: false, projectRef: Option.some(VALID_REF) }),
      );
      expect(ctx.out.stderrText).toContain("Resetting database to version: 20240101000000");
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(ctx.http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "migration down",
        activeFlags: { linked: true, "project-ref": VALID_REF },
        requests: [...asRecordedRequests(requests), ...ctx.http.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("defaults to the local target and makes no Management API request", () => {
    const ctx = setup(tmp.current, {
      args: ["migration", "down"],
      confirm: true,
      realLayers: true,
      remote: ["20240101000000", "20240102000000"],
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* seed(tmp.current, "20240101000000_a.sql");
      yield* migrationDown(flags({ last: 1 }));
      expect(ctx.out.stderrText).toContain("Resetting database to version: 20240101000000");
      expect(requests).toEqual([]);
      expect(ctx.http.calls).toEqual([]);
      assertPermissionDrift({
        command: "migration down",
        requests: [],
        exact: true,
      });
      expect(() =>
        assertPermissionDrift({
          command: "migration down",
          requests: [
            {
              method: "POST",
              url: `https://api.supabase.com/v1/projects/${VALID_REF}/cli/login-role`,
            },
          ],
        }),
      ).toThrow(/condition doesn't hold/);
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });
});
