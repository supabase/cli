## total-table-sizes

This command displays the total size of each table in the database. It is calculated by using the system administration function `pg_total_relation_size()`, which includes table size, total index size and TOAST data.

```
                NAME               │    SIZE
───────────────────────────────────┼─────────────
  job_run_details                  │ 395 MB
  slack_msgs                       │ 648 kB
  emails                           │ 640 kB
```