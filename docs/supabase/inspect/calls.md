# calls

This command is much like [outliers](./outliers.md), but ordered by the number of times a statement has been called.

```
                 Query                   | TOTAL EXECUTION TIME | PROPORTION OF TOTAL EXEC TIME | NUMBER CALLS | SYNC IO TIME
-----------------------------------------+------------------+----------------+-------------+--------------
 SELECT * FROM usage_events WHERE (alp.. |     01:18:11.073333  | 0.6%           | 102,120,780 | 00:00:00
 BEGIN                                   |     00:00:51.285988  | 0.0%           | 47,288,662  | 00:00:00
 COMMIT                                  |     00:00:52.31724   | 0.0%           | 47,288,615  | 00:00:00
 SELECT * FROM  archivable_usage_event.. |     154:39:26.431466 | 72.2%          | 34,211,877  | 00:00:00
 UPDATE usage_events SET reporter_id =.. |     00:52:35.986167  | 0.4%           | 23,788,388  | 00:00:00
 INSERT INTO usage_events (id, retaine.. |     00:49:25.260245  | 0.4%           | 21,990,326  | 00:00:00
 INSERT INTO usage_events (id, retaine.. |     01:42:59.436532  | 0.8%           | 12,328,187  | 00:00:00
 SELECT * FROM app_ownership_events   .. |     00:19:06.289521  | 0.1%           | 744,976     | 00:00:00
 INSERT INTO app_ownership_events(id, .. |     00:26:59.885631  | 0.2%           | 383,153     | 00:00:00
 UPDATE app_ownership_events SET app_i.. |     00:01:22.282337  | 0.0%           | 359,741     | 00:00:00
 ```