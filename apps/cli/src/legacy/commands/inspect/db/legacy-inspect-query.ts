import { Data, Effect, Option } from "effect";

import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../../shared/telemetry/error-actionability.ts";
import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyResolvedDbConfig } from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { resolveLegacyDbTargetFlags } from "../../../shared/legacy-db-target-flags.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";

/**
 * The connection selector flags every `inspect db` subcommand inherits from the
 * `inspect` persistent flag set:
 * `--db-url` / `--linked` / `--local`, mutually exclusive. `--linked` is the
 * default; the runner derives that default from the absence of the others
 * while keeping the exclusivity check keyed off the raw (explicitly-set) flags.
 */
export interface LegacyInspectConnectionFlags {
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
  // TS-only override of the linked project ref — see push.command.ts (db push).
  readonly projectRef: Option.Option<string>;
}

/**
 * A single `inspect db` subcommand: the SQL it runs, the query parameters, the
 * markdown table headers, and how each result row projects to clean table cells.
 *
 * `project` reproduces the per-column formatting (via the cell formatters below)
 * minus backtick code-spans and `\|` pipe escaping, since `renderGlamourTable`
 * takes already-clean cell strings.
 */
export interface LegacyInspectQuerySpec {
  /** The subcommand's own name, e.g. `"db-stats"`. */
  readonly name: string;
  /** The embedded `<name>.sql`, verbatim. */
  readonly sql: string;
  /** Positional query parameters (`$1`, `$2`, …); `[]` for the no-param queries. */
  readonly params: (cfg: LegacyResolvedDbConfig) => ReadonlyArray<unknown>;
  /** Markdown table column titles, verbatim from the established table header string. */
  readonly headers: ReadonlyArray<string>;
  /** Projects one driver row to the ordered, already-clean table cells. */
  readonly project: (
    row: Record<string, unknown>,
    cfg: LegacyResolvedDbConfig,
  ) => ReadonlyArray<string>;
}

/**
 * Raised when more than one of `--db-url` / `--linked` / `--local` is explicitly
 * set. The message matches the established mutually-exclusive-flags text.
 *
 * Not reusing `test db`'s identical error type: hoisting it would drag that
 * command's test surface into scope for a single shared string. Revisit if a
 * third consumer appears.
 */
export class LegacyInspectMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyInspectMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

// ---------------------------------------------------------------------------
// Cell formatters — pure, exported, unit-tested. They branch on `typeof`
// rather than casting, so an unexpected driver type degrades to a string
// instead of throwing.
// ---------------------------------------------------------------------------

/**
 * The backtick-wrapped `` `…` `` text cell — the shape of almost every `inspect
 * db` string column.
 *
 * Glamour's `AsciiStyle` strips the backticks from a non-empty inline code span,
 * so a populated cell renders as its bare value. But an EMPTY code span (`` `` ``)
 * is not a valid token, so glamour passes the two backtick characters through
 * literally. We therefore render an empty/null value as the two literal backticks
 * (so the cell contributes width 2, matching a populated one). The
 * few UNWRAPPED columns (no code span) use `legacyInspectPlainText`.
 */
export function legacyInspectText(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text === "" ? "``" : text;
}

/**
 * The UNWRAPPED text cell (no backtick code span): an empty/null value
 * renders as the empty string. Only the `vacuum_stats` timestamp columns
 * (`Last_vacuum`/`Last_autovacuum`/`Last_analyze`/`Last_autoanalyze`) are written
 * bare; every other string column is wrapped (use `legacyInspectText`).
 */
export function legacyInspectPlainText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** A bool column. The driver maps Postgres `boolean` to a JS boolean. */
export function legacyInspectBool(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "false";
  return String(value);
}

/**
 * An int column. The `pg` driver returns `int4` as a number and
 * `int8`/`bigint` as a string (or a JS `bigint` if configured), so pass the
 * base-10 representation straight through.
 */
export function legacyInspectInt(value: unknown): string {
  if (value === null || value === undefined) return "0";
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

/** A float column: always one decimal place (`12` → `"12.0"`). */
export function legacyInspectFloat1(value: unknown): string {
  if (typeof value === "number") return value.toFixed(1);
  if (typeof value === "bigint") return Number(value).toFixed(1);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? value : parsed.toFixed(1);
  }
  if (value === null || value === undefined) return "0.0";
  return String(value);
}

/**
 * A statement/query cell (locks, blocking, outliers, calls): collapse every run
 * of whitespace to a single space. Pipes are left as-is here since
 * `renderGlamourTable` takes literal cells.
 *
 * Note: `long-running-queries.query` is NOT normalized, so its spec uses
 * `legacyInspectText`, not this.
 */
export function legacyInspectStmt(value: unknown): string {
  if (value === null || value === undefined) return "";
  // Collapse runs of `[\t\n\f\r ]` and replace each vertical tab individually
  // with a single space — the exact character set this must match, since
  // JS's `\s` differs (it includes `\v` AND Unicode spaces like nbsp, U+2028)
  // and a naive `/\s+/g` would over-collapse runs this must leave alone.
  return String(value).replace(/[\t\n\f\r ]+|\v/g, " ");
}

/**
 * A whitespace-collapsed statement cell that is ALSO wrapped in backticks
 * (used for `calls`/`outliers`'s `query` column and `blocking`'s
 * `blocking_statement` — unlike `locks` and `blocking`'s `blocked_statement`,
 * which stay bare). Same empty-code-span rule as `legacyInspectText`: an
 * empty value surfaces as the two literal backticks.
 */
export function legacyInspectBacktickStmt(value: unknown): string {
  const stmt = legacyInspectStmt(value);
  return stmt === "" ? "``" : stmt;
}

/**
 * Runs an `inspect db` subcommand's query and renders the result.
 *
 * The shared shape: resolve the connection, connect (which prints "Connecting
 * to <local|remote> database..." to stderr), run the query, then render the
 * table. In `json`/`stream-json` mode the raw driver rows are emitted as a
 * structured result instead.
 */
export const legacyRunInspectQuery = Effect.fnUntraced(function* (
  spec: LegacyInspectQuerySpec,
  flags: LegacyInspectConnectionFlags,
  dnsResolver: "native" | "https",
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;
  const cliArgs = yield* CliArgs;

  // Mutual exclusivity is keyed off raw argv (which flags were explicitly
  // passed), not the parsed boolean value. `--local=false` was explicitly
  // passed even though its value is false; value-based detection would miss
  // it and route to linked incorrectly.
  const target = resolveLegacyDbTargetFlags(cliArgs.args);
  if (target.setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyInspectMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${target.setFlags.join(" ")}] were all set`,
      }),
    );
  }

  // `--linked` is the default, so absence of `--db-url`/`--local` resolves
  // to the linked project. Exclusivity above is already keyed off the raw flags,
  // so deriving the connType here does not re-trigger it.
  const connType = target.connType ?? "linked";

  // `--project-ref` never implies `--linked` and must not be silently
  // discarded on a non-linked target — see push.handler.ts's identical guard
  // (db push) for the full TS-only rationale.
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
      // "Connecting to <local|remote> database..." is written to stderr before
      // dialing. stdout is reserved for the rendered table (the machine
      // payload in json modes), so this diagnostic always goes to stderr
      // regardless of output mode.
      yield* output.raw(
        `Connecting to ${cfg.isLocal ? "local" : "remote"} database...\n`,
        "stderr",
      );
      const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      return yield* session.query(spec.sql, spec.params(cfg));
    }),
  );

  if (output.format === "text") {
    const cells = rows.map((row) => spec.project(row, cfg));
    yield* output.raw(renderGlamourTable(spec.headers, cells));
    return;
  }

  // json / stream-json — emit the raw driver rows (snake_case keys).
  yield* output.success(`inspect db ${spec.name}`, { rows });
});

/**
 * The deprecation line emitted to stderr before a deprecated alias runs.
 * Centralized so the single format string is defined once rather than living
 * as 12 independent literals.
 */
export function legacyInspectDeprecationNotice(alias: string, target: string): string {
  return `Command "${alias}" is deprecated, use "${target}" instead.\n`;
}

/**
 * Builds an `inspect db <name>` handler from its spec. Each active subcommand and
 * each deprecated alias gets its own `Effect.fn` trace span (`legacy.inspect.db.<name>`)
 * and flushes telemetry on completion (success or failure) —
 * callers must NOT add a second `Effect.ensuring(flush)` at
 * the command level. Deprecated aliases pass `deprecation`, the exact stderr
 * line (build it with `legacyInspectDeprecationNotice`) emitted before the query runs.
 */
export function legacyMakeInspectDbHandler(
  spec: LegacyInspectQuerySpec,
  traceName: string,
  deprecation?: string,
) {
  return Effect.fn(traceName)(function* (flags: LegacyInspectConnectionFlags) {
    const dnsResolver = yield* LegacyDnsResolverFlag;
    const telemetryState = yield* LegacyTelemetryState;
    yield* Effect.gen(function* () {
      if (deprecation !== undefined) {
        const output = yield* Output;
        yield* output.raw(deprecation, "stderr");
      }
      yield* legacyRunInspectQuery(spec, flags, dnsResolver);
    }).pipe(Effect.ensuring(telemetryState.flush));
  });
}
