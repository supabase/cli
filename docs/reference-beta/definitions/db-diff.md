---
id: db-diff
kind: command
category: db
title: db diff
symbol: supabase db diff
summary: Diffs a database for schema changes
usage: supabase db diff [flags]
description: |-
  Diffs schema changes made to a database.

  Diffs the local database by default, which requires the local development stack to be running. Pass `--remote` to diff the linked project, or `--remote=<ref|branch|url>` to diff another project, a branch of the linked project, or a database URL such as a self-hosted database. The command prints a `Target:` line on stderr naming the database it resolved, and never asks for confirmation.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

  Compares schema differences between the target database and a shadow database, using the bundled pg-delta engine by default. The legacy [djrobstep/migra](https://github.com/djrobstep/migra) engine, which runs in a container, remains available as a fallback (see below). The shadow database is created by applying migrations in local `supabase/migrations` directory in a separate container. Output is written to stdout by default. For convenience, you can also save the schema diff as a new migration file by passing in `-f` flag.

  In `--from`/`--to`, `remote` means the linked project; passing `--remote` together with `--from` or `--to` is an error. The deprecated aliases still work there and warn: `--project-ref` points a `remote` side at the project it names, and the rest change nothing. Explicit `--from`/`--to` mode always uses pg-delta. In this mode, `-f` is ignored and stdout (or `--output`) is a flattened representation for review, not a portable apply script. Do not apply it directly with plain `psql -f`: transactional units can contain `SET LOCAL` preambles that only take effect inside a transaction, while plans that mix transactional and non-transactional units cannot safely be wrapped in one transaction. To create an applicable migration, use normal target mode with `supabase db diff -f <name>`, then apply it through `supabase db reset` locally or `supabase db push --remote` against the linked project. These paths preserve the plan's per-unit transaction semantics.

  By default, all schemas in the target database are diffed; `--schema` restricts the diff to the listed schemas.

  pg-delta is the default diff engine for all projects. To fall back to the legacy migra engine, set `enabled = false` under `[experimental.pgdelta]` in `config.toml`, or pass `--use-migra` for a single run.

  When migra diffs the local database and declarative schema files exist, it diffs against those files instead of the live database, choosing them in this order: `[db.migrations] schema_paths` when set; otherwise the `declarative_schema_path` directory while `[experimental.pgdelta] enabled` is true (so with `--use-migra` and the default config); otherwise `supabase/schemas`. Setting `enabled = false` therefore makes migra skip a custom `declarative_schema_path` and fall back to `supabase/schemas`.

  With pg-delta, `[db.migrations] schema_paths` and declarative schema files (such as `supabase/schemas`) are not inputs: `db diff` always compares local migrations with the selected database. `db diff -f` prints a note, with next steps, when it finds declarative files it did not read. To generate a migration from declarative schema files, use `supabase db schema declarative sync`.

  With the bundled pg-delta engine, diff SQL defaults to uppercase keywords, indent 2, a maximum width of 180, trailing commas, and column/key alignment, matching its declarative export. When `-f` writes migrations, execution-aware transaction semantics are preserved as ordered per-unit files; non-transactional units carry a directive that the CLI apply path honors. Flattened review output retains the rendered SQL and preambles, but not the unit boundaries supplied to a migration runner. Configure overrides with `[experimental.pgdelta] format_options`, or set `format_options = "null"` to emit raw, unformatted statements.

  Storage buckets are data, not schema, so no diff engine captures them. Under the legacy migra engine, the diff can also miss:

  - Changes to publication
  - Views with `security_invoker` attributes
parameters:
  - name: --file
    location: flag
    type: string
    description: In normal mode, names and saves the complete schema diff as a new migration; it does not filter objects. Ignored with --from/--to.
    short: -f
    default: ""
  - name: --from
    location: flag
    type: string
    description: Diff from local, migrations, remote (always the linked project), a project ref, a branch, or a Postgres URL.
    default: ""
  - name: --output
    location: flag
    type: string
    description: Write flattened explicit diff SQL to a file for review; this is not a portable apply script.
    short: -o
    default: ""
  - name: --remote
    location: flag
    type: ref|branch|url
    description: "Target a remote database: the linked project, or `--remote=<ref|branch|url>`."
    default: "false"
  - name: --schema
    location: flag
    type: strings
    description: Comma separated list of schema to include.
    short: -s
    default: "[]"
  - name: --stack
    location: flag
    type: string
    description: Select a local stack by name, else by ID or unique ID prefix (defaults to SUPABASE_STACK, else the current project stack).
    default: ""
  - name: --strict-coverage
    location: flag
    type: boolean
    description: Fail when bundled pg-delta finds schema objects it cannot manage instead of leaving them unmanaged.
    default: "false"
  - name: --to
    location: flag
    type: string
    description: Diff to local, migrations, remote (always the linked project), a project ref, a branch, or a Postgres URL.
    default: ""
  - name: --use-migra
    location: flag
    type: boolean
    description: Use migra to generate schema diff.
    default: "false"
  - name: --use-pg-delta
    location: flag
    type: boolean
    description: Use pg-delta to generate schema diff.
    default: "false"
  - name: --use-pgadmin
    location: flag
    type: boolean
    description: Use pgAdmin to generate schema diff.
    default: "false"
  - name: --agent
    location: flag
    type: "[ auto | yes | no ]"
    description: "Override agent detection: yes, no, or auto"
    default: auto
    allowed_values:
      - auto
      - "yes"
      - "no"
  - name: --debug
    location: flag
    type: boolean
    description: output debug logs to stderr
    default: "false"
  - name: --dns-resolver
    location: flag
    type: "[ native | https ]"
    description: lookup domain names using the specified resolver
    default: native
    allowed_values:
      - native
      - https
  - name: --experimental
    location: flag
    type: boolean
    description: enable experimental features
    default: "false"
  - name: --help
    location: flag
    type: boolean
    description: Show help information
    short: -h
    default: "false"
  - name: --network-id
    location: flag
    type: string
    description: use the specified docker network instead of a generated one
    default: ""
  - name: --output-format
    location: flag
    type: "[ text | json | stream-json ]"
    description: "Output format: text, json, or stream-json (NDJSON)"
    default: text
    allowed_values:
      - text
      - json
      - stream-json
  - name: --profile
    location: flag
    type: string
    description: use a specific profile for connecting to Supabase API
    default: supabase
  - name: --workdir
    location: flag
    type: string
    description: path to the directory containing your supabase/ folder; used exactly as given, with no ancestor directory search (defaults to searching upward from the current directory)
    default: ""
  - name: --yes
    location: flag
    type: boolean
    description: answer yes to all prompts; hosted changes only accept this flag or SUPABASE_YES exported in your shell, never supabase/.env or another .env file
    default: "false"
inherits_flags: global-flags
examples:
  - id: example-1
    title: Save local schema changes as a new migration
    lang: sh
    code: supabase db diff -f add_profiles
  - id: example-2
    title: Diff only the public and extensions schemas
    lang: sh
    code: supabase db diff --schema public,extensions
---
