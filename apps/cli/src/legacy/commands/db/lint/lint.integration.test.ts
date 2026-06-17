import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer, Option } from "effect";

import { mockOutput, mockProcessControl } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type {
  LegacyDbConfigFlags,
  LegacyResolvedDbConfig,
} from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbExecError } from "../../../shared/legacy-db-connection.errors.ts";
import {
  LegacyDbConnection,
  type LegacyPgConnInput,
} from "../../../shared/legacy-db-connection.service.ts";
import { LegacyDbLintFailOnError } from "./lint.errors.ts";
import { encodeLegacyLintResults, parseLegacyLintResult } from "./lint.format.ts";
import { legacyDbLint } from "./lint.handler.ts";
import {
  LEGACY_CHECK_SCHEMA_SCRIPT,
  LEGACY_ENABLE_PGSQL_CHECK,
  LEGACY_LIST_SCHEMAS_SQL,
} from "./lint.lint-sql.ts";
import type { LegacyDbLintFlags } from "./lint.command.ts";

const LOCAL_CONN: LegacyPgConnInput = {
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
  let resolveInput: LegacyDbConfigFlags | undefined;
  const layer = Layer.succeed(LegacyDbConfigResolver, {
    resolve: (flags: LegacyDbConfigFlags) => {
      resolveInput = flags;
      return Effect.succeed({
        conn: LOCAL_CONN,
        isLocal: opts.isLocal ?? true,
      } satisfies LegacyResolvedDbConfig);
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
  const layer = Layer.succeed(LegacyDbConnection, {
    connect: () =>
      Effect.succeed({
        extensionExists: () => Effect.succeed(false),
        copyToCsv: () => Effect.succeed(new Uint8Array()),
        queryRaw: () => Effect.succeed({ fields: [], rows: [], commandTag: "" }),
        // Record at run-time (inside the effect), not call-time, so a finalizer
        // built with `session.exec("rollback")` is logged only when it runs.
        exec: (sql: string) =>
          Effect.suspend(() => {
            execs.push(sql);
            if (sql === LEGACY_ENABLE_PGSQL_CHECK && opts.enableFails === true) {
              return Effect.fail(
                new LegacyDbExecError({
                  message: `ERROR: could not open extension control file (SQLSTATE 58P01)`,
                }),
              );
            }
            return Effect.void;
          }),
        query: (sql: string, params?: ReadonlyArray<unknown>) =>
          Effect.suspend(() => {
            if (sql === LEGACY_LIST_SCHEMAS_SQL) {
              listParams = params;
              if (opts.listFails === true) {
                return Effect.fail(new LegacyDbExecError({ message: "permission denied" }));
              }
              return Effect.succeed((opts.schemas ?? []).map((nspname) => ({ nspname })));
            }
            if (sql === LEGACY_CHECK_SCHEMA_SCRIPT) {
              const schema = String(params?.[0]);
              linted.push(schema);
              if (opts.queryFails === true) {
                return Effect.fail(new LegacyDbExecError({ message: "syntax error" }));
              }
              if (opts.malformed === true) {
                return Effect.succeed([{ proname: "f1", plpgsql_check_function: "malformed" }]);
              }
              return Effect.succeed(opts.checkRows?.[schema] ?? []);
            }
            return Effect.succeed([]);
          }),
      }),
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

/** Project-ref resolver mock. `db lint --linked` resolves the ref via the
 *  non-prompting `loadProjectRef` (Go's `flags.LoadProjectRef`) to write the
 *  linked-project cache; the other methods are unused by lint. */
function mockProjectRef() {
  const calls: Array<string> = [];
  const layer = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () => Effect.succeed(LEGACY_VALID_REF),
    resolveForLink: () => Effect.succeed(LEGACY_VALID_REF),
    resolveOptional: () => Effect.succeed(Option.some(LEGACY_VALID_REF)),
    loadProjectRef: () =>
      Effect.sync(() => {
        calls.push("loadProjectRef");
        return LEGACY_VALID_REF;
      }),
    promptProjectRef: () => Effect.succeed(LEGACY_VALID_REF),
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
  /** Raw CLI args for `CliArgs` — drives DB target selection (Changed-based). */
  args?: ReadonlyArray<string>;
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
  const telemetry = mockLegacyTelemetryStateTracked();
  const processControl = mockProcessControl();
  const projectRef = mockProjectRef();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = Layer.mergeAll(
    out.layer,
    resolver.layer,
    connection.layer,
    telemetry.layer,
    processControl.layer,
    projectRef.layer,
    cache.layer,
    Layer.succeed(LegacyDnsResolverFlag, "native"),
    Layer.succeed(CliArgs, { args: opts.args ?? [] }),
  );
  return { layer, out, resolver, connection, telemetry, processControl, projectRef, cache };
}

const flags = (over: Partial<LegacyDbLintFlags> = {}): LegacyDbLintFlags => ({
  dbUrl: over.dbUrl ?? Option.none<string>(),
  linked: over.linked ?? false,
  local: over.local ?? false,
  schema: over.schema ?? [],
  level: over.level ?? Option.none<"warning" | "error">(),
  failOn: over.failOn ?? Option.none<"none" | "warning" | "error">(),
});

describe("legacy db lint", () => {
  it.live("lints the named schema and prints parsed issues to stdout", () => {
    const { layer, out, connection } = setup({
      schemas: [],
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] },
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      const expected = encodeLegacyLintResults([
        parseLegacyLintResult(JSON.stringify({ issues: [ERROR_ISSUE] }), "public.f1"),
      ]);
      expect(out.stdoutText).toBe(expected);
      expect(out.stderrText).toContain("Connecting to local database...");
      expect(out.stderrText).toContain("Linting schema: public");
      // Begin / enable extension / rollback all ran on the session.
      expect(connection.execs).toEqual(["begin", LEGACY_ENABLE_PGSQL_CHECK, "rollback"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("lints every user schema when --schema is omitted", () => {
    const { layer, out, connection } = setup({
      schemas: ["public", "private"],
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])], private: [] },
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags());
      // ListUserSchemas ran with the managed-schemas array bound as $1.
      expect(Array.isArray(connection.listParams?.[0])).toBe(true);
      expect(connection.linted).toEqual(["public", "private"]);
      expect(out.stderrText).toContain("Linting schema: private");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the plpgsql_check extension cannot be enabled", () => {
    const { layer } = setup({ schemas: [], enableFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbLint(flags({ schema: ["public"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to enable pgsql_check");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on malformed plpgsql_check json", () => {
    const { layer } = setup({ malformed: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbLint(flags({ schema: ["public"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to marshal json");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a query failure from plpgsql_check", () => {
    const { layer } = setup({ queryFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbLint(flags({ schema: ["public"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to query rows");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("surfaces a list-schemas failure", () => {
    const { layer } = setup({ listFails: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbLint(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("failed to list schemas");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("prints 'No schema errors found' to stderr and nothing to stdout when clean", () => {
    const { layer, out } = setup({ checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).toContain("\nNo schema errors found");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits nothing on stdout when all issues are below --level (no clean message)", () => {
    const { layer, out } = setup({ checkRows: { public: [checkRow("f1", [WARNING_ISSUE])] } });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"], level: Option.some("error") }));
      expect(out.stdoutText).toBe("");
      expect(out.stderrText).not.toContain("No schema errors found");
    }).pipe(Effect.provide(layer));
  });

  it.live("exits non-zero when --fail-on warning and a warning exists", () => {
    const { layer, out } = setup({ checkRows: { public: [checkRow("f1", [WARNING_ISSUE])] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbLint(flags({ schema: ["public"], failOn: Option.some("warning") })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const failure = Cause.findErrorOption(exit.cause);
        expect(Option.isSome(failure)).toBe(true);
        if (Option.isSome(failure)) {
          expect(failure.value).toBeInstanceOf(LegacyDbLintFailOnError);
          expect((failure.value as LegacyDbLintFailOnError).message).toBe(
            "fail-on is set to warning, non-zero exit",
          );
        }
      }
      // The result is still printed to stdout before the non-zero exit.
      expect(out.stdoutText).toContain("never read variable");
    }).pipe(Effect.provide(layer));
  });

  it.live("exits non-zero when --fail-on error and an error exists", () => {
    const { layer } = setup({ checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbLint(flags({ schema: ["public"], failOn: Option.some("error") })),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("fail-on is set to error, non-zero exit");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("does not exit non-zero when --fail-on is none", () => {
    const { layer } = setup({ checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbLint(flags({ schema: ["public"] })));
      expect(Exit.isSuccess(exit)).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("does not trigger --fail-on warning when --level error filters the warning out", () => {
    // Go filters by --level before the fail-on check (lint.go:62-76), so a
    // warning removed by --level error cannot trigger --fail-on warning.
    const { layer, out } = setup({ checkRows: { public: [checkRow("f1", [WARNING_ISSUE])] } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbLint(
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

  it.live("rejects --db-url together with --linked (via args Changed detection)", () => {
    // Both flags present in args → mutual exclusion error (sorted set [db-url linked]).
    const { layer } = setup({ args: ["--db-url=postgres://x", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbLint(flags({ dbUrl: Option.some("postgres://x") })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "if any flags in the group [db-url linked local] are set none of the others can be",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a standard success envelope in json mode", () => {
    const { layer, out } = setup({
      format: "json",
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] },
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
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

  it.live("emits an empty result envelope in json mode when clean", () => {
    const { layer, out } = setup({ format: "json", checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db lint", data: { results: [] } }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event in stream-json mode", () => {
    const { layer, out } = setup({
      format: "stream-json",
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] },
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "db lint" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("sets exit code 1 without failing the effect on fail-on in json mode", () => {
    const { layer, processControl } = setup({
      format: "json",
      checkRows: { public: [checkRow("f1", [ERROR_ISSUE])] },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyDbLint(flags({ schema: ["public"], failOn: Option.some("error") })),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(processControl.exitCode).toBe(1);
    }).pipe(Effect.provide(layer));
  });

  it.live("labels the diagnostic 'remote' for a non-local connection", () => {
    const { layer, out } = setup({
      isLocal: false,
      checkRows: { public: [] },
      args: ["--db-url=postgres://x"],
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"], dbUrl: Option.some("postgres://x") }));
      expect(out.stderrText).toContain("Connecting to remote database...");
    }).pipe(Effect.provide(layer));
  });

  it.live("lints multiple pre-parsed schemas from a comma-separated --schema value", () => {
    // CSV parsing of `public,private` into ["public", "private"] now happens at
    // Flag.mapTryCatch parse time (before the handler). The handler receives the
    // already-split list and uses it directly.
    const { layer, connection } = setup({
      checkRows: { public: [], private: [] },
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public", "private"] }));
      // Both schemas linted — the handler no longer does CSV splitting itself.
      expect(connection.linted).toEqual(["public", "private"]);
    }).pipe(Effect.provide(layer));
  });

  it.live("writes the linked-project cache for --linked (Go PersistentPostRun)", () => {
    // --linked via args (Changed-based detection) routes to the linked branch and
    // writes the linked-project cache.
    const { layer, projectRef, cache } = setup({
      isLocal: false,
      checkRows: { public: [] },
      args: ["--linked"],
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      // Resolved via the non-prompting load and cached for telemetry grouping.
      expect(projectRef.calls).toContain("loadProjectRef");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("does not write the linked-project cache for a local run", () => {
    const { layer, cache } = setup({ checkRows: { public: [] } });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      // Go's ensureProjectGroupsCached no-ops when flags.ProjectRef is empty.
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry on success and on failure", () => {
    const success = setup({ checkRows: { public: [] } });
    const failure = setup({ enableFails: true });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] })).pipe(Effect.provide(success.layer));
      expect(success.telemetry.flushed).toBe(true);
      yield* Effect.exit(
        legacyDbLint(flags({ schema: ["public"] })).pipe(Effect.provide(failure.layer)),
      );
      expect(failure.telemetry.flushed).toBe(true);
    });
  });

  // ── Changed-based routing parity (Go pflag.Changed semantics) ────────────

  it.live("--linked=false routes to the linked branch (Changed, not value)", () => {
    // cobra's Changed fires when the flag appears on the command line regardless
    // of its value: `--linked=false` is still "explicitly set" → linked branch.
    const { layer, projectRef, cache } = setup({
      isLocal: false,
      checkRows: { public: [] },
      args: ["db", "lint", "--linked=false"],
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      expect(projectRef.calls).toContain("loadProjectRef");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("--no-linked routes to the linked branch (boolean negation is still Changed)", () => {
    const { layer, projectRef, cache } = setup({
      isLocal: false,
      checkRows: { public: [] },
      args: ["--no-linked"],
    });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      expect(projectRef.calls).toContain("loadProjectRef");
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("--local=false --linked fails with mutual-exclusion (sorted set [linked local])", () => {
    // Both flags are Changed → mutual exclusion fires with cobra's sorted set.
    const { layer } = setup({ args: ["--local=false", "--linked"] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyDbLint(flags({ schema: ["public"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "if any flags in the group [db-url linked local] are set none of the others can be; [linked local] were all set",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("--local=false alone routes to the local branch (Changed local, connType=local)", () => {
    // `--local=false` is Changed for `local` → connType="local" (Changed-first: local).
    const { layer, out, cache } = setup({ checkRows: { public: [] }, args: ["--local=false"] });
    return Effect.gen(function* () {
      yield* legacyDbLint(flags({ schema: ["public"] }));
      // Routes to local → "Connecting to local database..."
      expect(out.stderrText).toContain("Connecting to local database...");
      // No linked-project cache for local runs.
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
