# db-table-sizes

Show the size of each table, without its indexes. Size comes from `pg_table_size()`, which includes the main data fork, free space map, visibility map, and TOAST data.

```
                  NAME               │    SIZE
  ───────────────────────────────────┼─────────────
    job_run_details                  │ 385 MB
    emails                           │ 584 kB
    job                              │ 40 kB
    sessions                         │ 0 bytes
    prod_resource_notifications_meta │ 0 bytes
```
