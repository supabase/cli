# db-unused-indexes

Think of your database as a library, and indexes are like the index cards that help you find books. Sometimes, you might have index cards for books that very few people borrow, and those index cards take up space in the library.

This command helps you find these little-used index cards. It shows you the ones that have been looked at less than 50 times and are taking up more than 5 pages. Removing these unused index cards can help speed up writing new information to the library and make it easier to find popular books in the future. Just like cleaning out old files from your computer to make it run faster!

```
        TABLE        │                   INDEX                    │ INDEX SIZE │ INDEX SCANS
─────────────────────┼────────────────────────────────────────────┼────────────┼──────────────
 public.users        │ user_id_created_at_idx                     │ 97 MB      │           0
```
