# db-unused-indexes

List indexes with fewer than 50 scans that are larger than 5 pages, ordered by size relative to the number of scans. Use it to find indexes you can drop.

Indexes slow down writes and can slow down reads when they take up memory, so remove the ones you do not need.

```
        TABLE        │                   INDEX                    │ INDEX SIZE │ INDEX SCANS
─────────────────────┼────────────────────────────────────────────┼────────────┼──────────────
 public.users        │ user_id_created_at_idx                     │ 97 MB      │           0
```
