import { Data, Effect, Option } from "effect";

import { DnsResolverFlag } from "../../../command-internal/global-flags.ts";
import { Output } from "../../../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../../../shared/telemetry/error-actionability.ts";
import { renderGlamourTable } from "../../../output/glamour-table.ts";
import { DbConfigResolver } from "../../../command-internal/db-config.service.ts";
import type { ResolvedDbConfig } from "../../../command-internal/db-config.types.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { hostedMutationPreapproval } from "../../../command-internal/hosted-consent/hosted-consent.ts";
import { resolveTarget } from "../../../command-internal/target/resolve-target.ts";
import { TelemetryState } from "../../../telemetry/telemetry-state.service.ts";

/** The target selector flags every `inspect db` subcommand inherits; see `targetFlags`. */
export interface InspectConnectionFlags {
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
  readonly projectRef: Option.Option<string>;
}

/**
 * A single `inspect db` subcommand: the SQL it runs, the query parameters, table headers, and
 * how each result row projects to clean table cells (already stripped of backtick code-spans
 * and pipe escaping, since `renderGlamourTable` takes already-clean strings).
 */
export interface InspectQuerySpec {
  /** The subcommand's own name, e.g. `"db-stats"`. */
  readonly name: string;
  /** The embedded `<name>.sql`, verbatim. */
  readonly sql: string;
  /** Positional query parameters (`$1`, `$2`, …); `[]` for the no-param queries. */
  readonly params: (cfg: ResolvedDbConfig) => ReadonlyArray<unknown>;
  /** Markdown table column titles, verbatim from the established table header string. */
  readonly headers: ReadonlyArray<string>;
  /** Projects one driver row to the ordered, already-clean table cells. */
  readonly project: (row: Record<string, unknown>, cfg: ResolvedDbConfig) => ReadonlyArray<string>;
}

/**
 * Retained for its telemetry tag; the shared target selector now rejects conflicting target flags.
 *
 * @public
 */
export class InspectMutuallyExclusiveFlagsError extends Data.TaggedError(
  "InspectMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.provideFlags;
  }
}

/**
 * The backtick-wrapped `` `…` `` text cell. An empty code span isn't a valid glamour token, so
 * empty/null values render as the two literal backticks too, keeping the same column width as
 * a populated cell. Unwrapped columns use `inspectPlainText` instead.
 */
export function inspectText(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text === "" ? "``" : text;
}

/**
 * The unwrapped text cell (no backtick code span): an empty/null value renders as the empty
 * string. Only the `vacuum_stats` timestamp columns are written bare; every other string
 * column is wrapped (use `inspectText`).
 */
export function inspectPlainText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** A bool column. The driver maps Postgres `boolean` to a JS boolean. */
export function inspectBool(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "false";
  return String(value);
}

/**
 * An int column. The `pg` driver returns `int4` as a number and
 * `int8`/`bigint` as a string (or a JS `bigint` if configured), so pass the
 * base-10 representation straight through.
 */
export function inspectInt(value: unknown): string {
  if (value === null || value === undefined) return "0";
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

/** A float column: always one decimal place (`12` → `"12.0"`). */
export function inspectFloat1(value: unknown): string {
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
 * A statement/query cell (locks, blocking, outliers, calls): collapses every whitespace run to
 * a single space, leaving pipes as-is since `renderGlamourTable` takes literal cells.
 * `long-running-queries.query` isn't normalized this way and uses `inspectText` instead.
 */
export function inspectStmt(value: unknown): string {
  if (value === null || value === undefined) return "";
  // Matches `[\t\n\f\r ]+|\v` exactly, not `\s+`: JS's `\s` also matches nbsp/U+2028, which
  // must not collapse here.
  return String(value).replace(/[\t\n\f\r ]+|\v/g, " ");
}

/**
 * A whitespace-collapsed statement cell also wrapped in backticks (used for `calls`/`outliers`'s
 * `query` column and `blocking`'s `blocking_statement`). Same empty-code-span rule as
 * `inspectText`: an empty value surfaces as the two literal backticks.
 */
export function inspectBacktickStmt(value: unknown): string {
  const stmt = inspectStmt(value);
  return stmt === "" ? "``" : stmt;
}

/**
 * Runs an `inspect db` subcommand's query and renders the result: resolve the target and its
 * connection, run the query, then render the table — or, in `json`/`stream-json` mode, emit the
 * raw driver rows instead.
 */
export const runInspectQuery = Effect.fn("Inspect.runQuery")(function* (
  spec: InspectQuerySpec,
  flags: InspectConnectionFlags,
  dnsResolver: "native" | "https",
) {
  const output = yield* Output;
  const resolver = yield* DbConfigResolver;
  const dbConn = yield* DbConnection;

  const target = yield* resolveTarget(flags);
  const cfg = yield* resolver.resolveConnection({
    target,
    dnsResolver,
    password: Option.none(),
    networkBanRemoval: yield* hostedMutationPreapproval,
  });

  const rows = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* dbConn.connect(cfg.conn, { isLocal: cfg.isLocal, dnsResolver });
      return yield* session.query(spec.sql, spec.params(cfg));
    }),
  );
  yield* Effect.annotateCurrentSpan({ "query.row_count": rows.length });

  if (output.format === "text") {
    const cells = rows.map((row) => spec.project(row, cfg));
    yield* output.raw(renderGlamourTable(spec.headers, cells));
    return;
  }

  yield* output.success(`inspect db ${spec.name}`, { rows });
});

/**
 * The deprecation line emitted to stderr before a deprecated alias runs.
 * Centralized so the single format string is defined once rather than living
 * as 12 independent literals.
 */
export function inspectDeprecationNotice(alias: string, target: string): string {
  return `Command "${alias}" is deprecated, use "${target}" instead.\n`;
}

/**
 * Builds an `inspect db <name>` handler from its spec, with its own `Effect.fn` trace span and
 * telemetry flush on completion — callers must not add a second `Effect.ensuring(flush)`.
 * `deprecation` (see {@link inspectDeprecationNotice}) is the stderr line emitted first.
 */
export function makeInspectDbHandler(
  spec: InspectQuerySpec,
  traceName: string,
  deprecation?: string,
) {
  return Effect.fn(traceName)(function* (flags: InspectConnectionFlags) {
    const dnsResolver = yield* DnsResolverFlag;
    const telemetryState = yield* TelemetryState;
    yield* Effect.gen(function* () {
      if (deprecation !== undefined) {
        const output = yield* Output;
        yield* output.raw(deprecation, "stderr");
      }
      yield* runInspectQuery(spec, flags, dnsResolver);
    }).pipe(Effect.ensuring(telemetryState.flush));
  });
}
