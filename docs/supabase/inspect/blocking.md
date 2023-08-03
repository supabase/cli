## blocking

This command displays statements that are currently holding locks that other statements are waiting to be released. This can be used in conjunction with `pg:locks` to determine which statements need to be terminated in order to resolve lock contention.

```
 blocked_pid │    blocking_statement    │ blocking_duration │ blocking_pid │                                        blocked_statement                           │ blocked_duration
─────────────┼──────────────────────────┼───────────────────┼──────────────┼────────────────────────────────────────────────────────────────────────────────────┼──────────────────
         461 │ select count(*) from app │ 00:00:03.838314   │        15682 │ UPDATE "app" SET "updated_at" = '2013─03─04 15:07:04.746688' WHERE "id" = 12823149 │ 00:00:03.821826
```