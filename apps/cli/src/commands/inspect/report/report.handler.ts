import { Clock, Effect, FileSystem, Option, Path } from "effect";

import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../../shared/runtime/tty.service.ts";
import { CommandSettings } from "../../../config/command-settings.service.ts";
import { bold } from "../../../output/bold.ts";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { resolveDbTargetFlags } from "../../../command-internal/db-target-flags.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";
import { InspectMutuallyExclusiveFlagsError } from "../db/inspect-query.ts";
import type { InspectReportFlags } from "./report.command.ts";
import { type CsvTable, type CsvTableProvider, parseReportCsv } from "./report.csvq.ts";
import { readInspectRules } from "./report.config.ts";
import { InspectReportMkdirError, InspectReportWriteError } from "./report.errors.ts";
import { REPORT_QUERIES, reportIgnoreSchemas, wrapReportQuery } from "./report.queries.ts";
import {
  DEFAULT_INSPECT_RULES,
  buildRuleSummaryRows,
  evaluateInspectRule,
} from "./report.rules.ts";

/** Local-time `YYYY-MM-DD`, the report's dated output folder format. */
function reportDateFolder(epochMillis: number): string {
  const date = new Date(epochMillis);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * `supabase inspect report` — runs every inspect query and writes one CSV per
 * query into `<output-dir>/<YYYY-MM-DD>/`, then prints a Glamour "rules" summary
 * table validating those CSVs.
 *
 * Telemetry is flushed on success and failure; the
 * command-level wrapper adds the `cli_command_executed` instrumentation and the
 * machine-format JSON error envelope.
 */
export const inspectReport = Effect.fn("inspect.report")(function* (flags: InspectReportFlags) {
  const dnsResolver = yield* DnsResolverFlag;
  const telemetryState = yield* TelemetryState;
  yield* runInspectReport(flags, dnsResolver).pipe(Effect.ensuring(telemetryState.flush));
});

const runInspectReport = Effect.fnUntraced(function* (
  flags: InspectReportFlags,
  dnsResolver: "native" | "https",
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;
  const cliSettings = yield* CommandSettings;
  const runtimeInfo = yield* RuntimeInfo;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliArgs = yield* CliArgs;
  const isText = output.format === "text";

  // Mutual exclusivity is keyed off raw argv, not the parsed boolean value: `--local=false`
  // was explicitly passed, so value-based detection would miss it and default to linked.
  const target = resolveDbTargetFlags(cliArgs.args);
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new InspectMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  // Validated before any DB work so a malformed config aborts before connecting or writing
  // CSVs; applied later in the summary rendering below.
  const configRules = yield* readInspectRules(fs, path, cliSettings.workdir);

  // `--linked` is the default, so absence of the others resolves to linked.
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

  // Resolved against the process CWD when relative, not `--workdir`.
  const epochMillis = yield* Clock.currentTimeMillis;
  let outDir = path.join(flags.outputDir, reportDateFolder(epochMillis));
  if (!path.isAbsolute(outDir)) {
    outDir = path.join(runtimeInfo.cwd, outDir);
  }
  yield* fs
    .makeDirectory(outDir, { recursive: true, mode: 0o755 })
    .pipe(
      Effect.mapError(
        (error) => new InspectReportMkdirError({ message: `failed to mkdir: ${error}` }),
      ),
    );

  if (isText) {
    yield* output.raw(`Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`, "stderr");
  }

  const ignoreSchemas = reportIgnoreSchemas();
  const dbLiteral = `'${cfg.conn.database}'`;
  const csvByFile = new Map<string, Uint8Array>();
  const files: Array<{ readonly name: string; readonly path: string }> = [];

  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      if (isText) yield* output.raw("Running queries...\n", "stderr");
      for (const { fileName, sql } of REPORT_QUERIES) {
        const bytes = yield* session.copyToCsv(wrapReportQuery(sql, ignoreSchemas, dbLiteral));
        const filePath = path.join(outDir, `${fileName}.csv`);
        yield* fs.writeFile(filePath, bytes, { mode: 0o644 }).pipe(
          Effect.mapError(
            (error) =>
              new InspectReportWriteError({
                message: `failed to create output file: ${error}`,
              }),
          ),
        );
        csvByFile.set(`${fileName}.csv`, bytes);
        files.push({ name: fileName, path: filePath });
      }
    }),
  );

  if (isText) {
    yield* output.raw(`Reports saved to ${bold(outDir, tty.stdoutIsTty)}\n`, "stderr");
  }

  // Custom rules (validated above) replace the defaults when present.
  const rules = configRules.length > 0 ? configRules : DEFAULT_INSPECT_RULES;
  if (configRules.length === 0 && isText) {
    yield* output.raw("Loading default rules...\n", "stderr");
  }

  const tableCache = new Map<string, CsvTable | undefined>();
  const provider: CsvTableProvider = (name) => {
    if (!tableCache.has(name)) {
      const bytes = csvByFile.get(name);
      tableCache.set(name, bytes === undefined ? undefined : parseReportCsv(bytes));
    }
    return tableCache.get(name);
  };
  const results = rules.map((rule) => evaluateInspectRule(rule, provider));

  if (isText) {
    yield* output.raw(
      renderGlamourTable(["RULE", "STATUS", "MATCHES"], buildRuleSummaryRows(results)),
    );
    return;
  }

  // json / stream-json. CSVs are still written.
  yield* output.success("inspect report", { outputDir: outDir, files, rules: results });
});
