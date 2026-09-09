# Plain-language summary: what is wrong with the current approach

Audience: anyone joining the CLI-2280 / CLI-2261 / supabase/cli#6347 discussion cold.
Evidence for every claim: [`REPORT.md`](./REPORT.md) (empirical, PG 15.8 + 17.6) and the linked issues.

## The one-sentence problem

We never open a real transaction. Migration atomicity rides on a wire-protocol side effect,
and Postgres gives that side effect contradictory rules.

## What we do today

- The runner sends all statements of a migration file in one batch with a single Sync
  (an extended-protocol "pipeline"). No `BEGIN`, no `COMMIT`.
- Postgres treats the batch as a semi-transaction: an error anywhere throws the whole batch away.
- So we got atomicity for free. That is the entire reason this design exists.

## Why that is broken

Postgres answers "am I inside a transaction?" differently depending on who asks:

- `CREATE INDEX CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, `CLUSTER` must NOT be in a
  transaction. Inside a pipeline, Postgres says "you are in one" and refuses (SQLSTATE 25001).
- `LOCK TABLE`, `SET LOCAL` must BE in a transaction. Inside the same pipeline, Postgres says
  "you are not in one" and refuses (SQLSTATE 25P01).

Same batch, same connection, opposite answers. Whichever answer forbids the statement is the
one the server gives.

## Why it used to work

- Postgres 15.1 and older had a server bug: the "you are inside a transaction" check was never
  applied to pipelines. `CREATE INDEX CONCURRENTLY` in migrations worked for years by accident.
- Postgres 15.2 fixed the bug (February 2023).
- CLI v1.223.1 (November 2024) bumped the bundled image from 15.1 to 15.6 and users' migrations
  "broke" ([supabase/cli#2898](https://github.com/supabase/cli/issues/2898)). Nothing broke;
  the server started enforcing a rule that was always meant to apply.
- Verified here on 15.8 and 17.6 (the servers inside `supabase/postgres:15.8.1.085` and
  `:17.6.1.106`): identical behavior. There is no difference between the production fleets.

## One quirk that explains the folklore

The first statement of a batch runs before Postgres decides "this is an implicit transaction."
It escapes the 25001 check. That is the only reason the advice "put `CREATE INDEX CONCURRENTLY`
alone in its own migration file" works at all.

## Scoreboard (all rows verified on 15.8 and 17.6)

| Migration file | Pipeline result | Why |
|---|---|---|
| Plain SQL, one statement fails mid-file | Full rollback (good) | the batch throw-away rule; this part of the atomicity claim is true |
| pg-delta output: `SET …; CREATE INDEX CONCURRENTLY …; RESET ALL;` | Fails, 25001 | the action is the second statement, so it is "inside a transaction" |
| `CREATE INDEX CONCURRENTLY` alone in a file, happy path | Works | first-statement escape |
| Same standalone file, but the history insert fails | INVALID index left behind, no history row, plain retry fails | the index's final "mark valid" step rides in the batch and dies with it |
| Two `CONCURRENTLY` indexes in one file | Fails, first index left INVALID | the second one is no longer the first statement |
| `LOCK TABLE` before an `ALTER` | Fails, 25P01 | the pipeline is "not" a transaction block for this check |

The fourth row is the decisive one: the officially recommended workaround corrupts state
when it fails.

## Why no tool can make everything atomic

`CREATE INDEX CONCURRENTLY` commits several internal transactions by design; that is how it
avoids locking writes to the table. No execution strategy makes it atomic, and Postgres itself
cannot roll a failed one back (it leaves an INVALID index you must drop manually). Every
migration tool therefore ends at the same fork: wrap in a real transaction and reject these
statements, run them outside the wrapper, or refuse and make the author isolate them.
See [`INDUSTRY.md`](./INDUSTRY.md) for how 20+ tools chose.

## Where each conclusion comes from

- Pipeline contradiction and probe: [`REPORT.md`](./REPORT.md), [supabase/cli#6347](https://github.com/supabase/cli/issues/6347)
- History of the accident: [supabase/cli#2898](https://github.com/supabase/cli/issues/2898)
- Classifier provenance: [supabase/cli#5139](https://github.com/supabase/cli/issues/5139),
  [#5156](https://github.com/supabase/cli/pull/5156) (closed unmerged),
  [#5671](https://github.com/supabase/cli/pull/5671) (adopted), [#6276](https://github.com/supabase/cli/pull/6276)
- Directive provenance: [supabase/cli#6102](https://github.com/supabase/cli/pull/6102)
- Proposed fix: [supabase/cli#6354](https://github.com/supabase/cli/pull/6354) (CLI-2261)
- Decision and plan: [`RECOMMENDATION.md`](./RECOMMENDATION.md)
