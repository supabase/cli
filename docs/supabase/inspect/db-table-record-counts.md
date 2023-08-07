# db-table-record-counts

This command displays an estimated count of rows per table, descending by estimated count. The estimated count is derived from `n_live_tup`, which is updated by vacuum operations. Due to the way `n_live_tup` is populated, sparse vs. dense pages can result in estimations that are significantly out from the real count of rows.


```
       NAME    │ ESTIMATED COUNT
  ─────────────┼──────────────────
    logs       │          322943
    emails     │            1103
    job        │               1
    migrations │               0
```