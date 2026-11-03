import { Effect } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { renderReportText } from "../../../output/report-render-text.ts";
import type { Report } from "../../../output/report.types.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { resolveInspectConnection, type InspectConnectionFlags } from "./inspect-query.ts";

/** A report-producing `inspect db` subcommand: its version-specific SQL and a pure rows-to-`Report` mapping. */
export interface InspectReportSpec {
  readonly name: string;
  readonly sql: (serverVersionNum: number) => string;
  readonly report: (rows: ReadonlyArray<Record<string, unknown>>) => Report;
}

const runInspectReport = Effect.fn("Inspect.runReport")(function* (
  spec: InspectReportSpec,
  flags: InspectConnectionFlags,
  dnsResolver: "native" | "https",
) {
  const output = yield* Output;
  const dbConn = yield* DbConnection;
  const cfg = yield* resolveInspectConnection(flags, dnsResolver);

  const rows = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      const [version] = yield* session.query(
        "SELECT current_setting('server_version_num')::int AS server_version_num",
        [],
      );
      return yield* session.query(spec.sql(Number(version?.["server_version_num"])), []);
    }),
  );
  yield* Effect.annotateCurrentSpan({ "query.row_count": rows.length });

  const report = spec.report(rows);

  if (output.format === "text") {
    yield* output.raw(renderReportText(report));
    return;
  }

  // `rows` keeps the payload shape of the table-based inspect commands.
  yield* output.success(`inspect db ${spec.name}`, { rows, report });
});

/**
 * Builds an `inspect db <name>` handler from a report spec. It flushes
 * telemetry itself, like `makeInspectDbHandler`.
 */
export function makeInspectDbReportHandler(spec: InspectReportSpec, traceName: string) {
  return Effect.fn(traceName)(function* (flags: InspectConnectionFlags) {
    const dnsResolver = yield* DnsResolverFlag;
    const telemetryState = yield* TelemetryState;
    yield* runInspectReport(spec, flags, dnsResolver).pipe(Effect.ensuring(telemetryState.flush));
  });
}
