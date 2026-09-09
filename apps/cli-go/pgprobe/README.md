# pgprobe: pipeline vs transaction semantics for migration files

Ported verbatim from [`supabase/branching@claude/pgprobe-transaction-report`](https://github.com/supabase/branching/tree/claude/pgprobe-transaction-report/pgprobe)
(2026-09-01) so the research lives next to the runner it was measuring:
`pkg/migration/file.go`'s `MigrationFile.ExecBatch` in this repo is the same
pipeline implementation branching's copy was probed against.

Everything for the CLI-2280 / supabase/cli#6347 / CLI-2261 migration-transaction
discussion, in one place:

- [`SUMMARY.md`](./SUMMARY.md): plain-language explanation. What is wrong, why it
  used to work, why it broke, what works today and what does not. Start here.
- [`REPORT.md`](./REPORT.md): the empirical evidence. Methodology, per-version
  result tables, findings, run against the exact Postgres server versions shipped
  in `supabase/postgres:15.8.1.085` and `supabase/postgres:17.6.1.106`.
- [`INDUSTRY.md`](./INDUSTRY.md): survey of 20+ migration tools (execution models,
  escape hatches, history-row atomicity, advisory locks), plus a correction where
  the survey overstated pipeline/transaction equivalence.
- [`RECOMMENDATION.md`](./RECOMMENDATION.md): options with tradeoffs, the
  recommended end state, invariants to test, and the step-by-step action plan.
- `main.go`: the probe. Self-contained, reads `PGPROBE_URL`, writes a markdown
  result table to stdout. The `pipeline` model reproduces this repo's
  `MigrationFile.ExecBatch` byte for byte (one `pgconn.Batch`, single Sync).

## Reproduce

```sh
docker run -d --name probe15 -p 54315:5432 -e POSTGRES_PASSWORD=postgres supabase/postgres:15.8.1.085
docker run -d --name probe17 -p 54317:5432 -e POSTGRES_PASSWORD=postgres supabase/postgres:17.6.1.106

cd pgprobe
PGPROBE_URL="postgres://postgres:postgres@127.0.0.1:54315/postgres" go run .
PGPROBE_URL="postgres://postgres:postgres@127.0.0.1:54317/postgres" go run .
```

Any Postgres >= 15.2 reproduces the same table. Scenarios use fresh object
names per run within one server lifetime; recreate the containers (or point at
a scratch database) before re-running.

## Headline results (identical on 15.8 and 17.6)

| scenario | pipeline (branching today) | explicit BEGIN/COMMIT | sequential autocommit |
|---|---|---|---|
| plain file, mid-file failure | atomic rollback | atomic rollback | partial apply |
| pg-delta layout (`SET; CREATE INDEX CONCURRENTLY; RESET ALL`) | 25001 | 25001 | applies, index valid |
| `LOCK TABLE` before `ALTER` | 25P01 | works | 25P01 |
| standalone CIC file, failing history insert | **INVALID index left behind** | n/a | n/a |
| two CIC in one file | 25001, first index INVALID | n/a | both valid |

See `REPORT.md` for the full tables and interpretation.
