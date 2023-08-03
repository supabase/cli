## total-table-sizes

This command displays the total size of each table in the database. It is the sum of the values that `pg_table_size()` and `pg_indexes_size()` gives for each table.

```
                NAME               │    SIZE
───────────────────────────────────┼─────────────
  job_run_details                  │ 395 MB
  slack_msgs                       │ 648 kB
  emails                           │ 640 kB
```