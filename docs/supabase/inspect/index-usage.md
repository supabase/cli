# index-usage

This command provides information on the efficiency of indexes, represented as what percentage of total scans were index scans. A low percentage can indicate under indexing, or wrong data being indexed.

```
       TABLE NAME     │ PERCENTAGE OF TIMES INDEX USED │ ROWS IN TABLE
  ────────────────────┼────────────────────────────────┼────────────────
    user_events       │                             99 │       4225318 
    user_feed         │                             99 │       3581573
    unindexed_table   │                              0 │        322911
    job               │                            100 │         33242
    schema_migrations │                             97 │             0
    migrations        │ Insufficient data              │             0
```