import { Effect, Option } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { hostedMutationPreapproval } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../shared/runtime/process-control.service.ts";
import { failsOn } from "../../../command-internal/fail-on.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import type { DbSession } from "../../../command-internal/db-connection.service.ts";
import { LinkedProjectCache } from "../../../telemetry/linked-project-cache.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import type { DbLintFlags } from "./lint.command.ts";
import {
  DbLintBeginTxError,
  DbLintEnableCheckError,
  DbLintFailOnError,
  DbLintListSchemasError,
  DbLintMalformedJsonError,
  DbLintQueryError,
} from "./lint.errors.ts";
import {
  encodeLintResults,
  filterLintResult,
  LINT_ALLOWED_LEVELS,
  LINT_LEVEL_ENUM,
  type LintResult,
  parseLintResult,
} from "./lint.format.ts";
import {
  CHECK_SCHEMA_SCRIPT,
  ENABLE_PGSQL_CHECK,
  LIST_SCHEMAS_SQL,
  MANAGED_SCHEMAS,
} from "./lint.lint-sql.ts";

const asString = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

/** Lists the user schemas — used when `--schema` is omitted. */
const listUserSchemas = Effect.fn("DbLint.listUserSchemas")(function* (session: DbSession) {
  const rows = yield* session
    .query(LIST_SCHEMAS_SQL, [MANAGED_SCHEMAS])
    .pipe(
      Effect.mapError(
        (cause) =>
          new DbLintListSchemasError({ message: `failed to list schemas: ${cause.message}` }),
      ),
    );
  return rows.map((row) => asString(row["nspname"]));
});

/** Runs the pgsql_check-based lint, minus the transaction setup the handler owns. */
const lintDatabase = Effect.fn("DbLint.lintDatabase")(function* (
  session: DbSession,
  schemaFlags: ReadonlyArray<string>,
) {
  const output = yield* Output;
  const schemas = schemaFlags.length > 0 ? schemaFlags : yield* listUserSchemas(session);
  yield* Effect.annotateCurrentSpan({ "schema.count": schemas.length });

  yield* session.exec(ENABLE_PGSQL_CHECK).pipe(
    Effect.mapError(
      (cause) =>
        new DbLintEnableCheckError({
          message: `failed to enable pgsql_check: ${cause.message}`,
        }),
    ),
  );

  const results: Array<LintResult> = [];
  for (const schema of schemas) {
    yield* output.raw(`Linting schema: ${schema}\n`, "stderr");
    const rows = yield* session
      .query(CHECK_SCHEMA_SCRIPT, [schema])
      .pipe(
        Effect.mapError(
          (cause) => new DbLintQueryError({ message: `failed to query rows: ${cause.message}` }),
        ),
      );
    for (const row of rows) {
      const name = asString(row["proname"]);
      const data = asString(row["plpgsql_check_function"]);
      const result = yield* Effect.try({
        try: () => parseLintResult(data, `${schema}.${name}`),
        catch: (cause) =>
          new DbLintMalformedJsonError({
            message: `failed to parse lint result: ${String(cause)}`,
          }),
      });
      results.push(result);
    }
  }
  return results;
});

const runLint = Effect.fnUntraced(function* (flags: DbLintFlags, dnsResolver: "native" | "https") {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;
  const processControl = yield* ProcessControl;

  const target = yield* resolveTarget({
    local: flags.local,
    linked: flags.linked,
    dbUrl: flags.dbUrl,
    projectRef: flags.projectRef,
  });

  const level = Option.getOrElse(flags.level, () => "warning");
  const failOn = Option.getOrElse(flags.failOn, () => "none");

  // `flags.schema` is already CSV-parsed and validated by
  // `Flag.mapTryCatch(parseSchemaFlags)` at the command definition.
  const schemaFlags = flags.schema;

  const lintBody = Effect.gen(function* () {
    const cfg = yield* resolver.resolveConnection({
      target,
      dnsResolver,
      password: Option.none(),
      networkBanRemoval: yield* hostedMutationPreapproval,
    });

    yield* Effect.annotateCurrentSpan({
      "db.is_local": cfg.isLocal,
      "db.lint.level": level,
      "db.lint.fail_on": failOn,
    });

    const results = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
        yield* session.exec("begin").pipe(
          Effect.mapError(
            (cause) =>
              new DbLintBeginTxError({
                message: `failed to begin transaction: ${cause.message}`,
              }),
          ),
        );
        // Lint never commits — always roll back. A rollback failure is
        // printed to stderr, not fatal.
        return yield* lintDatabase(session, schemaFlags).pipe(
          Effect.ensuring(
            session
              .exec("rollback")
              .pipe(Effect.catch((cause) => output.raw(`${cause.message}\n`, "stderr"))),
          ),
        );
      }),
    );

    // Printed when the raw result (before level filtering) is empty; stdout stays
    // payload-only, so machine modes additionally emit the empty result envelope.
    if (results.length === 0) {
      yield* output.raw("\nNo schema errors found\n", "stderr");
      if (output.format !== "text") {
        yield* output.success("db lint", { results: [] });
      }
      return;
    }

    const filtered = filterLintResult(results, LINT_LEVEL_ENUM.toEnum(level));
    yield* Effect.annotateCurrentSpan({ "db.lint.issue_count": filtered.length });

    if (output.format === "text") {
      // Encoding no-ops on an empty slice.
      if (filtered.length > 0) yield* output.raw(encodeLintResults(filtered));
    } else {
      yield* output.success("db lint", { results: filtered });
    }

    const failOnLevel = LINT_LEVEL_ENUM.toEnum(failOn);
    const failed = failsOn(
      filtered.flatMap((result) => result.issues),
      (issue) => issue.level,
      failOnLevel,
      LINT_LEVEL_ENUM,
    );
    if (failed) {
      const message = `fail-on is set to ${LINT_ALLOWED_LEVELS[failOnLevel]}, non-zero exit`;
      if (output.format === "text") {
        return yield* new DbLintFailOnError({ message });
      }
      // json / stream-json already emitted the result payload above; signal the
      // non-zero exit without a second stdout write that would corrupt it.
      yield* processControl.setExitCode(1);
    }
  });

  // The linked-project cache is refreshed on success and failure; local and `--db-url` targets
  // never write it.
  if (target.kind === "linked") {
    const linkedProjectCache = yield* LinkedProjectCache;
    return yield* lintBody.pipe(Effect.ensuring(linkedProjectCache.cache(target.ref)));
  }
  return yield* lintBody;
});

export const dbLint = Effect.fn("db.lint")(function* (flags: DbLintFlags) {
  const dnsResolver = yield* DnsResolverFlag;
  const telemetryState = yield* TelemetryState;
  // Command-level instrumentation/JSON error handling are applied by `lint.command.ts`.
  yield* runLint(flags, dnsResolver).pipe(Effect.ensuring(telemetryState.flush));
});
