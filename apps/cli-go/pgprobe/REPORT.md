# Migration execution models on Postgres 15.8 and 17.6: empirical report

Date: 2026-09-01. Context: CLI-2280 / supabase/cli#6347 / CLI-2261 transaction-semantics discussion.

## What was tested

A Go probe (`pgprobe/main.go`, pgx v5 pinned to branching's go.mod version) runs the same
migration files under three execution models and then inspects the resulting database state:

| model | wire behavior | who uses it |
|---|---|---|
| `pipeline` | one `pgconn.Batch`, anonymous `ExecParams` per statement, **single Sync** | branching `MigrationFile.ExecBatch` today; old Go CLI |
| `explicit-txn` | sequential statements wrapped in `BEGIN`/`COMMIT`, `ROLLBACK` on error | supabase/cli#6354 (CLI-2261) proposal |
| `autocommit` | sequential statements, one Sync each, no wrapper | pg-delta `-- pg-delta: transaction=false` directive model (CLI-2280) |

The `pipeline` implementation is byte-for-byte what branching ships: `batch.ExecParams(stmt, nil, nil, nil, nil)`
per statement, then `conn.PgConn().ExecBatch(ctx, batch).ReadAll()`.

## Server provenance (read this)

The org egress policy in this sandbox denies every container-registry blob CDN
(Docker Hub CloudFront and ghcr `pkg-containers.githubusercontent.com`), so the actual
`supabase/postgres` images could not be pulled here. The probe ran instead against standalone
Postgres server binaries at the **exact server versions inside the production images**:

- Postgres **15.8** = server in `supabase/postgres:15.8.1.085` (branching's pinned pg15)
- Postgres **17.6** = server in `supabase/postgres:17.6.1.106` (branching's Dockerfile template)

Everything under test is core backend behavior (`PreventInTransactionBlock` /
`RequireTransactionBlock` / implicit-transaction handling in `postgres.c`), which the Supabase
image does not patch. To reproduce on the real images, run on any machine with registry access:

```sh
docker run -d --name probe15 -p 54315:5432 -e POSTGRES_PASSWORD=postgres supabase/postgres:15.8.1.085
PGPROBE_URL="postgres://postgres:postgres@127.0.0.1:54315/postgres" go run ./pgprobe
docker run -d --name probe17 -p 54317:5432 -e POSTGRES_PASSWORD=postgres supabase/postgres:17.6.1.106
PGPROBE_URL="postgres://postgres:postgres@127.0.0.1:54317/postgres" go run ./pgprobe
```

## Results

Both servers produced **identical** results. One table covers both PG 15.8 and PG 17.6.

| scenario | approach | result | database state afterwards |
|---|---|---|---|
| S1 plain file, mid-file failure | pipeline | 23505 unique violation | both tables absent (rolled back) |
| S1 plain file, mid-file failure | explicit-txn | 23505 unique violation | both tables absent (rolled back) |
| S1 plain file, mid-file failure | autocommit | 23505 unique violation | first table EXISTS (partial apply) |
| S2 pg-delta layout: SET; CIC; RESET ALL | pipeline | **25001** cannot be executed within a pipeline | index absent |
| S2 pg-delta layout: SET; CIC; RESET ALL | explicit-txn | **25001** cannot run inside a transaction block | index absent |
| S2 pg-delta layout: SET; CIC; RESET ALL | autocommit | OK | index EXISTS (valid) |
| S3 LOCK TABLE before ALTER (#6347) | pipeline | **25P01** only in transaction blocks | column absent |
| S3 LOCK TABLE before ALTER (#6347) | explicit-txn | OK | column EXISTS |
| S3 LOCK TABLE before ALTER (#6347) | autocommit | **25P01** only in transaction blocks | column absent |
| S4a standalone CIC file + history insert (happy path) | pipeline | OK | index EXISTS (valid) |
| S4b standalone CIC file + FAILING history insert | pipeline | 23505 unique violation | **index EXISTS (INVALID)**, no history row |
| S5 two CIC indexes in one file | pipeline | **25001** on the second | **first index EXISTS (INVALID)**, second absent |
| S5 two CIC indexes in one file | autocommit | OK | both indexes EXIST (valid) |
| S6 authored `BEGIN/COMMIT` + `LOCK TABLE` in the file | pipeline | OK | column EXISTS |
| S6 authored `BEGIN/COMMIT` + `LOCK TABLE` in the file | autocommit | OK | column EXISTS |
| S7 authored `COMMIT` mid-file, later statement fails | pipeline | 42P01 | table EXISTS (partial apply) |
| S7 authored `COMMIT` mid-file, later statement fails | naive runner `BEGIN/COMMIT` | 42P01 | table EXISTS with rows (partial apply) |

CIC = `CREATE INDEX CONCURRENTLY`.

## Findings

**F1. The pipeline IS atomic for plain files (S1).** Qiao's claim holds for the common case:
a mid-file failure rolls back every earlier statement in the batch, identically to an explicit
transaction. The autocommit model does not have this property; that is the documented tradeoff
the directive opts into.

**F2. The pipeline is not a transaction block when a statement requires one (S3).** `LOCK TABLE`
fails with 25P01 inside the pipeline on both production majors. Only the explicit transaction
runs it. This reproduces supabase/cli#6347 exactly and shows the pipeline satisfies neither
statement class: 25001 says "you are in a transaction," 25P01 says "you are not."

**F3. The pg-delta layout cannot run under either transactional model (S2).** The generated
file's action is never its first statement (session preamble precedes it), so the pipeline
rejects it, and the explicit transaction rejects it too. Only sequential autocommit applies it.
The `transaction=false` directive is therefore load-bearing: no amount of "move it to its own
file" fixes a file whose preamble, action, and cleanup must share a session.

**F4. The officially advised standalone-CIC pattern is not atomic and leaves corrupt debris on
failure (S4).** On the happy path it works (S4a), which is why the advice appears sound. But when
the history insert in the same batch fails (S4b), the batch reports the error, records no history
row, and leaves the index behind in an **INVALID** state: it penalizes writes without serving
reads, a plain retry of the file then fails on "already exists," and an `IF NOT EXISTS` retry
silently keeps the broken index. The reason: CIC's final "mark valid" participates in the
implicit transaction that only commits at Sync, so aborting the batch strands the index mid-build.

**F5. Two CIC statements in one file corrupt state under the pipeline (S5).** The first index is
left INVALID, the second is never created. Sequential autocommit builds both correctly. This is
the supabase/cli#2898 comment-thread case, now with the state inspected.

**F6. The behavior is identical on 15.8 and 17.6.** This is not version drift between the
production fleets; it is the settled server behavior everywhere at or above 15.2.

**F7. Authors CAN opt into a real transaction block under the pipeline (S6).** A file that
writes its own `BEGIN … COMMIT` gets genuine transaction-block semantics, so `LOCK TABLE`
works when the author wraps it explicitly. This validates the claim that pipeline mode leaves
an author-side escape valve; the #6347 failure applies to files that relied on the runner's
implicit wrapping rather than writing their own.

**F8. Authored transaction control breaks file atomicity under EVERY runner model (S7).** A
file containing its own mid-file `COMMIT` is partially applied on later failure under the
pipeline AND under a naive runner-added `BEGIN/COMMIT` (where the authored `COMMIT` commits
the runner's wrapper early and the rest runs autocommit). The conclusion is not "never wrap":
it is that any runner-added wrapper must detect authored transaction control and execute such
files as written, stepping aside from its own wrapping. The TS CLI already ships exactly this
detection (`legacyHasTransactionControl`), and shipped runner-added `BEGIN/COMMIT` with it
from v2.109.0 through v2.114.x (supabase/cli#5671) — the `LOCK TABLE` regression (#6347)
appeared only when v2.115.0 (#6224) replaced that wrapping with the pipeline.

## Conclusion

- "Pipeline mode guarantees atomicity" is true only for files containing nothing but plainly
  transactional statements. In every scenario involving the statements this discussion is about,
  the pipeline either rejects the file (S2, S3) or breaks atomicity while leaving invalid catalog
  state behind (S4b, S5).
- The explicit-transaction model (CLI-2261) is a strict upgrade for transactional files: same
  atomicity as the pipeline (S1) plus the `LOCK TABLE` class the pipeline rejects (S3).
- It must be paired with an opt-out for statements that can never run in any transaction (S2):
  the pg-delta directive for generated files, the classifier (or a hard error with a
  "move it to its own file" hint) for hand-written SQL.
