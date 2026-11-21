---
id: db-pull
kind: command
category: db
title: db pull
symbol: supabase db pull
summary: Pull schema from a database
usage: supabase db pull [migration name] [flags]
description: |-
  Pulls schema changes from a database. A new migration file will be created under `supabase/migrations` directory.

  Pulls from the local database by default. Pass `--remote` to pull from the linked project, which requires your local project to be linked by running `supabase link`. Pass `--remote=<ref|branch|url>` to pull from another project, a branch of the linked project, or a database URL such as a self-hosted database. In a linked checkout, a run without `--remote` prints a hint naming the linked project. The command prints a `Target:` line on stderr naming the database it resolved.

  `--linked`, `--project-ref`, `--db-url` and `--local` still work in v3 but are deprecated and removed in v4; use `--remote`.

  > Note this command requires Docker Desktop (or a running Docker daemon), as it starts a local Postgres container to diff the schema you pull.

  After the migration file is written, a new row is inserted into the migration history table to reflect the current state of the database. A hosted database asks for one confirmation first (default No), after the diff and before any file is written; declining stops the command without writing anything. Non-interactive, JSON and agent runs need `--yes` (or `SUPABASE_YES` in the shell environment, not in `supabase/.env`). A pull from the local database and `--declarative` ask nothing.

  If no entries exist in the migration history table, pg-delta (the default diff engine) produces the full migration from the shadow diff alone; with `--diff-engine migra`, the initial pull instead uses `pg_dump` to capture all contents of the schemas you have created. Otherwise, this command will only diff schema changes against the target database, similar to running `db diff --remote`.

  Pass `--declarative` to switch to the declarative pg-delta export workflow instead of writing a migration file. The tree lives in `supabase/schemas` by default. Change the location with `experimental.pgdelta.declarative_schema_path`.

  On a project that falls back to the legacy migra engine, don't use `--declarative`. The export also points `[db.migrations].schema_paths` at the tree it writes. The next local `db diff` applies those files in lexicographic order without resolving dependencies between them, so it fails when a file sorts before an object it depends on. If you've already run it, re-enable pg-delta, or undo both changes:

  1. Delete the files the export wrote to the declarative directory (`supabase/schemas/` by default). Files that were already there are left in place.
  2. Restore `[db.migrations].schema_paths` in `config.toml` to its previous value, or remove it if the export added it.

  pg-delta plans are execution-aware: when a plan crosses a transaction boundary — for example `ALTER TYPE ... ADD VALUE` followed by a statement that uses the new enum value, which cannot run in the same transaction — `db pull` writes one ordered migration file per plan unit instead of a single file (for example `<ts>_remote_schema_1.sql` and `<ts+1s>_remote_schema_2.sql`), each recorded in the migration history. Units whose statements cannot run inside a transaction start with a `-- pg-delta: transaction=false` directive that the CLI apply paths honor. The common case (a single unit) still produces exactly one `<ts>_remote_schema.sql` file.

  By default the emitted SQL is formatted with the same settings the declarative export uses (uppercase keywords, wrapped at a max width of 180, indented and column-aligned). Configure overrides with `[experimental.pgdelta] format_options` in `config.toml`, or set `format_options = "null"` to opt out and emit raw, unformatted statements.

  pg-delta is the default diff engine: the migration-file `db pull` workflow uses pg-delta for the shadow diff step unless configured otherwise; it does not switch to declarative output. With pg-delta, `[db.migrations] schema_paths` does not affect this workflow (migra still reads it, for local targets only); use `supabase db schema declarative sync` for declarative schema files. To fall back to the legacy migra engine, set `enabled = false` under `[experimental.pgdelta]` in `config.toml`, or pass `--diff-engine migra` for a single run.

  When pulling with `--remote=<url>`, prefer a direct connection (`db.<project-ref>.supabase.co:5432`) over the connection pooler so pg-delta can introspect the full catalog reliably.

  Under the pg-delta engine, a plain `db pull` captures your own customizations in Supabase-managed schemas: triggers on managed tables whose function lives outside the managed schemas (for example a trigger on `auth.users` calling a function in `public`), RLS policies on any `auth` table, and RLS policies on `storage.objects`, `storage.buckets`, and `realtime.messages`. Other objects you create inside managed schemas, such as your own functions or indexes, are not diffed. On later pulls, `--schema` restricts the diff to the listed schemas, so a customization in `auth` is only captured when `auth` is listed or `--schema` is omitted; the initial pull ignores `--schema`. Under the legacy migra engine, the initial pull's `pg_dump` skips the managed schemas, and the migra diff pass that follows appends your trigger and RLS policy changes there to the same migration file. If an older CLI reports that `auth` and `storage` were excluded, capture existing customizations there with `--schema auth,storage`.

  ## Debugging empty pg-delta pulls

  If `db pull` reports `No schema changes found` but you expect schema output, set `PGDELTA_DEBUG=1` before running the command. Unlike `--debug`, this keeps SSL enabled for hosted Supabase connections.

  ```sh
  PGDELTA_DEBUG=1 supabase db pull --remote="$DATABASE_URL"
  ```

  When pg-delta returns zero statements, the CLI writes a debug bundle under `supabase/.temp/pgdelta/v2/debug/<timestamp>-diff/` containing the source/desired catalog snapshots, the plan, and coverage diagnostics. Catalog files are not written during normal `db pull` runs.

  For TLS tracing without disabling SSL, use `SUPABASE_SSL_DEBUG=true` alongside `PGDELTA_DEBUG=1`.
parameters:
  - name: migration name
    location: positional
    required: false
  - name: --declarative
    location: flag
    type: boolean
    description: Replace the declarative schema tree from the selected database instead of creating a migration; migration history is not updated.
    default: "false"
  - name: --diff-engine
    location: flag
    type: "[ migra | pg-delta ]"
    description: Diff engine to use for migration-style db pull.
    default: pg-delta
    allowed_values:
      - migra
      - pg-delta
  - name: --password
    location: flag
    type: string
    description: Database password for the project selected with --remote. Not used for the local database or a database URL.
    short: -p
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
  - name: --output
    location: flag
    type: "[ env | pretty | json | toml | yaml ]"
    description: output format of status variables
    short: -o
    default: pretty
    allowed_values:
      - env
      - pretty
      - json
      - toml
      - yaml
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
examples: []
---
