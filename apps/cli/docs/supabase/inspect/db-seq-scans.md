# db-seq-scans

Show the number of sequential scans on each table, highest first. Tables with very high counts may be under-indexed, so look at the queries that read from them.

```
                  NAME               │ COUNT
  ───────────────────────────────────┼─────────
    emails                           │ 182435
    users                            │  25063
    job_run_details                  │     60
    schema_migrations                │      0
    migrations                       │      0
```
