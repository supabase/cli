import { Effect, Option } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { ProcessControl } from "../../../../shared/runtime/process-control.service.ts";
import { LegacyProjectRefResolver } from "../../../config/legacy-project-ref.service.ts";
import { legacyFailsOn } from "../../../shared/legacy-fail-on.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import type { LegacyDbSession } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyLinkedProjectCache } from "../../../telemetry/legacy-linked-project-cache.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import type { LegacyDbTargetSelection } from "../../../shared/legacy-db-target-flags.ts";
import type { LegacyDbLintFlags } from "./lint.command.ts";
import {
  LegacyDbLintBeginTxError,
  LegacyDbLintEnableCheckError,
  LegacyDbLintFailOnError,
  LegacyDbLintListSchemasError,
  LegacyDbLintMalformedJsonError,
  LegacyDbLintMutuallyExclusiveFlagsError,
  LegacyDbLintQueryError,
} from "./lint.errors.ts";
import {
  encodeLegacyLintResults,
  filterLegacyLintResult,
  LEGACY_LINT_ALLOWED_LEVELS,
  LEGACY_LINT_LEVEL_ENUM,
  type LegacyLintResult,
  parseLegacyLintResult,
} from "./lint.format.ts";
import {
  LEGACY_CHECK_SCHEMA_SCRIPT,
  LEGACY_ENABLE_PGSQL_CHECK,
  LEGACY_LIST_SCHEMAS_SQL,
  LEGACY_MANAGED_SCHEMAS,
} from "./lint.lint-sql.ts";

const asString = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

/** Lists the user schemas — used when `--schema` is omitted. */
const listUserSchemas = Effect.fnUntraced(function* (session: LegacyDbSession) {
  const rows = yield* session
    .query(LEGACY_LIST_SCHEMAS_SQL, [LEGACY_MANAGED_SCHEMAS])
    .pipe(
      Effect.mapError(
        (cause) =>
          new LegacyDbLintListSchemasError({ message: `failed to list schemas: ${cause.message}` }),
      ),
    );
  return rows.map((row) => asString(row["nspname"]));
});

/** Runs the pgsql_check-based lint, minus the transaction setup the handler owns. */
const lintDatabase = Effect.fnUntraced(function* (
  session: LegacyDbSession,
  schemaFlags: ReadonlyArray<string>,
) {
  const output = yield* Output;
  const schemas = schemaFlags.length > 0 ? schemaFlags : yield* listUserSchemas(session);

  yield* session.exec(LEGACY_ENABLE_PGSQL_CHECK).pipe(
    Effect.mapError(
      (cause) =>
        new LegacyDbLintEnableCheckError({
          message: `failed to enable pgsql_check: ${cause.message}`,
        }),
    ),
  );

  const results: Array<LegacyLintResult> = [];
  for (const schema of schemas) {
    yield* output.raw(`Linting schema: ${schema}\n`, "stderr");
    const rows = yield* session
      .query(LEGACY_CHECK_SCHEMA_SCRIPT, [schema])
      .pipe(
        Effect.mapError(
          (cause) =>
            new LegacyDbLintQueryError({ message: `failed to query rows: ${cause.message}` }),
        ),
      );
    for (const row of rows) {
      const name = asString(row["proname"]);
      const data = asString(row["plpgsql_check_function"]);
      const result = yield* Effect.try({
        try: () => parseLegacyLintResult(data, `${schema}.${name}`),
        catch: (cause) =>
          new LegacyDbLintMalformedJsonError({
            message: `failed to marshal json: ${String(cause)}`,
          }),
      });
      results.push(result);
    }
  }
  return results;
});

const runLint = Effect.fnUntraced(function* (
  flags: LegacyDbLintFlags,
  dnsResolver: "native" | "https",
  target: LegacyDbTargetSelection,
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const processControl = yield* ProcessControl;

  // Mutually-exclusive db-url/linked/local group, keyed off the
  // explicitly-set flags, not the `--local` default value.
  const setFlags = target.setFlags;
  if (setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyDbLintMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const level = Option.getOrElse(flags.level, () => "warning");
  const failOn = Option.getOrElse(flags.failOn, () => "none");

  // `--schema` is a CSV string-slice value, split at parse time. The command
  // definition applies `Flag.mapTryCatch(legacyParseSchemaFlags)` so
  // `flags.schema` is already the fully CSV-parsed and validated schema list.
  const schemaFlags = flags.schema;

  const lintBody = Effect.gen(function* () {
    // The resolver applies the established precedence (db-url > linked >
    // local-default), so the connType passes straight through — `--local`'s
    // default is handled by the resolver's fall-through to the local branch.
    const cfg = yield* resolver.resolve({
      dbUrl: flags.dbUrl,
      connType: target.connType ?? "local",
      dnsResolver,
    });

    const results = yield* Effect.scoped(
      Effect.gen(function* () {
        yield* output.raw(
          `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
          "stderr",
        );
        const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
        yield* session.exec("begin").pipe(
          Effect.mapError(
            (cause) =>
              new LegacyDbLintBeginTxError({
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

    // "\nNo schema errors found" is printed to stderr when the RAW result is
    // empty (before level filtering), and nothing is emitted on stdout. The
    // diagnostic goes to stderr in every mode (stdout stays payload-only);
    // machine modes additionally emit the empty result envelope.
    if (results.length === 0) {
      yield* output.raw("\nNo schema errors found\n", "stderr");
      if (output.format !== "text") {
        yield* output.success("db lint", { results: [] });
      }
      return;
    }

    const filtered = filterLegacyLintResult(results, LEGACY_LINT_LEVEL_ENUM.toEnum(level));

    if (output.format === "text") {
      // Encoding no-ops on an empty slice.
      if (filtered.length > 0) yield* output.raw(encodeLegacyLintResults(filtered));
    } else {
      yield* output.success("db lint", { results: filtered });
    }

    const failOnLevel = LEGACY_LINT_LEVEL_ENUM.toEnum(failOn);
    const failed = legacyFailsOn(
      filtered.flatMap((result) => result.issues),
      (issue) => issue.level,
      failOnLevel,
      LEGACY_LINT_LEVEL_ENUM,
    );
    if (failed) {
      const message = `fail-on is set to ${LEGACY_LINT_ALLOWED_LEVELS[failOnLevel]}, non-zero exit`;
      if (output.format === "text") {
        return yield* Effect.fail(new LegacyDbLintFailOnError({ message }));
      }
      // json / stream-json already emitted the result payload above; signal the
      // non-zero exit without a second stdout write that would corrupt it.
      yield* processControl.setExitCode(1);
    }
  });

  // For `--linked`, the project ref is resolved and the linked-project cache
  // is refreshed afterward, writing supabase/.temp/linked-project.json so
  // telemetry carries the project/org grouping. Resolve the ref up front
  // (non-prompting) and write the cache on success and failure. `--local` /
  // `--db-url` leave the ref empty, so its cache write no-ops — we match that
  // by caching only on the linked branch.
  if (target.connType === "linked") {
    const projectRef = yield* LegacyProjectRefResolver;
    const linkedProjectCache = yield* LegacyLinkedProjectCache;
    const ref = yield* projectRef.loadProjectRef(Option.none());
    return yield* lintBody.pipe(Effect.ensuring(linkedProjectCache.cache(ref)));
  }
  return yield* lintBody;
});

export const legacyDbLint = Effect.fn("legacy.db.lint")(function* (flags: LegacyDbLintFlags) {
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const telemetryState = yield* LegacyTelemetryState;
  const cliArgs = yield* CliArgs;
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  // Flush telemetry on success and failure. Command-level instrumentation /
  // JSON error handling are applied by `lint.command.ts` (the codebase convention).
  yield* runLint(flags, dnsResolver, target).pipe(Effect.ensuring(telemetryState.flush));
});
