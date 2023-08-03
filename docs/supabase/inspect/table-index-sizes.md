# table-index-sizes

This command displays the total size of indexes for each table, in MB. It is calcualtes by using the system administration function `pg_indexes_size()`.

```
                 TABLE               │ INDEX SIZE
  ───────────────────────────────────┼─────────────
    job_run_details                  │ 10104 kB
    users                            │ 128 kB
    job                              │ 32 kB
    instances                        │ 8192 bytes
    http_request_queue               │ 0 bytes
```