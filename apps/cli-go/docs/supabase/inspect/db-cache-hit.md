# db-cache-hit

This command provides information on the efficiency of the buffer cache and how often your queries have to go hit the disk rather than reading from memory. Information on both index reads (`index hit rate`) as well as table reads (`table hit rate`) are shown. In general, databases with low cache hit rates perform worse as it is slower to go to disk than retrieve data from memory. If your table hit rate is low, this can indicate that you do not have enough RAM and you may benefit from upgrading to a larger compute addon with more memory. If your index hit rate is low, this may indicate that there is scope to add more appropriate indexes.

The hit rates are calculated as a ratio of number of table or index blocks fetched from the postgres buffer cache against the sum of cached blocks and uncached blocks read from disk.

On smaller compute plans (free, small, medium), a ratio of below 99% can indicate a problem. On larger plans the hit rates may be lower but performance will remain constant as the data may use the OS cache rather than Postgres buffer cache.

```
         NAME      │  RATIO
  ─────────────────┼───────────
    index hit rate │ 0.996621
    table hit rate │ 0.999341
 ```