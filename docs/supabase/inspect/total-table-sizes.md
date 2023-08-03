## total-table-sizes

This command displays the total size of each table in the database, in MB. It is calculated by using the system administration function `pg_total_relation_size()`, which includes table size, total index size and TOAST data.

```
                NAME               │    SIZE
───────────────────────────────────┼─────────────
  job_run_details                  │ 395 MB
  prod_resource_notifications      │ 299 MB
  staging_resource_notifications   │ 47 MB
  infra_alerts_to_delete           │ 18 MB
  slack_msgs                       │ 648 kB
  dunning_emails                   │ 640 kB
  project_emails                   │ 408 kB
```