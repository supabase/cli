# table-sizes

This command displays the size of each table in the database. It is calculated by using the system administration function `pg_table_size()`, which includes the size of the main data fork, free space map, visibility map and TOAST data.


```
                  NAME               │    SIZE
  ───────────────────────────────────┼─────────────
    job_run_details                  │ 385 MB
    emails                           │ 584 kB
    job                              │ 40 kB
    sessions                         │ 0 bytes
    prod_resource_notifications_meta │ 0 bytes
```