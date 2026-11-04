Connects the current directory to a hosted Supabase project so commands such as `db push --remote` and `db pull --remote` target it. Pass the project ref, or the name of one of its branches, as the argument: `supabase link <ref>`. The `--project-ref` flag still works.

Linking records the project ref under `supabase/.temp/`, so later commands target that project without `--project-ref`. It never connects to the database, so it needs no database password.

Commands that accept `--remote`, like `db dump`, `db push`, and `db pull`, target the linked project, so link it first.
