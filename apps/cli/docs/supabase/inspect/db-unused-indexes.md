# db-unused-indexes

This command displays indexes that have < 50 scans recorded against them, and are greater than 5 pages in size, ordered by size relative to the number of index scans. This command is generally useful for discovering indexes that are unused. Indexes can impact write performance, as well as read performance should they occupy space in memory, its a good idea to remove indexes that are not needed or being used.

```
        TABLE        │                   INDEX                    │ INDEX SIZE │ INDEX SCANS
─────────────────────┼────────────────────────────────────────────┼────────────┼──────────────
 public.users        │ user_id_created_at_idx                     │ 97 MB      │           0
```
