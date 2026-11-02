import { Effect, Option } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { renderReportText } from "../../../output/report-render-text.ts";
import type { Report } from "../../../output/report.types.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import {
  InspectMutuallyExclusiveFlagsError,
  type InspectConnectionFlags,
} from "./inspect-query.ts";

/** A report-producing `inspect db` subcommand: its SQL and a pure rows-to-`Report` mapping. */
export interface InspectReportSpec {
  readonly name: string;
  readonly sql: string;
  readonly report: (rows: ReadonlyArray<Record<string, unknown>>) => Report;
}

/** Connection selection mirrors `runInspectQuery`; keep the two in sync. */
const runInspectReport = Effect.fnUntraced(function* (
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
    return yield* new InspectMutuallyExclusiveFlagsError({
      message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
    });
  }

  const connType = target.connType ?? "linked";

  if (Option.isSome(flags.projectRef) && connType !== "linked") {
    return yield* new InspectMutuallyExclusiveFlagsError({
      message:
        "--project-ref only applies when targeting the linked project; use it with --linked (not --local or --db-url)",
    });
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
      return yield* session.query(spec.sql, []);
    }),
  );

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
