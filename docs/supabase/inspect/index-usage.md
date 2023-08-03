# index-usage

This command provides information on the efficiency of indexes, represented as what percentage of total scans were index scans. A low percentage can indicate under indexing, or wrong data being indexed.

```
       TABLE NAME     │ PERCENTAGE OF TIMES INDEX USED │ ROWS IN TABLE
  ────────────────────┼────────────────────────────────┼────────────────
    unindexed_table   │                              0 │        322911
    job               │                            100 │             1
    schema_migrations │                             97 │             0
    migrations        │ Insufficient data              │             0
```