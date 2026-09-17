import { Effect, Option } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { renderReportText } from "../../../output/report-render-text.ts";
import type { Report } from "../../../output/report.types.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  InspectMutuallyExclusiveFlagsError,
  type InspectConnectionFlags,
  type InspectQuerySpec,
} from "./inspect-query.ts";

/**
 * A report-producing `inspect db` subcommand: the SQL it runs, the query
 * parameters, and how the result rows become a structured `Report` document.
 *
 * `report` is pure — rows in, document out — so a command's entire output
 * logic is unit-testable without a database.
 */
export interface InspectReportSpec {
  readonly name: string;
  readonly sql: string;
  readonly params: (cfg: ResolvedDbConfig) => ReadonlyArray<unknown>;
  readonly report: (rows: ReadonlyArray<Record<string, unknown>>, cfg: ResolvedDbConfig) => Report;
}

/**
 * Runs a report-producing subcommand.
 *
 * The connection-selection half (flag exclusivity keyed off raw argv, the
 * `--project-ref` guard, the stderr connect line) intentionally mirrors
 * `runInspectQuery` line for line. The two are kept separate for now so
 * this change cannot affect the 25 shipped table commands; unifying them by
 * extracting the shared prologue is the follow-up once the report path has
 * proven itself (design doc, Phase 2).
 */
export const runInspectReport = Effect.fnUntraced(function* (
  spec: InspectReportSpec,
  flags: InspectConnectionFlags,
  dnsResolver: "native" | "https",
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;
  const cliArgs = yield* CliArgs;

  const target = resolveDbTargetFlags(cliArgs.args);
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new InspectMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  const connType = target.connType ?? "linked";

  if (Option.isSome(flags.projectRef) && connType !== "linked") {
    return yield* Effect.fail(
      new InspectMutuallyExclusiveFlagsError({
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
 * telemetry-flush behavior matches `makeInspectDbHandler` — callers must
 * NOT add a second `Effect.ensuring(flush)` at the command level.
 */
export function makeInspectDbReportHandler(spec: InspectReportSpec, traceName: string) {
  return Effect.fn(traceName)(function* (flags: InspectConnectionFlags) {
    const dnsResolver = yield* DnsResolverFlag;
    const telemetryState = yield* TelemetryState;
    yield* runInspectReport(spec, flags, dnsResolver).pipe(Effect.ensuring(telemetryState.flush));
  });
}

/**
 * Lifts a table spec into the report model: one table block, no severity.
 * In text mode the output is byte-identical (same headers, same projected
 * cells, same renderer), which is what makes flipping the existing commands a
 * mechanical, zero-behavior-change migration.
 */
export function reportSpecFromTableSpec(spec: InspectQuerySpec): InspectReportSpec {
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
