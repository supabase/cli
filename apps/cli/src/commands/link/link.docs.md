Connects the current directory to a hosted Supabase project so commands such as `db push --remote` and `db pull --remote` target it. Pass the project ref, or the name of one of its branches, as the argument: `supabase link <ref>`. The `--project-ref` flag still works.

Linking records the project ref under `supabase/.temp/`, so later commands target that project without `--project-ref`. It never connects to the database, so it needs no database password.

Passing a bare `--remote` to commands such as `db dump`, `db push`, and `db pull` targets the linked project, so link it first.
