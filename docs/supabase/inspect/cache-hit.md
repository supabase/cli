# cache-hit

This command provides information on the efficiency of the buffer cache, for both index reads (`index hit rate`) as well as table reads (`table hit rate`). A low buffer cache hit ratio can be a sign that the Heroku Postgres plan is too small for the workload.


```
      name      |         ratio
----------------+------------------------
 index hit rate | 0.99957765013541945832
 table hit rate |                   1.00
 ```