import { Effect, Option } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../shared/legacy/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { renderReportText } from "../../../output/report-render-text.ts";
import type { Report } from "../../../output/report.types.ts";
import { LegacyDbConfigResolver } from "../../../command-internal/legacy-db-config.service.ts";
import type { LegacyResolvedDbConfig } from "../../../command-internal/legacy-db-config.types.ts";
import { LegacyDbConnection } from "../../../command-internal/legacy-db-connection.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../command-internal/legacy-db-target-flags.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import {
  LegacyInspectMutuallyExclusiveFlagsError,
  type LegacyInspectConnectionFlags,
  type LegacyInspectQuerySpec,
} from "./legacy-inspect-query.ts";

/**
 * A report-producing `inspect db` subcommand: the SQL it runs, the query
 * parameters, and how the result rows become a structured `Report` document.
 *
 * `report` is pure — rows in, document out — so a command's entire output
 * logic is unit-testable without a database.
 */
export interface LegacyInspectReportSpec {
  readonly name: string;
  readonly sql: string;
  readonly params: (cfg: LegacyResolvedDbConfig) => ReadonlyArray<unknown>;
  readonly report: (
    rows: ReadonlyArray<Record<string, unknown>>,
    cfg: LegacyResolvedDbConfig,
  ) => Report;
}

/**
 * Runs a report-producing subcommand.
 *
 * The connection-selection half (flag exclusivity keyed off raw argv, the
 * `--project-ref` guard, the stderr connect line) intentionally mirrors
 * `legacyRunInspectQuery` line for line. The two are kept separate for now so
 * this change cannot affect the 25 shipped table commands; unifying them by
 * extracting the shared prologue is the follow-up once the report path has
 * proven itself (design doc, Phase 2).
 */
export const legacyRunInspectReport = Effect.fnUntraced(function* (
  spec: LegacyInspectReportSpec,
  flags: LegacyInspectConnectionFlags,
  dnsResolver: "native" | "https",
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const cliArgs = yield* CliArgs;

  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyInspectMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const connType = target.connType ?? "linked";

  if (Option.isSome(flags.projectRef) && connType !== "linked") {
    return yield* Effect.fail(
      new LegacyInspectMutuallyExclusiveFlagsError({
        message:
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
      }),
    );
  }

  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType,
    dnsResolver,
    linkedProjectRef: flags.projectRef,
  });

  const rows = yield* Effect.scoped(
    Effect.gen(function* () {
      yield* output.raw(
        `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
        "stderr",
      );
      const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      return yield* session.query(spec.sql, spec.params(cfg));
    }),
  );

  const report = spec.report(rows, cfg);

  if (output.format === "text") {
    yield* output.raw(renderReportText(report));
    return;
  }

  // json / stream-json — the raw driver rows keep the pre-report payload shape
  // for scripts, and the document rides alongside them. This is the
  // compatibility answer from the design doc: no existing `{ rows }` consumer
  // breaks when a command moves to the report path.
  yield* output.success(`inspect db ${spec.name}`, { rows, report });
});

/**
 * Builds an `inspect db <name>` handler from a report spec. Trace-span and
 * telemetry-flush behavior matches `legacyMakeInspectDbHandler` — callers must
 * NOT add a second `Effect.ensuring(flush)` at the command level.
 */
export function legacyMakeInspectDbReportHandler(spec: LegacyInspectReportSpec, traceName: string) {
  return Effect.fn(traceName)(function* (flags: LegacyInspectConnectionFlags) {
    const dnsResolver = yield* LegacyDnsResolverFlag;
    const telemetryState = yield* LegacyTelemetryState;
    yield* legacyRunInspectReport(spec, flags, dnsResolver).pipe(
      Effect.ensuring(telemetryState.flush),
    );
  });
}

/**
 * Lifts a table spec into the report model: one table block, no severity.
 * In text mode the output is byte-identical (same headers, same projected
 * cells, same renderer), which is what makes flipping the existing commands a
 * mechanical, zero-behavior-change migration.
 */
export function reportSpecFromTableSpec(spec: LegacyInspectQuerySpec): LegacyInspectReportSpec {
  return {
    name: spec.name,
    sql: spec.sql,
    params: spec.params,
    report: (rows, cfg) => ({
      command: spec.name,
      severity: "info",
      blocks: [
        {
          kind: "table",
          columns: spec.headers.map((title) => ({ title })),
          rows: rows.map((row) => ({ cells: spec.project(row, cfg) })),
        },
      ],
    }),
  };
}
