## supabase-gen

Automatically generates type definitions based on your Postgres database schema.

This command connects to your database (local or remote) and generates typed definitions that match your database tables, views, and stored procedures. By default, it generates TypeScript definitions, but also supports Go and Swift.

Without none of `--local`, `--linked`, `--db-url` or `--project-id`, the command targets the linked project, unless the workspace target is set with `target = "local"` or `target = "remote"` in `supabase/config.toml` or the `SUPABASE_TARGET` environment variable. A selector flag always wins. In the next major version the default moves to the local database; until you pass a flag or set a target, the command prints a deprecation warning on stderr.

Generated types give you type safety and autocompletion when working with your database in code, helping prevent runtime errors and improving developer experience.

The types respect relationships, constraints, and custom types defined in your database schema.
