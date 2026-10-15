## supabase-gen

Automatically generates type definitions based on your Postgres database schema.

This command connects to your database and generates typed definitions that match your database tables, views, and stored procedures. It reads the local database unless you pass `--linked`, `--project-ref`, or `--db-url`, or set `target = "remote"` in your project configuration. By default, it generates TypeScript definitions, but also supports Go and Swift.

Generated types give you type safety and autocompletion when working with your database in code, helping prevent runtime errors and improving developer experience.

The types respect relationships, constraints, and custom types defined in your database schema.
