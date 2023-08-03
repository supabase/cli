## unused-indexes

Think of your database as a library, and indexes are like the index cards that help you find books. Sometimes, you might have index cards for books that very few people borrow, and those index cards take up space in the library.

This command helps you find these little-used index cards. It shows you the ones that have been looked at less than 50 times and are taking up more than 5 pages. Removing these unused index cards can help speed up writing new information to the library and make it easier to find popular books in the future. Just like cleaning out old files from your computer to make it run faster!

```
        TABLE        │                   INDEX                    │ INDEX SIZE │ INDEX SCANS
─────────────────────┼────────────────────────────────────────────┼────────────┼──────────────
 public.grade_levels | index_placement_attempts_on_grade_level_id | 97 MB      |           0
 public.observations | observations_attrs_grade_resources         | 33 MB      |           0
 public.messages     | user_resource_id_idx                       | 12 MB      |           0
```