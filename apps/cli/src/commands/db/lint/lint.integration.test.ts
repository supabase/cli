import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import { vi } from "vitest";

vi.mock("node:net", (importOriginal) =>
  Promise.all([
    import("../../../../tests/helpers/refuse-invalid-db-hosts.ts"),
    importOriginal<typeof import("node:net")>(),
  ]).then(([helper, net]) => helper.refuseInvalidDbHosts(net)),
);

import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import { mockOutput, mockProcessControl } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  VALID_TOKEN,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  sequentialExecBatch,
  useTempWorkdir,
  withConfigEnv,
} from "../../../../tests/helpers/command-mocks.ts";
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
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type {
  DbConnectionInput,
  ResolvedDbConnection,
} from "../../../command-internal/db-config.types.ts";
import { TargetPolicy } from "../../../command-internal/target/target-policy.ts";
import {
  TargetProjectRefConflictError,
  TargetSelectorConflictError,
} from "../../../command-internal/target/target.errors.ts";
import { DbExecError } from "../../../command-internal/db-connection.errors.ts";
import {
  DbConnection,
  type PgConnInput,
  type DbSession,
} from "../../../command-internal/db-connection.service.ts";
import { DbLintFailOnError } from "./lint.errors.ts";
import { encodeLintResults, parseLintResult } from "./lint.format.ts";
import { dbLint } from "./lint.handler.ts";
import { CHECK_SCHEMA_SCRIPT, ENABLE_PGSQL_CHECK, LIST_SCHEMAS_SQL } from "./lint.lint-sql.ts";
import type { DbLintFlags } from "./lint.command.ts";

const LOCAL_CONN: PgConnInput = {
  host: "127.0.0.1",
  port: 54322,
  user: "postgres",
  password: "postgres",
  database: "postgres",
};

const ERROR_ISSUE = { level: "error", message: `record "r" has no field "c"` };
const WARNING_ISSUE = { level: "warning", message: "never read variable" };

/** Builds a plpgsql_check row keyed by the driver's column names. */
function checkRow(proname: string, issues: ReadonlyArray<Record<string, unknown>>) {
  return {
    proname,
    plpgsql_check_function: JSON.stringify({ function: proname, issues }),
  };
}

function mockResolver(opts: { isLocal?: boolean } = {}) {
  let resolveInput: DbConnectionInput | undefined;
  const layer = Layer.succeed(DbConfigResolver, {
    resolveConnection: (input: DbConnectionInput) => {
      resolveInput = input;
      return Effect.succeed({
        conn: LOCAL_CONN,
        isLocal: opts.isLocal ?? input.target.kind === "local",
        ref: input.target.kind === "linked" ? Option.some(input.target.ref) : Option.none(),
        target: input.target,
      } satisfies ResolvedDbConnection);
    },
    resolvePoolerFallback: () => Effect.succeed(Option.none()),
  });
  return {
    layer,
    get resolveInput() {
      return resolveInput;
    },
  };
}

const tempRoot = useTempWorkdir("supabase-db-lint-int-");

function mockConnection(opts: {
  schemas?: ReadonlyArray<string>;
  checkRows?: Record<string, ReadonlyArray<Record<string, unknown>>>;
  malformed?: boolean;
  enableFails?: boolean;
  queryFails?: boolean;
  listFails?: boolean;
}) {
  const execs: Array<string> = [];
  const linted: Array<string> = [];
  let listParams: ReadonlyArray<unknown> | undefined;
  const layer = Layer.succeed(DbConnection, {
    connect: () => {
      const session: DbSession = {
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        // Recorded at run-time (inside `Effect.suspend`), so a finalizer's
        // `exec("rollback")` is only logged when it actually runs.
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            if (sql === ENABLE_PGSQL_CHECK && opts.enableFails === true) {
              return Effect.fail(
                new DbExecError({
                  message: `ERROR: could not open extension control file (SQLSTATE 58P01)`,
                }),
              );
            }
            return Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            if (sql === LIST_SCHEMAS_SQL) {
              listParams = params;
              if (opts.listFails === true) {
                return Effect.fail(new DbExecError({ message: "permission denied" }));
              }
              return Effect.succeed((opts.schemas ?? []).map((nspname) => ({ nspname })));
            }
            if (sql === CHECK_SCHEMA_SCRIPT) {
              const schema = String(params?.[0]);
              linted.push(schema);
              if (opts.queryFails === true) {
                return Effect.fail(new DbExecError({ message: "syntax error" }));
              }
              if (opts.malformed === true) {
                return Effect.succeed([{ proname: "f1", plpgsql_check_function: "malformed" }]);
              }
              return Effect.succeed(opts.checkRows?.[schema] ?? []);
            }
            return Effect.succeed([]);
          }),
        // Replays a batch through exec/query so recordings and failure injection apply.
        execBatch: (statements) => sequentialExecBatch(session)(statements),
      };
      return Effect.succeed(session);
    },
  });
  return {
    layer,
    get execs() {
      return execs;
    },
    get linted() {
      return linted;
    },
    get listParams() {
      return listParams;
    },
  };
}

/** Project-ref resolver mock; an explicit `--project-ref` wins over the workdir's own ref. */
function mockProjectRef() {
  const calls: Array<string> = [];
  const layer = Layer.succeed(ProjectRefResolver, {
    resolve: () => Effect.succeed(VALID_REF),
    resolveForLink: () => Effect.succeed(VALID_REF),
    resolveRef: (flagValue: Option.Option<string>) =>
      Effect.sync(() => {
        calls.push("resolveRef");
        return {
          ref: Option.getOrElse(flagValue, () => VALID_REF),
          source: Option.isSome(flagValue) ? ("flag" as const) : ("file" as const),
          matchesLinkedRef: Option.isNone(flagValue),
        };
      }),
    resolveOptional: () => Effect.succeed(Option.some(VALID_REF)),
    promptProjectRef: () => Effect.succeed(VALID_REF),
  });
  return {
    layer,
    get calls() {
      return calls;
    },
  };
}

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  isLocal?: boolean;
  schemas?: ReadonlyArray<string>;
  checkRows?: Record<string, ReadonlyArray<Record<string, unknown>>>;
  malformed?: boolean;
  enableFails?: boolean;
  queryFails?: boolean;
  listFails?: boolean;
  /** Runs the real `DbConfigResolver` and linked-project cache against the temp `workdir`. */
  realLayers?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const resolver = mockResolver({ isLocal: opts.isLocal });
  const connection = mockConnection({
    schemas: opts.schemas,
    checkRows: opts.checkRows,
    malformed: opts.malformed,
    enableFails: opts.enableFails,
    queryFails: opts.queryFails,
    listFails: opts.listFails,
  });
  const telemetry = mockTelemetryStateTracked();
  const processControl = mockProcessControl();
  const projectRef = mockProjectRef();
  const cache = mockLinkedProjectCacheTracked();
  const http = recordingProjectHttpClient(VALID_REF);
  const layer = Layer.mergeAll(
    out.layer,
    opts.realLayers !== true
      ? resolver.layer
      : realDbConfigResolver({
          workdir: tempRoot.current,
          dbConnection: connection.layer,
          env: { SUPABASE_ACCESS_TOKEN: VALID_TOKEN },
        }),
    connection.layer,
    telemetry.layer,
    processControl.layer,
    projectRef.layer,
    opts.realLayers !== true
      ? cache.layer
      : realLinkedProjectCache({
          httpClient: http.layer,
          cliSettings: mockCommandSettings({ workdir: tempRoot.current }),
        }),
    mockCommandSettings({ workdir: tempRoot.current }),
    cliConfigValuesTestLayer,
    Layer.succeed(TargetPolicy, { group: "selectable", consent: "none" }),
    Layer.succeed(YesFlag, false),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(DnsResolverFlag, "native"),
  );
  return { layer, out, resolver, connection, telemetry, processControl, projectRef, cache, http };
}

const flags = (over: Partial<DbLintFlags> = {}): DbLintFlags => ({
  dbUrl: over.dbUrl ?? Option.none<string>(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  projectRef: over.projectRef ?? Option.none<string>(),
  schema: over.schema ?? [],
  level: over.level ?? Option.none<"warning" | "error">(),
  failOn: over.failOn ?? Option.none<"none" | "warning" | "error">(),
});

describe("db lint", () => {
  it.effect("lints the named schema and prints parsed issues to stdout", () => {
    const { layer, out, connection } = setup({
      schemas: [],
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] },
    });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"] }));
      const expected = encodeLintResults([
        parseLintResult(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            issues: [ERROR_ISSUE],
          }),
          "public.f1",
        ),
      ]);
      expect(out.stdoutText).toBe(expected);
      expect(out.stderrText).toContain("Linting schema: public");
      expect(connection.execs).toEqual(["begin", ENABLE_PGSQL_CHECK, "rollback"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lints every user schema when --schema is omitted", () => {
    const { layer, out, connection } = setup({
      schemas: ["public", "private"],
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])], private: [] },
    });
    return Effect.gen(function* () {
      yield* dbLint(flags());
      expect(Array.isArray(connection.listParams?.[0])).toBe(true);
      expect(connection.linted).toEqual(["public", "private"]);
      expect(out.stderrText).toContain("Linting schema: private");
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the plpgsql_check extension cannot be enabled", () => {
    const { layer } = setup({ schemas: [], enableFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbLint(flags({ schema: ["public"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to enable pgsql_check");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails on malformed plpgsql_check json", () => {
    const { layer } = setup({ malformed: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbLint(flags({ schema: ["public"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to parse lint result");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces a query failure from plpgsql_check", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbLint(flags({ schema: ["public"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to query rows");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("surfaces a list-schemas failure", () => {
    const { layer } = setup({ listFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbLint(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("failed to list schemas");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("prints 'No schema errors found' to stderr and nothing to stdout when clean", () => {
    const { layer, out } = setup({ checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"] }));
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toContain("\nNo schema errors found");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits nothing on stdout when all issues are below --level (no clean message)", () => {
    const { layer, out } = setup({ checkRows: { public: [checkRow("f1", [WARNING_ISSUE])] } });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"], level: Option.some("error") }));
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).not.toContain("No schema errors found");
    }).pipe(Effect.provide(layer));
  });

  it.effect("exits non-zero when --fail-on warning and a warning exists", () => {
    const { layer, out } = setup({ checkRows: { public: [checkRow("f1", [WARNING_ISSUE])] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbLint(flags({ schema: ["public"], failOn: Option.some("warning") })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(DbLintFailOnError);
          expect(failure.value.message).toBe("fail-on is set to warning, non-zero exit");
        }
      }
      expect(out.stdoutText).toContain("never read variable");
    }).pipe(Effect.provide(layer));
  });

  it.effect("exits non-zero when --fail-on error and an error exists", () => {
    const { layer } = setup({ checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbLint(flags({ schema: ["public"], failOn: Option.some("error") })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("fail-on is set to error, non-zero exit");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not exit non-zero when --fail-on is none", () => {
    const { layer } = setup({ checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(dbLint(flags({ schema: ["public"] })));
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("does not trigger --fail-on warning when --level error filters the warning out", () => {
    const { layer, out } = setup({ checkRows: { public: [checkRow("f1", [WARNING_ISSUE])] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbLint(
          flags({
            schema: ["public"],
            level: Option.some("error"),
            failOn: Option.some("warning"),
          }),
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --db-url together with --linked", () => {
    const { layer, connection } = setup();
    return Effect.gen(function* () {
      const error = yield* dbLint(flags({ dbUrl: Option.some("postgres://x"), linked: true })).pipe(
        Effect.flip,
      );
      expect(error).toBeInstanceOf(TargetSelectorConflictError);
      expect(connection.execs).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a standard success envelope in json mode", () => {
    const { layer, out } = setup({
      format: "json",
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] },
    });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"] }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "success",
          message: "db lint",
          data: { results: [{ function: "public.f1", issues: [ERROR_ISSUE] }] },
        }),
      );
      expect(out.stdoutText).toBe("");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits an empty result envelope in json mode when clean", () => {
    const { layer, out } = setup({ format: "json", checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"] }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db lint", data: { results: [] } }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a result event in stream-json mode", () => {
    const { layer, out } = setup({
      format: "stream-json",
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] },
    });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"] }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db lint" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("sets exit code 1 without failing the effect on fail-on in json mode", () => {
    const { layer, processControl } = setup({
      format: "json",
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        dbLint(flags({ schema: ["public"], failOn: Option.some("error") })),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("connects to the --db-url target", () => {
    const { layer, resolver } = setup({ isLocal: false, checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"], dbUrl: Option.some("postgres://x") }));
      expect(resolver.resolveInput?.target.kind).toBe("db-url");
    }).pipe(Effect.provide(layer));
  });

  it.effect("lints multiple pre-parsed schemas from a comma-separated --schema value", () => {
    // CSV parsing happens at `Flag.mapTryCatch` parse time; the handler receives the
    // already-split list directly.
    const { layer, connection } = setup({
      checkRows: { public: [], private: [] },
    });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public", "private"] }));
      expect(connection.linted).toEqual(["public", "private"]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes the linked-project cache for --linked", () => {
    const { layer, projectRef, cache } = setup({ isLocal: false, checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"], linked: true }));
      expect(projectRef.calls).toContain("resolveRef");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("lints the project given via --project-ref, overriding the workdir's own ref", () => {
    // `VALID_REF` stands in for whatever the workdir would resolve to absent the
    // flag; the flag must win.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, cache } = setup({ isLocal: false, checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"], projectRef: Option.some(FLAG_REF) }));
      expect(cache.cached).toBe(true);
      expect(cache.cachedRef).toBe(FLAG_REF);
      expect(cache.cachedRef).not.toBe(VALID_REF);
    }).pipe(Effect.provide(layer));
  });

  it.effect("mints a login role and fills the cache through the real resolver and cache", () => {
    const { layer, http } = setup({
      isLocal: false,
      checkRows: { public: [] },
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbLint(
        flags({ schema: ["public"], linked: true, projectRef: Option.some(VALID_REF) }),
      );
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(http.calls.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET https://api.supabase.com/v1/projects/${VALID_REF}`,
      ]);
      expect(yield* fs.exists(`${tempRoot.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "db lint",
        activeFlags: { linked: true, "project-ref": VALID_REF, schema: true },
        requests: [...asRecordedRequests(requests), ...http.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect(
    "makes no Management API request for --local through the real resolver and cache",
    () => {
      const { layer, http } = setup({ checkRows: { public: [] }, realLayers: true });
      const requests: Array<StubbedRequest> = [];
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* stubManagementApi(requests, () => undefined);
        yield* dbLint(flags({ schema: ["public"], local: true }));
        expect(requests).toEqual([]);
        expect(http.calls).toEqual([]);
        expect(yield* fs.exists(`${tempRoot.current}/supabase/.temp/linked-project.json`)).toBe(
          false,
        );
        assertPermissionDrift({
          command: "db lint",
          activeFlags: { local: true, schema: true },
          requests: [],
          exact: true,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
        provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
      );
    },
  );

  it.effect("defaults to the local target and makes no Management API request", () => {
    const { layer, http } = setup({ checkRows: { public: [] }, realLayers: true });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      yield* stubManagementApi(requests, () => undefined);
      yield* dbLint(flags({ schema: ["public"] }));
      expect(requests).toEqual([]);
      expect(http.calls).toEqual([]);
      assertPermissionDrift({
        command: "db lint",
        activeFlags: { schema: true },
        requests: [],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layer),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("--project-ref alone reaches the linked database through the real resolver", () => {
    const { layer, http } = setup({
      isLocal: false,
      checkRows: { public: [] },
      realLayers: true,
    });
    const requests: Array<StubbedRequest> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* stubManagementApi(requests, serveLinkedDatabase(VALID_REF));
      yield* dbLint(flags({ schema: ["public"], projectRef: Option.some(VALID_REF) }));
      expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
        `GET /v1/projects/${VALID_REF}/config/database/pooler`,
        `POST /v1/projects/${VALID_REF}/cli/login-role`,
      ]);
      expect(yield* fs.exists(`${tempRoot.current}/supabase/.temp/linked-project.json`)).toBe(true);
      assertPermissionDrift({
        command: "db lint",
        activeFlags: { "project-ref": VALID_REF, schema: true },
        requests: [...asRecordedRequests(requests), ...http.calls],
        exact: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(layer, BunServices.layer)),
      provideEnv({ SUPABASE_ACCESS_TOKEN: VALID_TOKEN }),
    );
  });

  it.effect("does not write the linked-project cache for a local run", () => {
    const { layer, cache } = setup({ checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"] }));
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects --project-ref together with --local", () => {
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, connection, cache } = setup({ checkRows: { public: [] } });
    return Effect.gen(function* () {
      const error = yield* dbLint(
        flags({ schema: ["public"], local: true, projectRef: Option.some(FLAG_REF) }),
      ).pipe(Effect.flip);
      expect(error).toBeInstanceOf(TargetProjectRefConflictError);
      expect(connection.execs).toEqual([]);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry on success and on failure", () => {
    const success = setup({ checkRows: { public: [] } });
    const failure = setup({ enableFails: true });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"] })).pipe(Effect.provide(success.layer));
      expect(success.telemetry.flushed).toBe(true);
      yield* Effect.exit(dbLint(flags({ schema: ["public"] })).pipe(Effect.provide(failure.layer)));
      expect(failure.telemetry.flushed).toBe(true);
    });
  });

  it.effect("treats --linked=false as absent and lints the local database", () => {
    const { layer, resolver, cache } = setup({ checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* dbLint(flags({ schema: ["public"], linked: false }));
      expect(resolver.resolveInput?.target.kind).toBe("local");
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("follows a remote workspace target when no selector flag is given", () => {
    const { layer, resolver, cache } = setup({ isLocal: false, checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* withConfigEnv({ SUPABASE_TARGET: "remote" }, dbLint(flags({ schema: ["public"] })));
      expect(resolver.resolveInput?.target.kind).toBe("linked");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });
});
