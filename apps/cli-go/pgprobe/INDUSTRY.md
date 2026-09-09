# Industry survey: how migration tools handle transactions

Source: internal research pass over 20+ tools (verified against each tool's source and docs),
folded into this branch on 2026-09-01. One correction against our own empirical data is marked
in the "Corrections" section at the end.

## Terminology: the three transaction units

The "default tx unit" column below uses exactly three values. Two of them were previously
written inconsistently ("whole batch" vs "whole run") — they are the SAME unit; this document
now uses one name for it:

- **per statement** — each SQL statement commits on its own (autocommit). No unit spans
  statements.
- **per file** — one transaction per migration file. A failure rolls back that file only;
  files already applied in the same invocation stay applied. ORM rows that say "per migration"
  (Django, Rails, Ecto) mean the same unit: one migration class per file.
- **whole pending set** — ONE transaction spanning every pending migration file that a single
  `migrate`/`push` invocation applies (three files pending = all three plus their history rows
  commit or roll back together). This is what earlier drafts called "whole batch" (Drizzle,
  Knex, TypeORM) or "whole run" (Kysely, Alembic, Prisma 8) — same behavior, two labels.

Do not confuse "whole pending set" with the word "batch" as used in `REPORT.md` and in this
repo's code: there, a batch is the **wire-protocol** `pgconn.Batch` of one file's statements
inside a single pipeline (one Sync). That is a per-file implicit unit, not a multi-file
transaction. This table avoids the bare word "batch" for that reason.

## Four execution models exist in the wild

1. **Explicit transaction per file** — goose, dbmate, tern, sqlx, Flyway, Liquibase (per
   changeset), Atlas, Django, Rails, Ecto, Laravel, graphile-migrate.
2. **One explicit transaction for the whole pending set** — the default for most of the JS
   ecosystem (Drizzle, Knex, TypeORM `transaction: "all"`, node-pg-migrate `singleTransaction`,
   Kysely), plus Alembic (default) and the Prisma 8 runner. Flyway opt-in via `group=true`,
   Atlas via `--tx-mode all`.
3. **Implicit transaction by wire-protocol accident/design** — no `BEGIN` at all. golang-migrate
   sends the whole file as one Exec (Postgres wraps a multi-statement simple-query message in an
   implicit transaction). Classic Prisma (≤7.3) did the same, producing "atomic only if the file
   has more than one statement" ([prisma#22922](https://github.com/prisma/prisma/issues/22922)).
   **The Supabase CLI and this repo's runner are in this family**: one extended-protocol
   pipeline per file with a single trailing Sync.
4. **No transaction at all, on purpose** — Prisma ≥7.4 (Feb 2026) parses and splits SQL
   specifically to defeat the implicit transaction, running statement-by-statement in
   autocommit so `CREATE INDEX CONCURRENTLY` works, trading away atomicity entirely
   ([prisma-engines#5767](https://github.com/prisma/prisma-engines/pull/5767)). Sqitch never
   wraps (its script template ships `BEGIN;/COMMIT;` you delete yourself). pgroll rejects the
   file/transaction model altogether (expand/contract with versioned view schemas).

### The Prisma oscillation: what happens without an explicit escape hatch

Prisma has now shipped three transaction models in three years, each fixing one side of the
tradeoff by breaking the other: implicit per file (≤7.3, `CONCURRENTLY` broken) → autocommit
per statement (7.4, `CONCURRENTLY` works, atomicity gone for every migration) → one explicit
transaction for the whole pending set (8, atomicity back, `CONCURRENTLY` broken again). In
Prisma 8, `CREATE INDEX CONCURRENTLY` has NO supported path: the diff engine never generates
it, users hand-edit the SQL, isolate it in a single-statement migration, and rely on the
runner's undocumented behavior of not wrapping single-statement files — the same kind of
implementation artifact as our first-statement pipeline escape. Prisma's own docs route the
problem to lint time via a [pgfence integration guide](https://www.prisma.io/docs/guides/integrations/pgfence)
rather than offering a runtime mechanism ([prisma#14456](https://github.com/prisma/prisma/issues/14456),
[discussion #10601](https://github.com/prisma/prisma/discussions/10601)). Tools with a
per-file opt-out (goose, Flyway, dbmate, tern, sqlx, Atlas) have not needed to change their
transaction model, because the escape hatch absorbs the exception instead of forcing a
default flip. (Sourcing note: prisma.io was egress-blocked in this environment, so the
Prisma 8 specifics come from search excerpts of the official docs plus the linked issue
threads, not a full read of the docs pages.)

## Comparison table

| Tool | Default tx unit | History row atomic with DDL? | Escape hatch | Concurrent-run lock | Failed-state recovery |
|---|---|---|---|---|---|
| Prisma ≤7.3 | implicit, per file (only if multi-statement) | No | none | `pg_advisory_lock(72707369)` | failed row + `migrate resolve` |
| Prisma ≥7.4 | per statement (autocommit) | No | not needed | same | same |
| Prisma 8 `db migrate` | explicit, whole pending set | Yes | none; single-statement migrations skip the wrapper (undocumented); docs defer to pgfence lint + hand-edited SQL | advisory lock | idempotent re-run |
| Drizzle Kit | explicit, whole pending set | Yes | none ([#2624](https://github.com/drizzle-team/drizzle-orm/discussions/2624) unshipped) | none | full rollback |
| Knex | explicit, whole pending set (per-file if any file opts out) | Yes / after-commit in fallback | `exports.config = { transaction: false }` | `knex_migrations_lock` table (sticks after crash) | manual |
| TypeORM | explicit, whole pending set (`"all"`) | Yes | mode `each`/`none` + per-class `transaction = false` | none | manual |
| node-pg-migrate | explicit, whole pending set | Yes | `pgm.noTransaction()` (JS only) | `pg_try_advisory_lock(7241865325823964)` | manual |
| Kysely | explicit, whole pending set | Yes | `disableTransactions` (run-wide) | `pg_advisory_xact_lock(3853314791062309107)` | manual |
| golang-migrate | implicit, whole file as one Exec | No (separate tx) | `x-multi-statement` (per-stmt autocommit) | `pg_advisory_lock` (crc32 key) | dirty flag + `force` |
| goose | explicit, per file | Yes | `-- +goose NO TRANSACTION` | opt-in only | rollback covers it |
| dbmate | explicit, per file | Yes | `-- migrate:up transaction:false` | none ([PR #596](https://github.com/amacneil/dbmate/pull/596) open) | rollback covers it |
| tern | explicit, per file | Yes | `---- tern: disable-tx ----` | `pg_advisory_lock(9628173550095224)` | rollback covers it |
| sqlx (Rust) | explicit, per file | Yes | file starts with `-- no-transaction` | `pg_advisory_lock` | checksums |
| Flyway | explicit, per file (`group=true` → whole pending set) | Yes | sidecar `V2__x.sql.conf` with `executeInTransaction=false` | PG advisory (xact-scoped default) | `flyway repair` |
| Liquibase | explicit, per changeset | No — log row commits separately ([#7442](https://github.com/liquibase/liquibase/issues/7442)) | `runInTransaction:false` | `DATABASECHANGELOGLOCK` table (sticks after crash) | `release-locks`, manual |
| Atlas | explicit, per file (`--tx-mode file/all/none`) | Yes + per-statement progress | `-- atlas:txmode none` header | PG advisory (`atlas_migrate_execute`) | per-statement resume |
| Sqitch | none (template ships `BEGIN;/COMMIT;`) | No (registry on separate connection) | delete the BEGIN/COMMIT | `pg_advisory_lock(75474063)` | your revert scripts |
| Django | explicit, per migration | Yes (mostly) | `atomic = False` | none | manual |
| Rails | explicit, per migration | Yes | `disable_ddl_transaction!` | PG advisory lock | manual |
| Alembic | explicit, whole pending set (default) | Yes | `autocommit_block()` + `transaction_per_migration=True` | none | manual |
| Ecto | explicit, per migration | — | `@disable_ddl_transaction true` | locks `schema_migrations` / advisory | manual |
| Supabase CLI (today) | implicit, per file (pipelined batch, one Sync) | Yes — history INSERT rides in the final batch | auto-detect + standalone exec; authored `BEGIN/COMMIT`; `-- pg-delta: transaction=false` | none | manual |
| supabase/branching (today) | implicit, per file (pipelined batch, one Sync) | Yes | `-- pg-delta: transaction=false` (CLI-2280 branch); no classifier | none | manual |

## Escape-hatch taxonomy

1. **In-file comment directive** (most common in SQL-first tools): goose, dbmate, tern, sqlx,
   graphile-migrate, Atlas, Bytebase, Liquibase formatted SQL — and pg-delta's
   `-- pg-delta: transaction=false`.
2. **Sidecar/config file**: Flyway's `V2__x.sql.conf` (there is no inline Flyway directive —
   a common misconception, disproved against Flyway's parser source).
3. **Code-level flag** (ORM-style): Django, Rails, Ecto, Laravel, Knex, TypeORM,
   node-pg-migrate.
4. **Automatic statement detection** — only two tools: **Flyway** (hard-coded statement list;
   all-non-transactional files auto-run unwrapped; mixed files are an ERROR unless
   `mixed=true`) and **the Supabase CLI** (`legacyIsPipelineIncompatible`: flush the batch, run
   the statement standalone, resume). **Atlas** shifts detection to lint time instead (its
   `concurrent_index` analyzer demands the `txmode none` directive).
5. **Granularity switches**: Alembic `autocommit_block()` mid-migration; TypeORM forbids
   per-migration overrides in `"all"` mode; Kysely's opt-out is run-wide.

### A trap several tools fall into

If the "no transaction" file is executed as ONE simple-query Exec (dbmate, sqlx,
node-pg-migrate `.sql` files), Postgres's implicit multi-statement transaction still applies —
so the file must contain exactly one statement or `CREATE INDEX CONCURRENTLY` still fails.
goose and tern avoid this by splitting statements in no-tx mode. **Our directive paths (TS CLI
and the CLI-2280 branching port) also split and run one statement per Sync — this must stay a
stated invariant.**

## Two dimensions beyond the wrapping itself

**History-row atomicity.** Tools whose version-row insert shares the migration's transaction
(goose, dbmate, tern, sqlx, Flyway, Atlas, Rails, the JS batch tools) need no repair machinery.
Tools where it does not are exactly the ones with dirty-state ceremony: golang-migrate's
`dirty` flag + `force`, Prisma's `migrate resolve`, Flyway `repair`, Liquibase's documented
applied-but-unrecorded crash window ([#7442](https://github.com/liquibase/liquibase/issues/7442)).
Supabase (CLI and branching) is on the right side of this line today; keep it that way as an
explicit, tested invariant.

**Concurrent-run locking.** Most serious tools take a Postgres advisory lock (Prisma, Rails,
Ecto, Flyway, Atlas, Sqitch, golang-migrate, tern, sqlx, node-pg-migrate). Two lessons:
Flyway's default transaction-scoped advisory lock CONFLICTS with `CREATE INDEX CONCURRENTLY`
(they had to add a session-lock option), so any lock we add must be **session-scoped**; and
lock TABLES (Liquibase, Knex) are the ones notorious for sticking after a crash. Notably
lock-free today: Django, Alembic, Drizzle, TypeORM, dbmate — and both Supabase runners.

## Corrections against our empirical data

The research above states the Supabase CLI's pipeline "gives the same atomicity as an explicit
transaction." [`REPORT.md`](./REPORT.md) disproves equivalence on both production majors:

- `LOCK TABLE` fails inside the pipeline (25P01) but works in a real transaction (scenario S3).
- The first statement of a batch escapes the implicit transaction entirely (S4a).
- A failed batch after a `CREATE INDEX CONCURRENTLY` leaves an INVALID index (S4b, S5),
  which no real transaction can produce.

Correct claim: same atomicity for files containing only plainly transactional statements;
not equivalent in general.
