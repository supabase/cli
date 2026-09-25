# `supabase inspect db collation-drift`

Companion documents, not duplicated here: full test transcripts live in
`apps/cli/docs/inspect-collation-drift-test-evidence.md`; the report output
model this command introduced is specified in
`apps/cli/docs/inspect-report-output.md`.

## 1. Introduction

Postgres stores btree indexes on text columns in sorted order, using rules
from the system collation library — glibc or ICU. When that library is
upgraded, the sorting rules can change, and indexes built under the old rules
are no longer correctly ordered. Postgres raises no error for this. Queries
against an affected index can quietly return missing rows, sort incorrectly,
or let duplicate values past a UNIQUE constraint. From PG15 Postgres warns
about the mismatch, but offers no tooling to answer which indexes are
affected or what to run, in which order.

`inspect db collation-drift` is a read-only diagnostic that answers exactly
that. It compares the collation versions recorded in the catalogs against the
versions the operating system provides now, lists the btree indexes that may
be affected with a severity marker, and renders the complete remediation
workflow — verify with amcheck, rebuild with `REINDEX CONCURRENTLY`, then
record the new version — using the real, schema-qualified object names from
the target database. The ordering of those steps matters: refreshing the
recorded version before rebuilding removes the warning while leaving the
corruption, and the command's output says so explicitly.

## 2. What the command detects

Two sources of drift, combined in one read-only query against the system
catalogs.

The first is drift of the database default collation, typically glibc. When
the database was created, Postgres recorded the library version in
`pg_database.datcollversion`; the command compares it against
`pg_database_collation_actual_version()`. On a mismatch, every btree index
whose key columns use the default collation is listed. Databases whose
default provider is ICU are covered by the same mechanism, since PG records
`datcollversion` for them too.

The second is drift of explicitly named ICU collations — built-in ones such
as `"en-US-x-icu"` or user-created ones from `CREATE COLLATION` — on columns
that declare them, e.g. `title text COLLATE "en-US-x-icu"`. Each named
collation carries its own recorded version in `pg_collation.collversion`,
compared against `pg_collation_actual_version()`. Only collations that have
actually drifted contribute indexes to the result.

In both branches, only btree indexes are considered. That is a deliberate
scope choice rather than a claim of immunity: btree is where ordering drift
corrupts directly and overwhelmingly most often, and the only index type
amcheck can verify. Other access methods can be affected in narrower
circumstances and are listed under limitations. Constraint-backing indexes
(PRIMARY KEY,
UNIQUE) sort first and carry the ✗ marker, because a wrong sort order there
can admit duplicate rows rather than merely return wrong results. Unlike the
sibling `inspect db` commands, the internal Supabase schemas (`auth`,
`storage`, …) are included: a mis-ordered index on `auth.users` is exactly as
damaging as one in `public`.

A row in the output is a candidate, not confirmed corruption. Detection is a
catalog version comparison; only `amcheck` (step 1 of the emitted workflow)
confirms whether a given index is actually mis-ordered. The test evidence
demonstrates this distinction live: a fixture with a falsified recorded
version is flagged by the command, while amcheck correctly returns silently.

## 3. What it leaves out

Expression indexes such as `CREATE INDEX ON t (lower(name))` are not
detected: for expression columns `pg_index.indkey` holds `0` and there is no
`pg_attribute` row to resolve, so the collation buried in the expression tree
is invisible to the query. Detecting these would require parsing
`pg_get_indexdef()` output and is left as follow-up work.

Named collations using the libc provider (`CREATE COLLATION x (locale =
'de_DE.utf8')`, an uncommon pattern) are not detected: the named-collation
branch filters on the ICU provider. Postgres records versions for named libc
collations too, so widening the filter is a small planned follow-up.
Collations with no recorded version at all (`collversion IS NULL`, e.g.
created on very old versions) have nothing to compare and are skipped, as are
`C`, `POSIX` and `C.UTF-8`, whose byte-order sorting never changes — that
exclusion is correctness, not a gap.

Non-btree indexes are out of scope even where drift can affect them: BRIN
minmax indexes on text columns (the stored range bounds depend on the
ordering), GIN entry trees over collatable keys such as `text[]`, hash
indexes under nondeterministic ICU collations (equality itself is
collation-defined there), and trigram or `lower()`-based indexes via locale
character-classification changes. Postgres's own guidance — rebuild _all_
objects using the collation — remains the safe course when in doubt.

Finally, the command inspects indexes only. Collation drift can in principle
also affect other objects that depend on text ordering — range partition
bounds on text columns, CHECK constraints comparing strings, materialized
views built with ORDER BY — and none of those are examined.

## 4. Usage

```
supabase inspect db collation-drift [--local | --linked | --db-url <url>]
```

The three connection flags are mutually exclusive; `--linked` (the linked
project) is the default. `--output json` emits `{ rows, report }`, where
`rows` is the raw driver payload in the same shape as the other inspect
commands and `report` is the structured document the text renderer consumes.

The command is read-only in every mode: it issues SELECTs against system
catalogs, takes no locks of consequence, and never executes the remediation
it prints. Until the feature is released, run it from a checkout of the CLI
repository with `bun src/main.ts inspect db collation-drift …` from
`apps/cli` (or the current dev script alias), or from the pre-release npm
dist-tag once merged.

## 5. Example output

Drift detected (fixture: a named ICU collation with a stale recorded version,
one UNIQUE and one plain index on a column using it):

```
Connecting to local database...

  Database               : postgres
  Affected indexes       : 2
  Keys / unique          : 1 (a wrong sort order here can admit duplicate rows)
  Drifted ICU collations : public.test_stale_icu

  ✗  These indexes were built under different sorting rules than the system
     now provides. Postgres reports no error for this: queries may quietly
     return missing rows, sort incorrectly, or let duplicates past a unique
     constraint. Rows below are candidates and running amcheck would confirm
     which ones are actually mis-ordered.

     | Name                   | Table                       | Columns | Collation             | Stored version | Current version | Key    | Size
  ---|------------------------|-----------------------------|---------|-----------------------|----------------|-----------------|--------|------------
   ✗ | public.demo_title_uniq | public.collation_drift_demo | title   | public.test_stale_icu | 73.2           | 153.121         | UNIQUE | 8192 bytes
   ⚠ | public.demo_title_idx  | public.collation_drift_demo | title   | public.test_stale_icu | 73.2           | 153.121         |        | 8192 bytes

  1. Confirm which indexes are actually mis-ordered
     amcheck raises an error for a mis-ordered index and returns silently for
     a healthy one. Check keys and unique indexes first.

       CREATE EXTENSION IF NOT EXISTS amcheck;
       SELECT bt_index_check('public.demo_title_uniq'::regclass, heapallindexed => true);  -- unique
       SELECT bt_index_check('public.demo_title_idx'::regclass, heapallindexed => true);

  2. Rebuild the affected indexes
     Rebuild anything that failed step 1 — or all of them, which is safe if
     you would rather not check individually. CONCURRENTLY keeps the
     application online during the rebuild.

       REINDEX INDEX CONCURRENTLY public.demo_title_uniq;
       REINDEX INDEX CONCURRENTLY public.demo_title_idx;

  3. Record the new collation version — only after every rebuild has finished
     Refreshing first hides the problem without fixing it: it updates a label
     and silences the warning while leaving the indexes mis-ordered.

       ALTER COLLATION public.test_stale_icu REFRESH VERSION;
```

No drift detected:

```
Connecting to local database...

  ✓  No collation version drift detected. Indexes match the current system
     sorting rules. Re-run this check after a PostgreSQL upgrade or instance
     migration.
```

Postgres's own behaviour validates the emitted statements: during a reindex
under a live mismatch, the server's HINT prescribes character-for-character
the `ALTER COLLATION … REFRESH VERSION` statement this command generates,
schema qualification included (see the test evidence document, section 2).

## 6. PostgreSQL version support

| Capability                                      | Minimum version | Mechanism                                                                |
| ----------------------------------------------- | --------------- | ------------------------------------------------------------------------ |
| Named ICU collation drift                       | PG13            | `pg_collation.collversion` vs `pg_collation_actual_version()`            |
| Database default (libc/ICU) drift               | PG15            | `pg_database.datcollversion` vs `pg_database_collation_actual_version()` |
| `REINDEX INDEX CONCURRENTLY` (emitted)          | PG12            | —                                                                        |
| `ALTER … REFRESH [COLLATION] VERSION` (emitted) | PG13 / PG15     | collation-level / database-level                                         |

On versions below 15 the database-level branch cannot detect anything —
`datcollversion` does not exist — and the command reports what it can from
the named-collation branch. All currently supported Supabase Postgres
versions clear both thresholds. Verified live against PG 17.6.

## 7. Implementation

The command is built on the structured report model introduced alongside it
(design: `apps/cli/docs/inspect-report-output.md`). A command produces a
`Report` — a document of typed blocks: `keyValue`, `table`, `callout`, `sql`
and `steps`, each with optional severity — and per-format renderers turn the
document into terminal text (`renderReportText`, whose table blocks reuse the
existing glamour renderer) or emit it as the JSON payload. Text and JSON mode
therefore describe the same thing, which the previous spec model could not
guarantee.

The pieces sit in three files plus registration. The detection SQL and the
pure report builder live in
`src/commands/inspect/db/collation-drift/collation-drift.query.ts`: a single
statement with two `MATERIALIZED` CTE guards (so the version function is
never called for a database that records no version), a `UNION ALL` of the
default-collation and named-ICU branches, ordering that puts constraint-
backing indexes first, and TypeScript statement generators that emit the
amcheck, reindex and refresh SQL from the result rows. Identifier and literal
quoting are handled separately — `FORMAT('%I.%I')` in SQL for identifier
position, `quoteLiteral` ('' doubling) for the `::regclass` string literal —
after review found that identifier-escaped values embedded in literal
position enabled copy-paste SQL injection via crafted index names.

The engine, `src/commands/inspect/db/inspect-report.ts`, mirrors the existing
`inspect-query.ts` runner (flag exclusivity from raw argv, config resolution,
connection, the stderr connect line) but hands the rows to the spec's
`report()` function and renders the document; it deliberately does not modify
the shipped table engine. `collation-drift.command.ts` and the handler wire
the spec into the standard `inspect db` flag set, runtime layer and telemetry
(trace name `inspect.db.collation-drift`).

Because `report()` is pure — rows in, document out — the output logic is
fully unit-tested without a database (severity, block structure, ordering,
statement generation, quoting, dedup), and integration tests drive the
handler through the repo's mocked resolver/connection layers. Live behaviour,
including the full verify → rebuild → refresh lifecycle executed with only
the SQL the command emitted, is recorded in the test evidence document.
