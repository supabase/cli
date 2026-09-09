# Recommendation and action plan

Decision input: [`SUMMARY.md`](./SUMMARY.md) (plain-language problem statement),
[`REPORT.md`](./REPORT.md) (empirical evidence, PG 15.8 + 17.6),
[`INDUSTRY.md`](./INDUSTRY.md) (how 20+ tools handle this).

## Options considered

### 1. Keep the pipeline, bare (status quo with no escapes)

- Cost: pg-delta output cannot run; `LOCK TABLE` mid-file fails unless the author knows to
  wrap it; failures around `CREATE INDEX CONCURRENTLY` leave INVALID indexes; the implicit
  semantics belong to the Postgres server and changed under us once already (15.1 → 15.2).
- Benefit: zero work; atomicity for plain files (S1); authors can opt into a real transaction
  block with their own `BEGIN`/`COMMIT` (S6).
- Verdict: rejected bare. Retained as the DEFAULT execution model when paired with the
  directive escape and detection hints below (see the v2 end state).

### 2. Runner-added explicit `BEGIN`/`COMMIT` per file

- Benefit: true atomicity with real rollback; fixes `LOCK TABLE` (supabase/cli#6347) without
  author action.
- Cost: `CONCURRENTLY`/`VACUUM`/`ALTER SYSTEM` fail in EVERY file, including standalone ones
  (these statements are non-atomic by design), so it needs an escape hatch regardless; a
  runner wrapper must also detect authored `BEGIN`/`COMMIT` and step aside or it breaks such
  files (scenario S7); and it changes the shipped default again (the Prisma oscillation).
- Verdict: not taken as the default. S6 shows authors get a real transaction block by writing
  `BEGIN`/`COMMIT` themselves, so the runner recommends that instead of adding one silently.

### 3. Whole-batch transaction (one txn for the whole pending run)

- The JS-ecosystem default (Drizzle, Knex, Alembic). Long-held locks, large WAL,
  everything-or-nothing deploys, an even larger `CONCURRENTLY` conflict surface.
- Verdict: rejected for a hosted-Postgres platform.

### 4. Autocommit everything (Prisma ≥7.4)

- Buys `CONCURRENTLY` support by giving up atomicity for every migration.
- Verdict: rejected; atomicity for ordinary files is the property users depend on most.

### 5. Expand/contract (pgroll)

- A different product, not an execution-model fix. Interesting long-term for branching;
  out of scope for this decision.

## Recommended end state (v2, thread consensus 2026-09-01)

Supersedes the v1 draft (runner-added `BEGIN`/`COMMIT` as default), revised after the Slack
discussion and the S6/S7 probe results: authors already get a real transaction block by
writing `BEGIN`/`COMMIT` (S6), any runner wrapper needs authored-control detection anyway
(S7), and flipping the shipped default again repeats the Prisma oscillation.

- **Default: the per-file pipeline stays.** One implicit unit per file, atomic for plain
  files (S1), history insert in the same batch. The runner never adds `BEGIN`/`COMMIT`.
- **Real transaction block on demand: the author writes it.** `BEGIN … COMMIT` in the file is
  honored as written (S6; the TS runner's authored-control detection already exists and comes
  to branching with the port). This is the documented answer for `LOCK TABLE`/`SET LOCAL`.
- **Nontransactional files: exact-match first-line directive**, recognized from the
  config-driven list (see "Config shape" below). The whole file runs statement-by-statement in
  autocommit; history row after full success. Covers pg-delta output and hand-authored files
  without relying on the first-statement pipeline escape.
- **Detect and recommend, never silently rewrite.** When an unmarked file contains a
  statement that cannot run in the pipeline, the executors say so and print the fix: the
  project's configured directive for `CONCURRENTLY`-class statements, an authored
  `BEGIN`/`COMMIT` for `LOCK TABLE`-class statements. The CLI's existing classifier auto-split
  keeps working for compatibility (v2.109+ repos rely on it) but gains the warning; whether it
  is eventually demoted to error-only is the remaining open decision.
- **Both runners identical**: CLI and branching apply the same model from the same code.

### Invariants to state and test

1. **History-row atomicity.** Transactional path: a failed file leaves neither DDL nor a
   history row. Non-transactional path: the history row is written only after every statement
   succeeds. This is what separates tools with no repair ceremony from tools with `dirty`
   flags and `repair` commands.
2. **Unwrapped files run one statement per Sync.** Never execute a no-transaction file as a
   single Exec or single pipeline; Postgres's implicit transaction would resurrect the bug
   (the dbmate/sqlx trap in `INDUSTRY.md`).
3. **Any advisory lock is session-scoped.** A transaction-scoped advisory lock conflicts with
   `CREATE INDEX CONCURRENTLY` (Flyway learned this in production). Prefer advisory locks over
   lock tables (stuck-lock-after-crash pathology).

### Accepted tradeoffs

- A directive-marked (or classifier-split) file is intentionally non-atomic: a mid-file
  failure leaves earlier statements applied, with no history row, so the failure is visible.
  Unavoidable; CIC is non-atomic by physics. Mitigate with `IF NOT EXISTS` guidance and the
  error hints below.
- Keeping the pipeline keeps its two quirks for UNMARKED files: the first-statement escape
  (S4) and INVALID-index debris when a directive-less CIC file fails mid-batch (S4b, S5). The
  directive plus the detection hints exist precisely to steer files out of that path; the
  quirks stay documented, not load-bearing.
- `LOCK TABLE`-class statements require author action (write your own `BEGIN`/`COMMIT`), with
  the runner's hint carrying the fix. Chosen over silent runner wrapping (S7, qiao's
  objection, the Prisma oscillation).

## Action plan (v2)

| # | Action | Where | Status |
|---|---|---|---|
| 1 | Honor `-- pg-delta: transaction=false` in branching (CLI-2280) | [supabase/branching#910](https://github.com/supabase/branching/pull/910) | implemented + tested, in review |
| 2 | `[db.migrations] no_transaction_directives` exact-match list, threaded through both matchers | `@supabase/config` + branching `pkg/config` + both executors (new Linear issue, successor to CLI-2280) | spec below, not started |
| 3 | Detection hints: 25001 → print the project's configured directive + "own migration file"; 25P01/`SET LOCAL` → recommend authored `BEGIN`/`COMMIT` | CLI + branching | not started; the 25P01 half is the v2 resolution of supabase/cli#6347 — align with CLI-2261/#6354 owners on repurposing that PR |
| 4 | Classifier keeps auto-split, gains the warning recommending the directive | CLI (`legacy-migration-apply.ts`) | not started; preserves v2.109+ compatibility |
| 5 | Lint-time warning for mid-file `CONCURRENTLY`/`LOCK TABLE` (Atlas/strong_migrations pattern) | CLI (`db push` / CI lint) | not started; non-breaking strictness |
| 6 | Session-scoped advisory lock around migration runs | CLI + branching (new Linear issue) | not started; gap found by the industry survey |
| 7 | Re-converge branching `pkg/migration` with the CLI's copy so the model cannot drift again | `supabase/branching` | after 2 to 4 settle |
| 8 | Optional: pg-delta slims the generated preamble for nontransactional units | pg-toolbelt | shrinks the non-atomic surface; directive still required |

## Config shape (thread direction, 2026-09-01)

Following the Slack discussion (qiao: put the option in `config.toml`; avoid inventing new
syntax), the per-file escape stays an in-file first-line comment, and `config.toml` decides
WHICH exact comment lines the executors recognize:

```toml
[db.migrations]
# Exact first-line comments that mark a migration file as nontransactional.
# Matched with plain string equality against the file's first line.
no_transaction_directives = [
  "-- pg-delta: transaction=false",
]
# users may add the marker their previous tool used, eg:
#   "-- +goose NO TRANSACTION",
#   "-- migrate:up transaction:false",
```

### Matching semantics (identical to the shipped pg-delta directive, generalized to N strings)

1. Strip one optional UTF-8 BOM.
2. Take the file's first line: up to the first LF, minus one trailing CR.
3. Compare with plain string equality (byte-for-byte) against each configured entry.
   No trimming, no case folding, no substring or prefix matching.
4. On a match, the whole file runs statement-by-statement in autocommit (one statement per
   Sync, never a single multi-statement Exec — see the dbmate/sqlx trap in `INDUSTRY.md`),
   and the history row is written only after every statement succeeds.

Both executors reuse their existing matcher with the list swapped in: branching's
`peekNoTransactionDirective` (pkg/migration/file.go) and the TS CLI's
`legacyParseMigrationContent` are already exactly steps 1 to 3 for the single pg-delta string.

### Rules

- The pg-delta entry is built in and cannot be removed by config: pg-delta generates files
  carrying it, and generated files must mean the same thing in every project. The config list
  ADDS entries.
- Validation: each entry must start with `--` (a line comment; anything else would be an
  executable statement), must be non-empty after the dashes, no duplicates.
- Entries are matched verbatim, typos included. The classifier warning for an unmarked
  nontransactional file should print the project's configured directives so authors copy an
  exact string instead of retyping one.

### Known limits, accepted

- Exact first-line equality is "bring your marker", not tool emulation: a real goose file
  whose `-- +goose NO TRANSACTION` sits below `-- +goose Up` will not match. Emulating each
  tool's real grammar was considered and rejected in favor of matching simplicity.
- With configurable recognition, one SQL file can execute differently under two projects'
  configs. Accepted because it is opt-in and the always-on pg-delta entry keeps generated
  files portable.
- Older executor builds ignore the config key, so extra directives silently run
  transactionally there. Standard new-config caveat; one line in docs.

## Open decisions for the team

1. Runtime strictness for hand-written SQL: keep the classifier's auto-split with the new
   warning (action 4), or eventually adopt Flyway's policy (mixed files error unless
   explicitly allowed). The lint warning (action 5) is the non-breaking first move; the strict
   version needs a deprecation window because repos have relied on auto-split since June 2026
   (v2.109.0).
2. Fate of supabase/cli#6354 (CLI-2261): under v2 the pipeline stays, so the PR's runner-added
   `BEGIN`/`COMMIT` is not the direction. Repurpose it into the 25P01 detection hint (action
   3) or close it, with its owners.
