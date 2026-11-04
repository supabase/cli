# db-table-record-counts

Show the estimated number of rows in each table, highest first. The estimate comes from `n_live_tup`, which vacuum operations update, so sparse or dense pages can make it differ a lot from the real row count.

```
       NAME    │ ESTIMATED COUNT
  ─────────────┼──────────────────
    logs       │          322943
    emails     │            1103
    job        │               1
    migrations │               0
```
