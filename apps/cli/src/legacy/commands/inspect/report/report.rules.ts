import { Option } from "effect";
import { legacyInspectText } from "../db/legacy-inspect-query.ts";
import {
  type LegacyCsvTableProvider,
  LegacyInspectCsvqError,
  legacyEvalCsvqScalar,
} from "./report.csvq.ts";

/**
 * One report validation rule, 1:1 with Go's `config.rule`
 * (`apps/cli-go/pkg/config/config.go:236-241`): the csvq `query` over the written
 * CSVs, the `name` shown in the summary, and the `pass`/`fail` STATUS strings.
 */
export interface LegacyInspectRule {
  readonly query: string;
  readonly name: string;
  readonly pass: string;
  readonly fail: string;
}

/**
 * The default rules, ported verbatim from
 * `apps/cli-go/internal/inspect/templates/rules.toml`. Used when
 * `[experimental.inspect.rules]` is absent or empty in `config.toml`.
 */
export const LEGACY_DEFAULT_INSPECT_RULES: ReadonlyArray<LegacyInspectRule> = [
  {
    query: "SELECT LISTAGG(stmt, ',') AS match FROM `locks.csv` WHERE age > '00:02:00'",
    name: "No old locks",
    pass: "✔",
    fail: "There is at least one lock older than 2 minutes",
  },
  {
    query: "SELECT LISTAGG(stmt, ',') AS match FROM `locks.csv` WHERE granted = 'f'",
    name: "No ungranted locks",
    pass: "✔",
    fail: "There is at least one ungranted lock",
  },
  {
    query: "SELECT LISTAGG(index, ',') AS match FROM `unused_indexes.csv`",
    name: "No unused indexes",
    pass: "✔",
    fail: "There is at least one unused index",
  },
  {
    query:
      "SELECT LISTAGG(i.name, ',') AS match FROM `index_stats.csv` AS i JOIN (SELECT `table`, columns FROM `index_stats.csv` GROUP BY `table`, columns HAVING COUNT(*) > 1) AS d ON i.`table` = d.`table` AND i.columns = d.columns",
    name: "No duplicate indexes",
    pass: "✔",
    fail: "There is at least one duplicate index (same columns on the same table)",
  },
  {
    query:
      "SELECT 'index: ' || index_hit_rate || ', table: ' || table_hit_rate AS match FROM `db_stats.csv` WHERE index_hit_rate < 0.94 OR table_hit_rate < 0.94",
    name: "Check cache hit is within acceptable bounds",
    pass: "✔",
    fail: "There is a cache hit ratio (table or index) below 94%",
  },
  {
    query:
      "SELECT LISTAGG(t.name, ',') AS match FROM `table_stats.csv` t WHERE t.seq_scans > t.estimated_row_count * 0.1 AND t.estimated_row_count > 1000;",
    name: "No large tables with sequential scans more than 10% of rows",
    pass: "✔",
    fail: "At least one table is showing sequential scans more than 10% of total row count",
  },
  {
    query:
      "SELECT LISTAGG(s.name, ',') AS match FROM `vacuum_stats.csv` s WHERE s.expect_autovacuum = 'yes' and s.rowcount > 1000;",
    name: "No large tables waiting on autovacuum",
    pass: "✔",
    fail: "At least one table is waiting on autovacuum",
  },
  {
    query:
      "SELECT LISTAGG(s.name, ',') AS match FROM `vacuum_stats.csv` s WHERE s.rowcount > 0 AND (s.last_autovacuum = '' OR s.last_vacuum = '');",
    name: "No tables yet to be vacuumed",
    pass: "✔",
    fail: "At least one table has never had autovacuum or vacuum run on it",
  },
  {
    query:
      "SELECT LISTAGG(s.name, ',') AS match FROM `vacuum_stats.csv` s WHERE FLOAT(REPLACE(s.rowcount, ',', '')) > 1000 AND FLOAT(REPLACE(s.dead_rowcount, ',', '')) > 0.2 * FLOAT(REPLACE(s.rowcount, ',', ''))",
    name: "No tables with more than 20% dead rows",
    pass: "✔",
    fail: "At least one table has more than 20% dead rows",
  },
  {
    query:
      "SELECT LISTAGG(slot_name, ',') AS match FROM `replication_slots.csv` WHERE active = 'f'",
    name: "No inactive replication slots",
    pass: "✔",
    fail: "There is at least one inactive replication slot",
  },
  {
    query: "SELECT LISTAGG(blocked_pid, ',') AS match FROM `blocking.csv`",
    name: "No blocked queries",
    pass: "✔",
    fail: "There is at least one query blocked on another",
  },
  {
    query: "SELECT LISTAGG(pid, ',') AS match FROM `long_running_queries.csv`",
    name: "No queries running longer than 5 minutes",
    pass: "✔",
    fail: "At least one query has been running for more than 5 minutes",
  },
  {
    query: "SELECT LISTAGG(name, ',') AS match FROM `bloat.csv` WHERE bloat > 4",
    name: "No tables or indexes with bloat ratio above 4x",
    pass: "✔",
    fail: "At least one table or index is more than 4x its expected size",
  },
];

/** The outcome of evaluating one rule: the STATUS and MATCHES summary cells. */
export interface LegacyInspectRuleResult {
  readonly name: string;
  readonly status: string;
  readonly matches: string;
}

/**
 * Evaluate one rule against the written CSVs and map it to its summary cells,
 * reproducing Go's status logic (`report.go:107-120`):
 *
 * - aggregate over zero rows / non-aggregate with no rows (csvq NULL / ErrNoRows)
 *   → STATUS = `pass`, MATCHES = `-`;
 * - a valid empty string → STATUS = `pass`, MATCHES = `` (empty);
 * - a non-empty value → STATUS = `fail`, MATCHES = the value;
 * - a csvq error → STATUS = the error message, MATCHES = `-` (the command does not
 *   fail; the error becomes the cell).
 */
export function legacyEvaluateInspectRule(
  rule: LegacyInspectRule,
  provider: LegacyCsvTableProvider,
): LegacyInspectRuleResult {
  try {
    const match = legacyEvalCsvqScalar(rule.query, provider);
    if (Option.isNone(match)) {
      return { name: rule.name, status: rule.pass, matches: "-" };
    }
    if (match.value === "") {
      return { name: rule.name, status: rule.pass, matches: "" };
    }
    return {
      name: rule.name,
      status: rule.fail,
      matches: legacySummarizeInspectRuleMatch(match.value),
    };
  } catch (error) {
    const message = error instanceof LegacyInspectCsvqError ? error.message : String(error);
    return { name: rule.name, status: message, matches: "-" };
  }
}

function legacySummarizeInspectRuleMatch(match: string): string {
  if (match.length <= 20) return match;
  return `${match.split(",").length} matches`;
}

/**
 * Build the `[RULE, STATUS, MATCHES]` summary rows in rule order, for
 * `renderGlamourTable`. Go wraps each cell in backticks inside its markdown
 * (`report.go:121`): Glamour strips a non-empty inline code span (so a populated
 * cell renders bare), but an EMPTY code span (`` `` ``) is passed through as the
 * two literal backtick characters — the same rule `legacyInspectText` encodes for
 * the `inspect db` tables. A valid empty `matches` cell therefore renders as `` ``
 * (width 2), byte-matching Go; `name`/`status` are never empty.
 */
export function legacyBuildRuleSummaryRows(
  results: ReadonlyArray<LegacyInspectRuleResult>,
): ReadonlyArray<ReadonlyArray<string>> {
  return results.map((result) => [
    legacyInspectText(result.name),
    legacyInspectText(result.status),
    legacyInspectText(result.matches),
  ]);
}
