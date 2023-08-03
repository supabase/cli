# seq-scans

This command displays the number of sequential scans recorded against all tables, descending by count of sequential scans. Tables that have very high numbers of sequential scans may be underindexed, and it may be worth investigating queries that read from these tables.


```
                  NAME               │ COUNT
  ───────────────────────────────────┼─────────
    emails                           │ 182435
    users                            │  25063
    job_run_details                  │     60
    schema_migrations                │      4
    staging_resource_notifications   │      2
    schema_migrations                │      0
    migrations                       │      0
```

