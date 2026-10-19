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

import {
  VALID_REF,
  VALID_TOKEN,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { stripAnsi } from "../../../../tests/helpers/ansi.ts";
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
import { configValuesLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { DnsResolverFlag, OutputFlag, YesFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigLoadError } from "../../../command-internal/db-config.errors.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { DbConnectError } from "../../../command-internal/db-connection.errors.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import { CommandTarget } from "../../../shared/output/command-target.service.ts";
import {
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
import { OperationCanceledError } from "../migration.errors.ts";
import { MigrationFetchWriteError } from "./fetch.errors.ts";
import { migrationFetch } from "./fetch.handler.ts";
import type { MigrationFetchFlags } from "./fetch.command.ts";
import {
  BRANCH_PROJECT_REF,
  branchRow,
  warningsOf,
} from "../../../../tests/helpers/remote-selection.ts";

const SELECT_SQL =
  "SELECT version, coalesce(name, '') as name, statements FROM supabase_migrations.schema_migrations";
const FLAG_REF = "flagflagflagflagflag";
const DB_URL = "postgresql://u:p@db.example.com/postgres";

interface MigrationRow {
  readonly version: string;
  readonly name: string;
  readonly statements: ReadonlyArray<string>;
}

interface SetupOpts {
  /** Runs the real `DbConfigResolver` and linked-project cache against `workdir`. */
  readonly realLayers?: boolean;
  readonly format?: OutputFormat;
  readonly isTTY?: boolean;
  readonly pipedInput?: string;
  readonly yes?: boolean;
  readonly confirm?: boolean;
  readonly rows?: ReadonlyArray<MigrationRow>;
  readonly resolveFails?: boolean;
  readonly connectFails?: boolean;
  readonly args?: ReadonlyArray<string>;
}

function setup(workdir: string, opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm === undefined ? undefined : [opts.confirm],
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();

  const resolveCalls: Array<DbConnectionInput> = [];
  const resolver = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) =>
      opts.resolveFails === true
        ? Effect.fail(
            new DbConfigLoadError({
              message: "failed to parse config: invalid connection string",
            }),
          )
        : Effect.sync(() => {
            resolveCalls.push(input);
            return {
              conn: {
                host: "127.0.0.1",
                port: 54322,
                user: "postgres",
                password: "x",
                database: "postgres",
              },
              isLocal: input.target.kind === "local",
              ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
              target: input.target,
            } satisfies ResolvedDbConnection;
          }),
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });

  const connection = Layer.succeed(DbConnection, {
    connect: () =>
      opts.connectFails === true
        ? Effect.fail(new DbConnectError({ message: "connection refused" }))
        : Effect.succeed({
            exec: () => Effect.void,
            execBatch: () => Effect.void,
            query: (sql: string) =>
              Effect.suspend(() =>
                sql === SELECT_SQL
                  ? Effect.succeed((opts.rows ?? []).map((r) => ({ ...r })))
                  : Effect.succeed([]),
              ),
            extensionExists: () => Effect.succeed(false),
            copyToCsv: () => Effect.succeed(new Uint8Array()),
            queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
          }),
  });

  const projectRef = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      Effect.succeed(
        Option.isSome(flagValue) && flagValue.value.length > 0
          ? { ref: flagValue.value, source: "flag", matchesLinkedRef: false }
          : { ref: VALID_REF, source: "file", matchesLinkedRef: true },
      ),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });

  const http = recordingProjectHttpClient(VALID_REF);
  const branchApi = mockCommandPlatformApi({
    handler: (request) => Effect.succeed(jsonResponse(request, 200, [branchRow("feature-x")])),
  });
  const layer = Layer.mergeAll(
    out.layer,
    configValuesLayer({ output: out.layer }),
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
    Layer.succeed(CliArgs, { args: opts.args ?? ["migration", "fetch"] }),
    commandRuntimeLayer(["migration", "fetch"]).pipe(Layer.provide(BunServices.layer)),
    branchApi.layer,
    Layer.succeed(OutputFlag, Option.none()),
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    mockTty({ stdinIsTty: opts.isTTY ?? true }),
    mockStdin(
      opts.isTTY ?? true,
      // Migration prompts read stdin directly, so the confirm answer is piped in.
      opts.pipedInput ?? (opts.confirm === undefined ? undefined : opts.confirm ? "y\n" : "n\n"),
    ),
    BunServices.layer,
  );
  const warnings = () => warningsOf(out);
  return {
    layer,
    http,
    out,
    telemetry,
    cache,
    resolveCalls,
    warnings,
    branchRequests: branchApi.requests,
  };
}

const flags = (over: Partial<MigrationFetchFlags> = {}): MigrationFetchFlags => ({
  dbUrl: over.dbUrl ?? Option.none(),
  remote: over.remote ?? Option.none(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none(),
});

const migrationsDir = Effect.fnUntraced(function* (workdir: string) {
  const path = yield* Path.Path;
  return path.join(workdir, "supabase", "migrations");
});

const migrationPath = Effect.fnUntraced(function* (workdir: string, file: string) {
  const path = yield* Path.Path;
  return path.join(yield* migrationsDir(workdir), file);
});

const listMigrations = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readDirectory(yield* migrationsDir(workdir));
});

const readMigration = Effect.fnUntraced(function* (workdir: string, file: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(yield* migrationPath(workdir, file));
});

const seedExistingMigration = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(yield* migrationsDir(workdir), { recursive: true });
  yield* fs.writeFileString(yield* migrationPath(workdir, "existing.sql"), "select 1;\n");
});

const writeProjectFile = Effect.fnUntraced(function* (workdir: string, name: string, body: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(workdir, "supabase");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, name), body);
});

const migrationsDirExists = Effect.fnUntraced(function* (workdir: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.exists(yield* migrationsDir(workdir)).pipe(Effect.orElseSucceed(() => false));
});

const tmp = useTempWorkdir();

describe("migration fetch", () => {
  it.effect("writes migration files joined with the separator when the dir is empty", () => {
    const { layer } = setup(tmp.current, {
      rows: [
        {
          version: "20240101000000",
          name: "init",
          statements: ["create table a", "create index b"],
        },
      ],
    });
    return Effect.gen(function* () {
      yield* migrationFetch(flags());
      expect(yield* listMigrations(tmp.current)).toEqual(["20240101000000_init.sql"]);
      expect(yield* readMigration(tmp.current, "20240101000000_init.sql")).toBe(
        "create table a;\ncreate index b;\n",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes a lone separator for a row with no statements", () => {
    // A schema_migrations row can have a NULL/empty statements array; joining still
    // yields exactly ";\n", not an empty file. This locks that byte behavior.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "20240101000000", name: "empty", statements: [] }],
    });
    return Effect.gen(function* () {
      yield* migrationFetch(flags());
      expect(yield* readMigration(tmp.current, "20240101000000_empty.sql")).toBe(";\n");
    }).pipe(Effect.provide(layer));
  });

  it.effect("prompts before overwriting a non-empty directory and proceeds on yes", () => {
    const { layer } = setup(tmp.current, {
      confirm: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      yield* migrationFetch(flags());
      expect(yield* listMigrations(tmp.current)).toContain("20240101000000_init.sql");
    }).pipe(Effect.provide(layer));
  });

  it.effect("cancels with context canceled when the overwrite prompt is declined", () => {
    const { layer } = setup(tmp.current, {
      confirm: false,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      const error = yield* migrationFetch(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OperationCanceledError);
      expect(yield* listMigrations(tmp.current)).toEqual(["existing.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("honors a piped 'n' answer without a TTY (cancels the overwrite)", () => {
    // The overwrite prompt defaults to YES; piped stdin still overrides it without a TTY.
    const { layer } = setup(tmp.current, {
      isTTY: false,
      pipedInput: "n\n",
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      const error = yield* migrationFetch(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OperationCanceledError);
      expect(yield* listMigrations(tmp.current)).toEqual(["existing.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect.each(["u", "yess", "nope", "   "])(
    "cancels the overwrite on the unrecognised piped answer %j",
    (answer) => {
      const { layer } = setup(tmp.current, {
        isTTY: false,
        pipedInput: `${answer}\n`,
        rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
      });
      return Effect.gen(function* () {
        yield* seedExistingMigration(tmp.current);
        const error = yield* migrationFetch(flags()).pipe(Effect.flip);
        expect(error).toBeInstanceOf(OperationCanceledError);
        expect(yield* listMigrations(tmp.current)).toEqual(["existing.sql"]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect.each(["\n", "", " YES \n"])("overwrites on the piped answer %j", (pipedInput) => {
    const { layer } = setup(tmp.current, {
      isTTY: false,
      pipedInput,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      yield* migrationFetch(flags());
      expect(yield* listMigrations(tmp.current)).toContain("20240101000000_init.sql");
    }).pipe(Effect.provide(layer));
  });

  it.effect("bypasses the overwrite prompt with --yes (echoes the auto-answer)", () => {
    const { layer, out } = setup(tmp.current, {
      yes: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      yield* migrationFetch(flags());
      expect(out.stderrText).toContain("[Y/n] y");
      expect(yield* listMigrations(tmp.current)).toContain("20240101000000_init.sql");
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the announced target in the overwrite question", () => {
    const { layer, out } = setup(tmp.current, {
      yes: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    const announced = Layer.succeed(
      CommandTarget,
      CommandTarget.of({
        announce: () => Effect.void,
        hintLocal: () => Effect.void,
        json: Effect.succeed(Option.none()),
        text: Effect.succeed(Option.some("project my-app (flagflagflagflagflag) · production")),
      }),
    );
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      yield* migrationFetch(flags());
      expect(stripAnsi(out.stderrText)).toContain(
        "Overwrite local migrations with the history from project my-app (flagflagflagflagflag) · production? [Y/n] y",
      );
    }).pipe(Effect.provide(Layer.merge(layer, announced)));
  });

  it.effect("asks about the target database when no target was announced", () => {
    const { layer, out } = setup(tmp.current, {
      yes: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      yield* migrationFetch(flags());
      expect(stripAnsi(out.stderrText)).toContain(
        "Overwrite local migrations with the history from the target database? [Y/n] y",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("auto-confirms the overwrite prompt from SUPABASE_YES in the project .env", () => {
    // SUPABASE_YES lives only in supabase/.env; the project env loads before the
    // overwrite prompt.
    const { layer, out } = setup(tmp.current, {
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      yield* writeProjectFile(tmp.current, ".env", "SUPABASE_YES=true\n");
      yield* migrationFetch(flags());
      expect(out.stderrText).toContain("[Y/n] y");
      expect(yield* listMigrations(tmp.current)).toContain("20240101000000_init.sql");
    }).pipe(Effect.provide(layer));
  });

  it.effect("still prompts on stderr in json mode and proceeds on a piped yes", () => {
    // The overwrite prompt still writes to stderr and reads stdin in json mode; it must
    // not silently auto-accept.
    const { layer, out } = setup(tmp.current, {
      format: "json",
      isTTY: false,
      pipedInput: "y\n",
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      yield* migrationFetch(flags());
      expect(out.stderrText).toContain("[Y/n]");
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "Migration history fetched",
          data: { files: [yield* migrationPath(tmp.current, "20240101000000_init.sql")] },
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("honors a piped no in json mode (cancels the overwrite, no auto-accept)", () => {
    const { layer } = setup(tmp.current, {
      format: "json",
      isTTY: false,
      pipedInput: "n\n",
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* seedExistingMigration(tmp.current);
      const error = yield* migrationFetch(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(OperationCanceledError);
      expect(yield* listMigrations(tmp.current)).toEqual(["existing.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a hostile version/name from the history table (path traversal guard)", () => {
    // A tampered remote `schema_migrations` row could use `..`/separators to
    // escape the migrations dir (CWE-22). The guard rejects it before writing.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "20240101000000", name: "../../../etc/passwd", statements: [] }],
    });
    return Effect.gen(function* () {
      const error = yield* migrationFetch(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationFetchWriteError);
      expect(yield* listMigrations(tmp.current)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes a valid signed version verbatim (no all-digits requirement)", () => {
    // The raw version column writes verbatim into <version>_<name>.sql with no digit
    // check, so a value like "-1" still fetches instead of aborting the run.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "-1", name: "legacy", statements: ["select 1"] }],
    });
    return Effect.gen(function* () {
      yield* migrationFetch(flags());
      expect(yield* listMigrations(tmp.current)).toEqual(["-1_legacy.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects a hostile version from the history table (traversal guard on version)", () => {
    // Traversal hardening covers the version field too, not just name.
    const { layer } = setup(tmp.current, {
      rows: [{ version: "../../etc", name: "x", statements: [] }],
    });
    return Effect.gen(function* () {
      const error = yield* migrationFetch(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationFetchWriteError);
      expect(yield* listMigrations(tmp.current)).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a failure when the migrations path is not a directory", () => {
    const { layer } = setup(tmp.current, { rows: [] });
    return Effect.gen(function* () {
      yield* writeProjectFile(tmp.current, "migrations", "not a directory");
      const error = yield* migrationFetch(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(MigrationFetchWriteError);
    }).pipe(Effect.provide(layer));
  });

  it.effect("resolves DB config before creating the migrations dir or prompting", () => {
    const { layer, out } = setup(tmp.current, { resolveFails: true });
    return Effect.gen(function* () {
      const error = yield* migrationFetch(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(DbConfigLoadError);
      expect(yield* migrationsDirExists(tmp.current)).toBe(false);
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("leaves no migrations directory behind when the connection fails", () => {
    const { layer } = setup(tmp.current, { connectFails: true });
    return Effect.gen(function* () {
      const error = yield* migrationFetch(flags()).pipe(Effect.flip);
      expect(error).toBeInstanceOf(DbConnectError);
      expect(yield* migrationsDirExists(tmp.current)).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("targets the linked project for a bare --remote and caches its ref", () => {
    const { layer, resolveCalls, cache } = setup(tmp.current, { rows: [] });
    return Effect.gen(function* () {
      yield* migrationFetch(flags({ remote: Option.some({ _tag: "Linked" }) }));
      expect(resolveCalls).toHaveLength(1);
      expect(resolveCalls[0]?.target).toMatchObject({ kind: "linked", ref: VALID_REF });
      expect(Option.isNone(resolveCalls[0]?.networkBanRemoval ?? Option.none())).toBe(true);
      expect(cache.cachedRef).toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("hands network-ban removal to the connection only under --yes", () => {
    const { layer, resolveCalls } = setup(tmp.current, { yes: true, rows: [] });
    return Effect.gen(function* () {
      yield* migrationFetch(flags());
      expect(Option.isSome(resolveCalls[0]?.networkBanRemoval ?? Option.none())).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches from the local database by default without caching a project", () => {
    const { layer, resolveCalls, cache, warnings } = setup(tmp.current, {
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    return Effect.gen(function* () {
      yield* migrationFetch(flags());
      expect(resolveCalls[0]?.target).toEqual({ kind: "local" });
      expect(cache.cached).toBe(false);
      expect(warnings()).toEqual([]);
      expect(yield* listMigrations(tmp.current)).toEqual(["20240101000000_init.sql"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fetches from the database --remote=<url> names", () => {
    const { layer, resolveCalls, cache, warnings } = setup(tmp.current, { rows: [] });
    return Effect.gen(function* () {
      yield* migrationFetch(flags({ remote: Option.some({ _tag: "DbUrl", url: DB_URL }) }));
      expect(resolveCalls[0]?.target.kind).toBe("db-url");
      expect(cache.cached).toBe(false);
      expect(warnings()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --remote combined with --local before reading the project .env", () => {
    // A flag conflict must surface even when supabase/.env is malformed.
    const { layer } = setup(tmp.current);
    return Effect.gen(function* () {
      yield* writeProjectFile(tmp.current, ".env", "!=broken\n");
      const error = yield* migrationFetch(
        flags({ remote: Option.some({ _tag: "Linked" }), local: true }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetSelectorConflictError);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "fetches from the project --remote=<ref> names, overriding the default linked ref",
    () => {
      const { layer, cache, warnings } = setup(tmp.current, { rows: [] });
      return Effect.gen(function* () {
        yield* migrationFetch(flags({ remote: Option.some({ _tag: "Ref", ref: FLAG_REF }) }));
        expect(cache.cached).toBe(true);
        expect(cache.cachedRef).toBe(FLAG_REF);
        expect(cache.cachedRef).not.toBe(VALID_REF);
        expect(warnings()).toEqual([]);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fetches from the project of the branch --remote=<branch> names", () => {
    const { layer, resolveCalls, cache, branchRequests, warnings } = setup(tmp.current, {
      rows: [],
    });
    return Effect.gen(function* () {
      yield* migrationFetch(flags({ remote: Option.some({ _tag: "Branch", name: "feature-x" }) }));
      expect(branchRequests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}/branches`,
      ]);
      expect(resolveCalls[0]?.target).toMatchObject({ kind: "linked", ref: BRANCH_PROJECT_REF });
      expect(cache.cachedRef).toBe(BRANCH_PROJECT_REF);
      expect(warnings()).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with the branches that exist when --remote=<branch> matches none", () => {
    const { layer, resolveCalls, out } = setup(tmp.current, { rows: [] });
    return Effect.gen(function* () {
      const error = yield* migrationFetch(
        flags({ remote: Option.some({ _tag: "Branch", name: "feature-y" }) }),
      ).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "LinkBranchNotFoundError",
        message: expect.stringContaining("Available branches: feature-x"),
      });
      expect(resolveCalls).toEqual([]);
      expect(yield* migrationsDirExists(tmp.current)).toBe(false);
      expect(out.promptConfirmCalls.length).toBe(0);
    }).pipe(Effect.provide(layer));
  });

  describe("deprecated selectors", () => {
    const cases = [
      {
        alias: "--linked",
        args: ["migration", "fetch", "--linked"],
        flags: { linked: true },
        target: { kind: "linked", ref: VALID_REF },
        warning:
          "--linked is deprecated and will be removed in v4. Use --remote instead: supabase migration fetch --remote",
      },
      {
        alias: "--project-ref",
        args: ["migration", "fetch", "--project-ref", FLAG_REF],
        flags: { projectRef: Option.some(FLAG_REF) },
        target: { kind: "linked", ref: FLAG_REF },
        warning: `--project-ref is deprecated and will be removed in v4. Use --remote=<ref> instead: supabase migration fetch --remote=${FLAG_REF}`,
      },
      {
        alias: "--db-url",
        args: ["migration", "fetch", "--db-url", DB_URL],
        flags: { dbUrl: Option.some(DB_URL) },
        target: { kind: "db-url" },
        warning:
          "--db-url is deprecated and will be removed in v4. Use --remote=<db-url> instead: supabase migration fetch --remote=<db-url>",
      },
      {
        alias: "--local",
        args: ["migration", "fetch", "--local"],
        flags: { local: true },
        target: { kind: "local" },
        warning:
          "--local isn't needed (local is the default) and will be removed in v4: supabase migration fetch",
      },
    ] as const satisfies ReadonlyArray<{
      readonly alias: string;
      readonly args: ReadonlyArray<string>;
      readonly flags: Partial<MigrationFetchFlags>;
      readonly target: Record<string, string>;
      readonly warning: string;
    }>;

    for (const testCase of cases) {
      it.effect(`${testCase.alias} still selects its target and warns`, () => {
        const { layer, resolveCalls, warnings } = setup(tmp.current, {
          rows: [],
          args: testCase.args,
        });
        return Effect.gen(function* () {
          yield* migrationFetch(flags(testCase.flags));
          expect(resolveCalls[0]?.target).toMatchObject(testCase.target);
          expect(warnings()).toEqual([testCase.warning]);
        }).pipe(Effect.provide(layer));
      });
    }

    it.effect("rejects --project-ref combined with --local", () => {
      const { layer, out, cache } = setup(tmp.current);
      return Effect.gen(function* () {
        const error = yield* migrationFetch(
          flags({ local: true, projectRef: Option.some(FLAG_REF) }),
        ).pipe(Effect.flip);
        expect(error).toBeInstanceOf(TargetProjectRefConflictError);
        expect(yield* migrationsDirExists(tmp.current)).toBe(false);
        expect(out.promptConfirmCalls.length).toBe(0);
        expect(cache.cached).toBe(false);
      }).pipe(Effect.provide(layer));
    });
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const ctx = setup(tmp.current, {
      realLayers: true,
      rows: [{ version: "20240101000000", name: "init", statements: ["create table a"] }],
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* migrationFetch(flags({ remote: Option.some({ _tag: "Ref", ref: VALID_REF }) }));
      expect(yield* listMigrations(tmp.current)).toEqual(["20240101000000_init.sql"]);
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(ctx.http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tmp.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "migration fetch",
        activeFlags: { remote: VALID_REF },
        requests: [...asRecordedRequests(requests), ...ctx.http.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(ctx.layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect(
    "makes no Management API request for the default local target through the real resolver",
    () => {
      const ctx = setup(tmp.current, {
        realLayers: true,
        rows: [],
      });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        yield* stubManagementApi(requests, () => undefined);
        yield* migrationFetch(flags());
        expect(requests).toEqual([]);
        expect(ctx.http.calls).toEqual([]);
        assertPermissionDrift({
          command: "migration fetch",
          activeFlags: {},
          requests: [],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(ctx.layer),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );
});
