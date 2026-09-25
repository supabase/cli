# `inspect db` output architecture — current design and improvement options

Status: draft for discussion
Scope: `apps/cli/src/commands/inspect/db/*` (25 subcommands), with
`collation-drift` as the first consumer of any new output model.

Everything in Part 1 is taken from the current source. Two internals are
inferred rather than read and are marked as such: the body of
`renderGlamourTable` and the internals of the `Output` service.

---

## Part 1 — How the current stack works

### 1.1 The data flow

Every `inspect db` subcommand is the same pipeline with a different SQL string
plugged in:

```
argv
  → Command.make(name, LEGACY_INSPECT_DB_FLAGS)          command file
  → legacyInspectDbCommandHandler(handler)                telemetry + JSON error envelope
  → legacyMakeInspectDbHandler(spec, traceName)           trace span + telemetry flush
  → legacyRunInspectQuery(spec, flags, dnsResolver)       the shared engine
      → resolveLegacyDbTargetFlags(argv)                  --db-url / --linked / --local exclusivity
      → LegacyDbConfigResolver.resolve(...)               connection config
      → LegacyDbConnection.connect(...).query(sql, params)
      → text mode:   spec.project(row) per row → renderGlamourTable(headers, cells) → stdout
        json mode:   output.success(name, { rows })       raw snake_case driver rows
```

Connection diagnostics ("Connecting to local database...") go to stderr so
stdout stays machine-clean in every mode.

### 1.2 The command anatomy

Each subcommand is three small files in its own directory. Using `index-stats`
as the reference:

`index-stats.query.ts` owns everything specific to the command — the SQL, its
parameters, the table headers, and a `project` function mapping one driver row
to ordered cell strings. `index-stats.handler.ts` is two lines: it binds the
spec to `legacyMakeInspectDbHandler` with a trace name. `index-stats.command.ts`
declares the CLI surface: name, descriptions, the shared flag set, the shared
handler wrapper, and the runtime layer keyed by the leaf name for telemetry.

The contract between a command and the engine is a single interface:

```ts
export interface LegacyInspectQuerySpec {
  readonly name: string;
  readonly sql: string;
  readonly params: (cfg: LegacyResolvedDbConfig) => ReadonlyArray<unknown>;
  readonly headers: ReadonlyArray<string>;
  readonly project: (
    row: Record<string, unknown>,
    cfg: LegacyResolvedDbConfig,
  ) => ReadonlyArray<string>;
}
```

This is the load-bearing abstraction. Its strength is that 25 commands share
one engine, one flag set, one connection path, one telemetry shape, and one
error envelope; a new diagnostic is ~150 lines, almost all of it SQL. Its
constraint is equally clear: **the output vocabulary is exactly one table of
strings.**

### 1.3 The cell formatters

`legacy-inspect-query.ts` exports pure formatters (`legacyInspectText`,
`legacyInspectInt`, `legacyInspectBool`, `legacyInspectFloat1`,
`legacyInspectStmt`, `legacyInspectBacktickStmt`, `legacyInspectPlainText`)
that encode two kinds of knowledge: driver type quirks (`int8` arrives as a
string; unexpected types degrade to `String(value)` rather than throwing) and
glamour rendering quirks (an empty inline code span is not a valid markdown
token, so empty cells render as two literal backticks to preserve column
width).

That second category matters for any redesign: **formatting rules currently
live in two places** — the SQL (`pg_size_pretty`, `::text || '%'`) and the
projection — and some of them exist only to satisfy the renderer.

### 1.4 Output modes

The `Output` service exposes `format` (`"text" | "json" | "stream-json"`) plus
`raw`, `success`, `warn`, `info` channels. The engine branches once: text mode
renders the glamour table; JSON modes emit raw driver rows under
`{ rows }`. Notable asymmetry: `project` is applied only in text mode, so the
JSON payload has different values (raw, unformatted, snake_case) than the
table. Consumers scripting against `--output json` get sizes in bytes where
the table shows `pg_size_pretty` strings.

### 1.5 What the current model cannot express

Observed limitations, all consequences of "one table of strings":

The empty state is a blank table. For `locks` that reads fine (no locks, no
rows). For a diagnostic like `collation-drift` it is ambiguous — "healthy",
"drift but no affected indexes", and "this PG version cannot detect drift" all
render identically.

There is no severity. A row for an unused 16 kB index and a row for a
corrupted primary key look the same. Ordering is the only signal available,
and it is invisible unless the user knows to look for it.

There is no guidance channel. Remediation for `collation-drift` currently
lives in `--help` text, which nobody reads after the first run. A command
whose whole purpose is "now go do these three things in this order" cannot
say so in its output.

There is no non-tabular content: no key/value header (database, provider,
versions), no multi-section output, no generated-SQL block a user can copy.

Column formatting is stringly typed. `project` returns strings, so alignment,
truncation, and units are each command's private problem, solved slightly
differently across 25 files.

---

## Part 2 — Improvement options

Three options, in increasing order of ambition. All keep the outer pipeline
(flags, connection, telemetry, error envelope) untouched — the redesign is
strictly about what sits between "rows came back" and "bytes hit stdout".

### Option 1 — Extend the spec in place

Add optional fields to `LegacyInspectQuerySpec`: an `emptyMessage`, a
`preamble(cfg, rows)` for a key/value header, a `severity(row)` used for row
styling, a `footer(rows)` for guidance. The engine renders them around the
existing table.

This is cheap and every existing command keeps working unmodified. It is also
where the design pressure shows: each new need becomes another optional field,
the spec stops being a data description and becomes a grab-bag of render
hooks, and JSON mode has to decide field-by-field what to do with each hook.
Reasonable as a stopgap; poor as the stated direction.

### Option 2 — A report document model (recommended)

Invert the relationship: a command no longer describes a table, it produces a
**structured report document**, and per-format renderers turn that document
into text or JSON. The table becomes one block type among several.

```ts
// report.types.ts — the vocabulary of everything an inspect command can say.

export type ReportSeverity = "info" | "ok" | "warn" | "critical";

export interface ReportKeyValueBlock {
  readonly kind: "keyValue";
  readonly entries: ReadonlyArray<{ readonly key: string; readonly value: string }>;
}

export interface ReportTableBlock {
  readonly kind: "table";
  readonly columns: ReadonlyArray<{
    readonly title: string;
    readonly align?: "left" | "right";
  }>;
  readonly rows: ReadonlyArray<{
    readonly cells: ReadonlyArray<string>;
    readonly severity?: ReportSeverity;
  }>;
}

export interface ReportCalloutBlock {
  readonly kind: "callout";
  readonly severity: ReportSeverity;
  readonly text: string;
}

export interface ReportSqlBlock {
  readonly kind: "sql";
  readonly title: string;
  readonly statements: ReadonlyArray<string>;
}

export interface ReportStepsBlock {
  readonly kind: "steps";
  readonly steps: ReadonlyArray<{
    readonly title: string;
    readonly body?: string;
    readonly sql?: ReadonlyArray<string>;
  }>;
}

export type ReportBlock =
  ReportKeyValueBlock | ReportTableBlock | ReportCalloutBlock | ReportSqlBlock | ReportStepsBlock;

export interface Report {
  readonly command: string;
  /** Overall status; drives the empty-state line and the process exit hint. */
  readonly severity: ReportSeverity;
  readonly blocks: ReadonlyArray<ReportBlock>;
}
```

The spec interface gains one function and loses none:

```ts
export interface LegacyInspectReportSpec {
  readonly name: string;
  readonly sql: string;
  readonly params: (cfg: LegacyResolvedDbConfig) => ReadonlyArray<unknown>;
  /** Rows in, document out. Pure — trivially unit-testable without a DB. */
  readonly report: (
    rows: ReadonlyArray<Record<string, unknown>>,
    cfg: LegacyResolvedDbConfig,
  ) => Report;
}
```

Rendering is centralized once per format:

```ts
// renderReportText(report): string   — glamour table for table blocks,
//                                      styled callouts, indented SQL blocks.
// json mode: emit the Report object itself. The document IS the payload, so
// text and JSON finally describe the same thing, severities included.
```

Migration is mechanical because the old shape embeds in the new one. A single
adapter converts every existing spec without touching its file:

```ts
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
```

One decision the adapter forces into the open: today JSON mode emits raw
driver rows, and under the report model it would emit the document. That is a
**breaking change for anyone scripting against `--output json`**. The options
are to version the envelope (`{ rows }` → `{ rows, report }` during a
deprecation window) or to keep raw rows as an additional block field. This is
the main question to put to the maintainers.

What `collation-drift` looks like as a report — the Option B output, expressed
in the new vocabulary:

```ts
report: (rows, cfg) => {
  if (rows.length === 0) {
    return {
      command: "collation-drift",
      severity: "ok",
      blocks: [
        {
          kind: "callout",
          severity: "ok",
          text: "No collation version drift detected. Indexes match the current system sorting rules.",
        },
      ],
    };
  }
  return {
    command: "collation-drift",
    severity: rows.some(isKeyIndex) ? "critical" : "warn",
    blocks: [
      { kind: "keyValue", entries: environmentEntries(rows, cfg) },
      {
        kind: "callout",
        severity: "warn",
        text: "These indexes were built under different sorting rules. Postgres reports no error for this; queries may return missing rows or admit duplicates.",
      },
      { kind: "table", columns: DRIFT_COLUMNS, rows: rows.map(toDriftRow) },
      {
        kind: "steps",
        steps: [
          { title: "Confirm actual corruption with amcheck", sql: amcheckStatements(rows) },
          {
            title: "Rebuild affected indexes (CONCURRENTLY keeps the app online)",
            sql: reindexStatements(rows),
          },
          {
            title: "Only after every rebuild: record the new version",
            sql: refreshStatements(rows),
            body: "Refreshing first hides the problem without fixing it.",
          },
        ],
      },
    ],
  };
};
```

The generated SQL is now data, not help text: it appears in the terminal with
the user's real index names, and arrives structured in JSON where a tool (or
the dashboard) could offer one-click execution.

### Option 3 — Interactive TUI

A full-screen interface (Ink or similar): sortable columns, row drill-down,
"press r to copy the REINDEX statement". Rejected for this iteration. It
multiplies the testing surface, breaks piping and CI usage that the current
commands support well, and everything user-facing it offers is reachable later
by adding a renderer on top of the Option 2 document — which is the strongest
argument for Option 2: it makes the output model a data structure that future
frontends consume, rather than a side effect of each command.

---

## Part 3 — Recommendation and rollout

Adopt Option 2. Concretely:

Phase 1 lands the model: `report.types.ts`, `renderReportText`, the JSON
emission, and `reportSpecFromTableSpec`. The engine gains a second entry point
(`legacyRunInspectReport`) alongside the existing one; nothing else changes.
Ship `collation-drift` on it as the proving consumer — it exercises every
block type.

Phase 2 flips the 24 existing commands through the adapter (one-line change
per handler), keeping their output byte-identical in text mode. This is the
low-risk bulk of the migration and can be a single PR.

Phase 3, opportunistically and per-command, upgrades specs that benefit from
the richer vocabulary: `bloat` and `unused-indexes` gain severities and a
"consider dropping / rebuilding" steps block; `long-running-queries` gains a
callout when a query exceeds a threshold; `db-stats` becomes a keyValue block
instead of a one-row table. Each is a small, reviewable diff.

The JSON envelope question (raw rows vs report document, and the deprecation
path) should be settled with the maintainers in the issue before Phase 1
lands, since it is the only externally visible contract change.

Open questions to include in that issue: whether severity should influence the
process exit code (useful for CI: `collation-drift` returning non-zero on
`critical` makes it a deployment gate); whether internal Supabase schemas stay
included for `collation-drift` (they are excluded by every sibling command,
but a mis-ordered index on `auth.users` is precisely what a user needs to
see); and whether the steps block's generated SQL should be gated behind a
`--show-fix` flag for users who want the terse table only.
