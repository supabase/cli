# db-cache-hit

Show how often queries read from the buffer cache instead of going to disk, for both table reads (`table hit rate`) and index reads (`index hit rate`). Databases with low hit rates generally perform worse, because reading from disk is slower than reading from memory.

Each rate is the share of blocks fetched from the Postgres buffer cache out of all blocks read, cached or not. On smaller compute plans (free, small, medium), a ratio below 99% can indicate a problem. On larger plans the rates may be lower without affecting performance, because data can come from the OS cache.

A low table hit rate can mean you need more RAM, so consider a larger compute add-on. A low index hit rate can mean you need more appropriate indexes.

```
         NAME      │  RATIO
  ─────────────────┼───────────
    index hit rate │ 0.996621
    table hit rate │ 0.999341
```
