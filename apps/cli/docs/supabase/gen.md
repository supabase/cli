## supabase-gen

Automatically generates type definitions based on your Postgres database schema.

This command connects to your database (local or remote) and generates typed definitions that match your database tables, views, and stored procedures. By default, it generates TypeScript definitions, but also supports Go and Swift.

Generated types give you type safety and autocompletion when working with your database in code, helping prevent runtime errors and improving developer experience.

The types respect relationships, constraints, and custom types defined in your database schema.
