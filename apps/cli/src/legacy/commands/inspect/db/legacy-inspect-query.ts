import { Data, Effect, Option } from "effect";

import { LegacyDnsResolverFlag } from "../../../../shared/legacy/global-flags.ts";
import { Output } from "../../../../shared/output/output.service.ts";
import { renderGlamourTable } from "../../../output/legacy-glamour-table.ts";
import { LegacyDbConfigResolver } from "../../../shared/legacy-db-config.service.ts";
import type { LegacyResolvedDbConfig } from "../../../shared/legacy-db-config.types.ts";
import { LegacyDbConnection } from "../../../shared/legacy-db-connection.service.ts";
import { LegacyTelemetryState } from "../../../telemetry/legacy-telemetry-state.service.ts";

/**
 * The connection selector flags every `inspect db` subcommand inherits from the
 * `inspect` persistent flag set (`apps/cli-go/cmd/inspect.go:259-263`):
 * `--db-url` / `--linked` / `--local`, mutually exclusive. `--linked` defaults to
 * `true` in Go; the runner derives that default from the absence of the others
 * while keeping the exclusivity check keyed off the raw (explicitly-set) flags.
 */
export interface LegacyInspectConnectionFlags {
  readonly dbUrl: Option.Option<string>;
  readonly linked: boolean;
  readonly local: boolean;
}

/**
 * A single `inspect db` subcommand: the SQL it runs, the query parameters, the
 * markdown table headers, and how each result row projects to clean table cells.
 *
 * 1:1 with a Go `internal/inspect/<pkg>` package — `sql` is the embedded
 * `<name>.sql` verbatim, `headers` are the markdown column titles verbatim, and
 * `project` reproduces the per-column `fmt` verbs (via the cell formatters below)
 * minus Go's backtick code-spans and `\|` pipe escaping, since `renderGlamourTable`
 * takes already-clean cell strings.
 */
export interface LegacyInspectQuerySpec {
  /** The subcommand `Use` name, e.g. `"db-stats"`. */
  readonly name: string;
  /** The embedded Go `<name>.sql`, verbatim. */
  readonly sql: string;
  /** Positional query parameters (`$1`, `$2`, …); `[]` for the no-param queries. */
  readonly params: (cfg: LegacyResolvedDbConfig) => ReadonlyArray<unknown>;
  /** Markdown table column titles, verbatim from the Go table header string. */
  readonly headers: ReadonlyArray<string>;
  /** Projects one driver row to the ordered, already-clean table cells. */
  readonly project: (
    row: Record<string, unknown>,
    cfg: LegacyResolvedDbConfig,
  ) => ReadonlyArray<string>;
}

/**
 * Raised when more than one of `--db-url` / `--linked` / `--local` is explicitly
 * set, reproducing cobra's `MarkFlagsMutuallyExclusive` error
 * (`apps/cli-go/cmd/inspect.go:263`). The message byte-matches cobra's text.
 *
 * Not reusing `test db`'s identical error type: hoisting it would drag that
 * command's test surface into scope for a single shared string. Revisit if a
 * third consumer appears.
 */
export class LegacyInspectMutuallyExclusiveFlagsError extends Data.TaggedError(
  "LegacyInspectMutuallyExclusiveFlagsError",
)<{ readonly message: string }> {}

// ---------------------------------------------------------------------------
// Cell formatters — pure, exported, unit-tested. Each reproduces a Go `fmt`
// verb. They branch on `typeof` rather than casting, so an unexpected driver
// type degrades to a string instead of throwing.
// ---------------------------------------------------------------------------

/**
 * Go's backtick-wrapped `` `%s` `` text cell — the shape of almost every `inspect
 * db` string column (e.g. `role_stats.go:43` wraps each cell in `` `…` ``).
 *
 * Glamour's `AsciiStyle` strips the backticks from a non-empty inline code span,
 * so a populated cell renders as its bare value. But an EMPTY code span (`` `` ``)
 * is not a valid token, so glamour passes the two backtick characters through
 * literally. We therefore render an empty/null value as the two literal backticks
 * to byte-match Go (and so the cell contributes width 2, exactly like Go's). The
 * few columns Go leaves UNWRAPPED (`%s`, no code span) use `legacyInspectPlainText`.
 */
export function legacyInspectText(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text === "" ? "``" : text;
}

/**
 * Go's UNWRAPPED `%s` text cell (no backtick code span): an empty/null value
 * renders as the empty string. Only the `vacuum_stats` timestamp columns
 * (`Last_vacuum`/`Last_autovacuum`/`Last_analyze`/`Last_autoanalyze`) are written
 * as bare `%s|` in Go (`vacuum_stats.go:53`); every other string column is wrapped
 * (use `legacyInspectText`).
 */
export function legacyInspectPlainText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

/** Go `%t` for a bool column. The driver maps Postgres `boolean` to a JS boolean. */
export function legacyInspectBool(value: unknown): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "false";
  return String(value);
}

/**
 * Go `%d` for an int column. The `pg` driver returns `int4` as a number and
 * `int8`/`bigint` as a string (or a JS `bigint` if configured), so pass the
 * base-10 representation straight through.
 */
export function legacyInspectInt(value: unknown): string {
  if (value === null || value === undefined) return "0";
  if (typeof value === "bigint") return value.toString();
  return String(value);
}

/** Go `%.1f` for a float column: always one decimal place (`12` → `"12.0"`). */
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
 * of whitespace to a single space, reproducing Go's
 * `regexp.MustCompile(`\s+|\r+|\n+|\t+|\v`).ReplaceAllString(stmt, " ")`. Go also
 * escapes pipes (`\|`), but `renderGlamourTable` takes literal cells, so pipes are
 * left as-is here.
 *
 * Note: `long-running-queries.query` is NOT normalized in Go (`%s` directly), so
 * its spec uses `legacyInspectText`, not this.
 */
export function legacyInspectStmt(value: unknown): string {
  if (value === null || value === undefined) return "";
  // Go's RE2 `\s` is only `[\t\n\f\r ]` (NOT vertical tab), which is why the Go
  // regex appends `|\v`. JS's `\s` differs — it includes `\v` AND Unicode spaces
  // (nbsp, U+2028, …) — so a naive `/\s+/g` would over-collapse runs Go leaves
  // alone. Replicate Go's exact character set: collapse runs of `[\t\n\f\r ]` and
  // replace each `\v` individually with a single space.
  return String(value).replace(/[\t\n\f\r ]+|\v/g, " ");
}

/**
 * A whitespace-collapsed statement cell that Go ALSO wraps in backticks
 * (`calls.go:52` / `outliers.go:50` write the query as `` `%s` ``, unlike
 * `locks`/`blocking` which leave it bare). Same empty-code-span rule as
 * `legacyInspectText`: an empty value surfaces as the two literal backticks.
 */
export function legacyInspectBacktickStmt(value: unknown): string {
  const stmt = legacyInspectStmt(value);
  return stmt === "" ? "``" : stmt;
}

/**
 * Runs an `inspect db` subcommand's query and renders the result.
 *
 * Mirrors the shared Go shape (`internal/inspect/<pkg>/<name>.go`): resolve the
 * connection, `utils.ConnectByConfig` (which prints "Connecting to <local|remote>
 * database..." to stderr — `connect.go:205-228`), run the query, then
 * `utils.RenderTable`. In `json`/`stream-json` mode the raw driver rows are
 * emitted as a structured result instead (TS-extra; Go has no machine output).
 */
export const legacyRunInspectQuery = Effect.fnUntraced(function* (
  spec: LegacyInspectQuerySpec,
  flags: LegacyInspectConnectionFlags,
  dnsResolver: "native" | "https",
) {
  const output = yield* Output;
  const resolver = yield* LegacyDbConfigResolver;
  const dbConn = yield* LegacyDbConnection;

  // Reproduce cobra's MarkFlagsMutuallyExclusive("db-url","linked","local"),
  // keyed off explicitly-set flags (cobra's `Changed`), not the default value.
  const setFlags: Array<string> = [];
  if (Option.isSome(flags.dbUrl)) setFlags.push("db-url");
  if (flags.linked) setFlags.push("linked");
  if (flags.local) setFlags.push("local");
  if (setFlags.length > 1) {
    return yield* Effect.fail(
      new LegacyInspectMutuallyExclusiveFlagsError({
        message: `if any flags in the group [db-url linked local] are set none of the others can be; [${setFlags.join(" ")}] were all set`,
      }),
    );
  }

  // Go's `--linked` defaults to true, so absence of `--db-url`/`--local` resolves
  // to the linked project. Exclusivity above is already keyed off the raw flags,
  // so deriving the default here does not re-trigger it.
  const linked = flags.linked || (Option.isNone(flags.dbUrl) && !flags.local);

  const cfg = yield* resolver.resolve({
    dbUrl: flags.dbUrl,
    linked,
    local: flags.local,
    dnsResolver,
  });

  const rows = yield* Effect.scoped(
    Effect.gen(function* () {
      // Go's `ConnectByConfig` writes "Connecting to <local|remote> database..."
      // to os.Stderr before dialing (`connect.go:205-228`). stdout is reserved
      // for the rendered table (the machine payload in json modes), so this
      // diagnostic always goes to stderr regardless of output mode.
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

  // json / stream-json — emit the raw driver rows (snake_case keys). TS-extra:
  // Go has no `--output-format` for inspect, so this is additive.
  yield* output.success(`inspect db ${spec.name}`, { rows });
});

/**
 * The cobra deprecation line emitted to stderr before a deprecated alias runs:
 * `Command "%q" is deprecated, %s\n` where `%s` is the alias's `Deprecated` field
 * (`use "<target>" instead.`). Centralized so the single format string tracks Go's
 * `command.go` template rather than living as 12 independent literals.
 * See `apps/cli-go/cmd/inspect.go:139-245`.
 */
export function legacyInspectDeprecationNotice(alias: string, target: string): string {
  return `Command "${alias}" is deprecated, use "${target}" instead.\n`;
}

/**
 * Builds an `inspect db <name>` handler from its spec. Each active subcommand and
 * each deprecated alias gets its own `Effect.fn` trace span (`legacy.inspect.db.<name>`)
 * and flushes telemetry on completion (success or failure), matching Go's
 * `PersistentPostRun` — callers must NOT add a second `Effect.ensuring(flush)` at
 * the command level. Deprecated aliases pass `deprecation`, the exact cobra stderr
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
