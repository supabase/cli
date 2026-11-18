## supabase-db-diff

Show the schema changes between the migrations in `supabase/migrations` and a live database. Use it to turn changes you made in a database into a new migration.

It compares the target database with a shadow database built from your local migrations, using the bundled pg-delta engine by default. The target is the local database, which requires the local development stack to be running. Pass `--remote` to diff the linked project, or `--remote=<ref|branch|url>` to diff another project, a branch of the linked project, or a database URL such as a self-hosted database.

The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

`--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

Output is written to stdout by default. Pass `-f <name>` to save the complete diff as a new migration file instead. All schemas are diffed unless you restrict them with `--schema public,extensions`.

## Comparing two sources

With `--from` and `--to`, you can diff any two of `local`, `migrations`, the linked project (`remote`), a project ref, a branch, or a Postgres URL. This mode always uses pg-delta, and `--remote` cannot be combined with it. The deprecated aliases still work here and warn: `--project-ref` points a `remote` side at the project it names, and the rest change nothing.

In this mode, `-f` is ignored and the output on stdout (or in `--output`) is flattened SQL for review, not a portable apply script. Do not apply it with plain `psql -f`: transactional units can contain `SET LOCAL` preambles that only take effect inside a transaction, and plans that mix transactional and non-transactional units cannot safely be wrapped in one transaction.

To create a migration you can apply, use `supabase db diff -f <name>`. Then apply it with `supabase db reset` locally or `supabase db push --remote` against the linked project, which preserve the plan's per-unit transaction semantics.

## Diff engines

pg-delta is the default engine. The legacy [djrobstep/migra](https://github.com/djrobstep/migra) engine, which runs in a container, is still available. To fall back to it, set `enabled = false` under `[experimental.pgdelta]` in `config.toml`, or pass `--use-migra` for a single run.

With pg-delta, `[db.migrations] schema_paths` and declarative schema files such as `supabase/schemas` are not inputs: the command always compares local migrations with the selected database. `db diff -f` prints a note with next steps when it finds declarative files it did not read. To generate a migration from declarative schema files, use `supabase db schema declarative sync`.

When migra diffs the local database and declarative schema files exist, it diffs against those files instead of the live database. It picks them in this order: `[db.migrations] schema_paths` when set; otherwise the `declarative_schema_path` directory while `[experimental.pgdelta] enabled` is true (so with `--use-migra` and the default config); otherwise `supabase/schemas`. Setting `enabled = false` therefore makes migra skip a custom `declarative_schema_path` and fall back to `supabase/schemas`.

pg-delta formats diff SQL with uppercase keywords, indent 2, a maximum width of 180, trailing commas, and column and key alignment, matching its declarative export. Configure overrides with `[experimental.pgdelta] format_options`, or set `format_options = "null"` to emit raw statements.

When `-f` writes migrations, execution-aware transaction semantics are preserved as ordered per-unit files. Non-transactional units carry a directive that the CLI apply path honors. Flattened review output keeps the rendered SQL and preambles, but not the unit boundaries a migration runner needs.

## Limitations

Storage buckets are data, not schema, so no diff engine captures them. Under the legacy migra engine, the diff can also miss:

- Changes to publication
- Views with `security_invoker` attributes
