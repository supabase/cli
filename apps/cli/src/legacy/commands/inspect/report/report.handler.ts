import { Clock, Effect, FileSystem, Path } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { RuntimeInfo } from "../../../../shared/runtime/runtime-info.service.ts";
import { Tty } from "../../../../shared/runtime/tty.service.ts";
import { LegacyCliConfig } from "../../../config/legacy-cli-config.service.ts";
import { legacyBold } from "../../../output/legacy-bold.ts";
import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";
import { LegacyInspectMutuallyExclusiveFlagsError } from "../db/legacy-inspect-query.ts";
import type { LegacyInspectReportFlags } from "./report.command.ts";
import {
  type LegacyCsvTable,
  type LegacyCsvTableProvider,
  legacyParseReportCsv,
} from "./report.csvq.ts";
import { legacyReadInspectRules } from "./report.config.ts";
import { LegacyInspectReportMkdirError, LegacyInspectReportWriteError } from "./report.errors.ts";
import {
  LEGACY_REPORT_QUERIES,
  legacyReportIgnoreSchemas,
  legacyWrapReportQuery,
} from "./report.queries.ts";
import {
  LEGACY_DEFAULT_INSPECT_RULES,
  legacyBuildRuleSummaryRows,
  legacyEvaluateInspectRule,
} from "./report.rules.ts";

/** Local-time `YYYY-MM-DD`, matching Go's `time.Now().Format("2006-01-02")`. */
function legacyReportDateFolder(epochMillis: number): string {
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
 * 1:1 port of Go's `inspect.Report` (`apps/cli-go/internal/inspect/report.go`).
 * Telemetry is flushed on success and failure (Go's `PersistentPostRun`); the
 * command-level wrapper adds the `cli_command_executed` instrumentation and the
 * machine-format JSON error envelope.
 */
export const legacyInspectReport = Effect.fn("legacy.inspect.report")(function* (
  flags: LegacyInspectReportFlags,
) {
  const dnsResolver = yield* LegacyDnsResolverFlag;
  const telemetryState = yield* LegacyTelemetryState;
  yield* legacyRunInspectReport(flags, dnsResolver).pipe(Effect.ensuring(telemetryState.flush));
});

const legacyRunInspectReport = Effect.fnUntraced(function* (
  flags: LegacyInspectReportFlags,
  dnsResolver: "native" | "https",
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const cliConfig = yield* LegacyCliConfig;
  const runtimeInfo = yield* RuntimeInfo;
  const tty = yield* Tty;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cliArgs = yield* CliArgs;
  const isText = output.format === "text";

  // Reproduce cobra's MarkFlagsMutuallyExclusive("db-url","linked","local"),
  // keyed off raw argv (cobra's `Changed`), not the parsed boolean value.
  // `--local=false` is Changed even though its value is false; value-based
  // detection would miss it and route to linked incorrectly.
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyInspectMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  // Read + validate the custom `[experimental.inspect.rules]` BEFORE any DB work.
  // Go loads and validates the whole config in `PersistentPreRunE` (via
  // `flags.ParseDatabaseConfig` → `LoadConfig`, `cmd/root.go:118`), so a malformed
  // `inspect.rules` config aborts before connecting or writing any CSV files. They
  // are applied later (in `printSummary`), but validated here for parity.
  const configRules = yield* legacyReadInspectRules(fs, path, cliConfig.workdir);

  // Go's `--linked` defaults to true, so absence of the others resolves to linked.
  const connType = target.connType ?? "linked";
  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    connType,
    dnsResolver,
  });

  // `outDir = <output-dir>/<date>`, resolved against the process CWD when relative
  // (Go's `utils.CurrentDirAbs`, set from `os.Getwd()` — NOT `--workdir`).
  const epochMillis = yield* Clock.currentTimeMillis;
  let outDir = path.join(flags.outputDir, legacyReportDateFolder(epochMillis));
  if (!path.isAbsolute(outDir)) {
    outDir = path.join(runtimeInfo.cwd, outDir);
  }
  yield* fs
    .makeDirectory(outDir, { recursive: true })
    .pipe(
      Effect.mapError(
        (error) => new LegacyInspectReportMkdirError({ message: `failed to mkdir: ${error}` }),
      ),
    );

  // Go's `ConnectByConfig` writes the connect diagnostic to stderr before dialing.
  if (isText) {
    yield* output.raw(`Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`, "stderr");
  }

  const ignoreSchemas = legacyReportIgnoreSchemas();
  const dbLiteral = `'${cfg.conn.database}'`;
  const csvByFile = new Map<string, Uint8Array>();
  const files: Array<{ readonly name: string; readonly path: string }> = [];

  yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      if (isText) yield* output.raw("Running queries...\n", "stderr");
      for (const { fileName, sql } of LEGACY_REPORT_QUERIES) {
        const bytes = yield* session.copyToCsv(
          legacyWrapReportQuery(sql, ignoreSchemas, dbLiteral),
        );
        const filePath = path.join(outDir, `${fileName}.csv`);
        yield* fs.writeFile(filePath, bytes).pipe(
          Effect.mapError(
            (error) =>
              new LegacyInspectReportWriteError({
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
    yield* output.raw(`Reports saved to ${legacyBold(outDir, tty.stdoutIsTty)}\n`, "stderr");
  }

  // Custom `[experimental.inspect.rules]` (read + validated up front) replace the 7
  // defaults when present.
  const rules = configRules.length > 0 ? configRules : LEGACY_DEFAULT_INSPECT_RULES;
  if (configRules.length === 0 && isText) {
    yield* output.raw("Loading default rules...\n", "stderr");
  }

  const tableCache = new Map<string, LegacyCsvTable | undefined>();
  const provider: LegacyCsvTableProvider = (name) => {
    if (!tableCache.has(name)) {
      const bytes = csvByFile.get(name);
      tableCache.set(name, bytes === undefined ? undefined : legacyParseReportCsv(bytes));
    }
    return tableCache.get(name);
  };
  const results = rules.map((rule) => legacyEvaluateInspectRule(rule, provider));

  if (isText) {
    yield* output.raw(
      renderGlamourTable(["RULE", "STATUS", "MATCHES"], legacyBuildRuleSummaryRows(results)),
    );
    return;
  }

  // json / stream-json (TS-extra; Go has only text). CSVs are still written.
  yield* output.success("inspect report", { outputDir: outDir, files, rules: results });
});
