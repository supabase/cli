## supabase-db-diff

Diffs schema changes made to the local or remote database.

Requires the local development stack to be running when diffing against the local database. To diff against a remote or self-hosted database, specify the `--linked` or `--db-url` flag respectively.

Without `--local`, `--linked` or `--db-url`, the command targets the local database, unless the workspace target is set to `remote` with `target = "remote"` in `supabase/config.toml` or `SUPABASE_TARGET=remote`, in which case it targets the linked project like `--linked` (including with `--project-ref`) and prints `Targeting the linked project (target = "remote" from <source>)` on stderr. A selector flag always wins. Explicit `--from`/`--to` mode ignores the target.

Compares schema differences between the target database and a shadow database. Projects with `[experimental.pgdelta] enabled = true` use the bundled pg-delta engine. Other projects run the legacy [djrobstep/migra](https://github.com/djrobstep/migra) engine in a container, unless you pass `--use-pg-delta` for a single run. The shadow database is created by applying migrations in local `supabase/migrations` directory in a separate container. Output is written to stdout by default. For convenience, you can also save the schema diff as a new migration file by passing in `-f` flag.

Explicit `--from`/`--to` mode always uses pg-delta. In this mode, `-f` is ignored and stdout (or `--output`) is a flattened representation for review, not a portable apply script. Do not apply it directly with plain `psql -f`: transactional units can contain `SET LOCAL` preambles that only take effect inside a transaction, while plans that mix transactional and non-transactional units cannot safely be wrapped in one transaction. To create an applicable migration, use normal target mode with `supabase db diff -f <name>`, then apply it through `supabase db reset` locally or `supabase db push` against the linked project. These paths preserve the plan's per-unit transaction semantics.

By default, all schemas in the target database are diffed. Use the `--schema public,extensions` flag to restrict diffing to a subset of schemas.

Projects created by a recent `supabase init` default to the pg-delta diff engine (`[experimental.pgdelta] enabled = true` in `config.toml`). Existing projects are unaffected and keep using migra unless they opt in. To fall back to the legacy migra engine, set `enabled = false` under `[experimental.pgdelta]`, or pass `--use-migra` for a single run.

With the bundled pg-delta engine, diff SQL defaults to uppercase keywords, indent 2, a maximum width of 180, trailing commas, and column/key alignment, matching its declarative export. When `-f` writes migrations, execution-aware transaction semantics are preserved as ordered per-unit files; non-transactional units carry a directive that the CLI apply path honors. Flattened review output retains the rendered SQL and preambles, but not the unit boundaries supplied to a migration runner. Configure overrides with `[experimental.pgdelta] format_options`, or set `format_options = "null"` to emit raw, unformatted statements.

Storage buckets are data, not schema, so no diff engine captures them. Under the legacy migra engine, the diff can also miss:

- Changes to publication
- Views with `security_invoker` attributes
