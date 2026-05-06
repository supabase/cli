# Old Go CLI Reference

> Complete help output for the old Go-based `supabase` CLI.
> Use this document as the raw parity reference when tracking the TypeScript CLI port in [`go-cli-porting-status.md`](./go-cli-porting-status.md).

## Global Flags

These flags are available on all commands:

```
Flags:
      --create-ticket                                  create a support ticket for any CLI error
      --debug                                          output debug logs to stderr
      --dns-resolver [ native | https ]                lookup domain names using the specified resolver (default native)
      --experimental                                   enable experimental features
  -h, --help                                           help for supabase
      --network-id string                              use the specified docker network instead of a generated one
  -o, --output [ env | pretty | json | toml | yaml ]   output format of status variables (default pretty)
      --profile string                                 use a specific profile for connecting to Supabase API (default "supabase")
      --workdir string                                 path to a Supabase project directory
      --yes                                            answer yes to all prompts
```

## Table of Contents

- [Quick Start](#quick-start)
  - [bootstrap](#bootstrap)
- [Local Development](#local-development)
  - [init](#init)
  - [link](#link)
  - [unlink](#unlink)
  - [login](#login)
  - [logout](#logout)
  - [start](#start)
  - [stop](#stop)
  - [status](#status)
  - [services](#services)
  - [db](#db)
  - [gen](#gen)
  - [inspect](#inspect)
  - [migration](#migration)
  - [seed](#seed)
  - [test](#test)
- [Management APIs](#management-apis)
  - [backups](#backups)
  - [branches](#branches)
  - [config](#config)
  - [domains](#domains)
  - [encryption](#encryption)
  - [functions](#functions)
  - [network-bans](#network-bans)
  - [network-restrictions](#network-restrictions)
  - [orgs](#orgs)
  - [postgres-config](#postgres-config)
  - [projects](#projects)
  - [secrets](#secrets)
  - [snippets](#snippets)
  - [ssl-enforcement](#ssl-enforcement)
  - [sso](#sso)
  - [storage](#storage)
  - [vanity-subdomains](#vanity-subdomains)
- [Additional Commands](#additional-commands)
  - [completion](#completion)
  - [help](#help-1)

---

## Quick Start

### bootstrap

```
Bootstrap a Supabase project from a starter template

Usage:
  supabase bootstrap [template] [flags]

Flags:
  -h, --help              help for bootstrap
  -p, --password string   Password to your remote Postgres database.
```

---

## Local Development

### init

```
Initialize a local project

Usage:
  supabase init [flags]

Flags:
      --force          Overwrite existing supabase/config.toml.
  -h, --help           help for init
  -i, --interactive    Enables interactive mode to configure IDE settings.
      --use-orioledb   Use OrioleDB storage engine for Postgres.
```

### link

```
Link to a Supabase project

Usage:
  supabase link [flags]

Flags:
  -h, --help                 help for link
  -p, --password string      Password to your remote Postgres database.
      --project-ref string   Project ref of the Supabase project.
      --skip-pooler          Use direct connection instead of pooler.
```

### unlink

```
Unlink a Supabase project

Usage:
  supabase unlink [flags]

Flags:
  -h, --help   help for unlink
```

### login

```
Authenticate using an access token

Usage:
  supabase login [flags]

Flags:
  -h, --help           help for login
      --name string    Name that will be used to store token in your settings (default "built-in token name generator")
      --no-browser     Do not open browser automatically
      --token string   Use provided token instead of automatic login flow
```

### logout

```
Log out and delete access tokens locally

Usage:
  supabase logout [flags]

Flags:
  -h, --help   help for logout
```

### start

```
Start containers for Supabase local development

Usage:
  supabase start [flags]

Flags:
  -x, --exclude strings       Names of containers to not start. [gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor]
  -h, --help                  help for start
      --ignore-health-check   Ignore unhealthy services and exit 0
      --sandbox               Run in sandbox mode using native binaries (experimental)
```

### stop

```
Stop all local Supabase containers

Usage:
  supabase stop [flags]

Flags:
      --all                 Stop all local Supabase instances from all projects across the machine.
  -h, --help                help for stop
      --no-backup           Deletes all data volumes after stopping.
      --project-id string   Local project ID to stop.
```

### status

```
Show status of local Supabase containers

Usage:
  supabase status [flags]

Examples:
  supabase status -o env --override-name api.url=NEXT_PUBLIC_SUPABASE_URL
  supabase status -o json

Flags:
  -h, --help                    help for status
      --override-name strings   Override specific variable names.
```

### services

```
Show versions of all Supabase services

Usage:
  supabase services [flags]

Flags:
  -h, --help   help for services
```

### db

```
Manage Postgres databases

Usage:
  supabase db [command]

Available Commands:
  diff        Diffs the local database for schema changes
  dump        Dumps data or schemas from the remote database
  lint        Checks local database for typing error
  pull        Pull schema from the remote database
  push        Push new migrations to the remote database
  reset       Resets the local database to current migrations
  start       Starts local Postgres database

Flags:
  -h, --help   help for db
```

#### db diff

```
Diffs the local database for schema changes

Usage:
  supabase db diff [flags]

Flags:
      --db-url string    Diffs against the database specified by the connection string (must be percent-encoded).
  -f, --file string      Saves schema diff to a new migration file.
  -h, --help             help for diff
      --linked           Diffs local migration files against the linked project.
      --local            Diffs local migration files against the local database. (default true)
  -s, --schema strings   Comma separated list of schema to include.
      --use-migra        Use migra to generate schema diff. (default true)
      --use-pg-delta     Use pg-delta to generate schema diff.
      --use-pg-schema    Use pg-schema-diff to generate schema diff.
      --use-pgadmin      Use pgAdmin to generate schema diff.
```

#### db dump

```
Dumps data or schemas from the remote database

Usage:
  supabase db dump [flags]

Flags:
      --data-only         Dumps only data records.
      --db-url string     Dumps from the database specified by the connection string (must be percent-encoded).
      --dry-run           Prints the pg_dump script that would be executed.
  -x, --exclude strings   List of schema.tables to exclude from data-only dump.
  -f, --file string       File path to save the dumped contents.
  -h, --help              help for dump
      --keep-comments     Keeps commented lines from pg_dump output.
      --linked            Dumps from the linked project. (default true)
      --local             Dumps from the local database.
  -p, --password string   Password to your remote Postgres database.
      --role-only         Dumps only cluster roles.
  -s, --schema strings    Comma separated list of schema to include.
      --use-copy          Use copy statements in place of inserts.
```

#### db lint

```
Checks local database for typing error

Usage:
  supabase db lint [flags]

Flags:
      --db-url string                        Lints the database specified by the connection string (must be percent-encoded).
      --fail-on [ none | warning | error ]   Error level to exit with non-zero status. (default none)
  -h, --help                                 help for lint
      --level [ warning | error ]            Error level to emit. (default warning)
      --linked                               Lints the linked project for schema errors.
      --local                                Lints the local database for schema errors. (default true)
  -s, --schema strings                       Comma separated list of schema to include.
```

#### db pull

```
Pull schema from the remote database

Usage:
  supabase db pull [migration name] [flags]

Flags:
      --db-url string     Pulls from the database specified by the connection string (must be percent-encoded).
  -h, --help              help for pull
      --linked            Pulls from the linked project. (default true)
      --local             Pulls from the local database.
  -p, --password string   Password to your remote Postgres database.
  -s, --schema strings    Comma separated list of schema to include.
```

#### db push

```
Push new migrations to the remote database

Usage:
  supabase db push [flags]

Flags:
      --db-url string     Pushes to the database specified by the connection string (must be percent-encoded).
      --dry-run           Print the migrations that would be applied, but don't actually apply them.
  -h, --help              help for push
      --include-all       Include all migrations not found on remote history table.
      --include-roles     Include custom roles from supabase/roles.sql.
      --include-seed      Include seed data from your config.
      --linked            Pushes to the linked project. (default true)
      --local             Pushes to the local database.
  -p, --password string   Password to your remote Postgres database.
```

#### db reset

```
Resets the local database to current migrations

Usage:
  supabase db reset [flags]

Flags:
      --db-url string    Resets the database specified by the connection string (must be percent-encoded).
  -h, --help             help for reset
      --last uint        Reset up to the last n migration versions.
      --linked           Resets the linked project with local migrations.
      --local            Resets the local database with local migrations. (default true)
      --no-seed          Skip running the seed script after reset.
      --version string   Reset up to the specified version.
```

#### db start

```
Starts local Postgres database

Usage:
  supabase db start [flags]

Flags:
      --from-backup string   Path to a logical backup file.
  -h, --help                 help for start
```

### gen

```
Run code generation tools

Usage:
  supabase gen [command]

Available Commands:
  bearer-jwt  Generate a Bearer Auth JWT for accessing Data API
  signing-key Generate a JWT signing key
  types       Generate types from Postgres schema

Flags:
  -h, --help   help for gen
```

#### gen bearer-jwt

```
Generate a Bearer Auth JWT for accessing Data API

Usage:
  supabase gen bearer-jwt [flags]

Flags:
      --exp time             Expiry timestamp for this token.
  -h, --help                 help for bearer-jwt
      --payload string       Custom claims in JSON format. (default "{}")
      --role string          Postgres role to use.
      --sub string           User ID to impersonate. (default "anonymous")
      --valid-for duration   Validity duration for this token. (default 30m0s)
```

#### gen signing-key

```
Securely generate a private JWT signing key for use in the CLI or to import in the dashboard.

Supported algorithms:
	ES256 - ECDSA with P-256 curve and SHA-256 (recommended)
	RS256 - RSA with SHA-256

Usage:
  supabase gen signing-key [flags]

Flags:
      --algorithm [ RS256 | ES256 ]   Algorithm for signing key generation. (default ES256)
      --append                        Append new key to existing keys file instead of overwriting.
  -h, --help                          help for signing-key
```

#### gen types

```
Generate types from Postgres schema

Usage:
  supabase gen types [flags]

Examples:
  supabase gen types --local
  supabase gen types --linked --lang=go
  supabase gen types --project-id abc-def-123 --schema public --schema private
  supabase gen types --db-url 'postgresql://...' --schema public --schema auth

Flags:
      --db-url string                                Generate types from a database url.
  -h, --help                                         help for types
      --lang [ typescript | go | swift | python ]    Output language of the generated types. (default typescript)
      --linked                                       Generate types from the linked project.
      --local                                        Generate types from the local dev database.
      --postgrest-v9-compat                          Generate types compatible with PostgREST v9 and below.
      --project-id string                            Generate types from a project ID.
      --query-timeout duration                       Maximum timeout allowed for the database query. (default 15s)
  -s, --schema strings                               Comma separated list of schema to include.
      --swift-access-control [ internal | public ]   Access control for Swift generated types. (default internal)
```

### inspect

```
Tools to inspect your Supabase project

Usage:
  supabase inspect [command]

Available Commands:
  db          Tools to inspect your Supabase database
  report      Generate a CSV output for all inspect commands

Flags:
      --db-url string   Inspect the database specified by the connection string (must be percent-encoded).
  -h, --help            help for inspect
      --linked          Inspect the linked project. (default true)
      --local           Inspect the local database.
```

#### inspect db

```
Tools to inspect your Supabase database

Usage:
  supabase inspect db [command]

Available Commands:
  bloat                Estimates space allocated to a relation that is full of dead tuples
  blocking             Show queries that are holding locks and the queries that are waiting for them to be released
  calls                Show queries from pg_stat_statements ordered by total times called
  db-stats             Show stats such as cache hit rates, total sizes, and WAL size
  index-stats          Show combined index size, usage percent, scan counts, and unused status
  locks                Show queries which have taken out an exclusive lock on a relation
  long-running-queries Show currently running queries running for longer than 5 minutes
  outliers             Show queries from pg_stat_statements ordered by total execution time
  replication-slots    Show information about replication slots on the database
  role-stats           Show information about roles on the database
  table-stats          Show combined table size, index size, and estimated row count
  traffic-profile      Show read/write activity ratio for tables based on block I/O operations
  vacuum-stats         Show statistics related to vacuum operations per table

Flags:
  -h, --help   help for db
```

##### inspect db bloat

```
Estimates space allocated to a relation that is full of dead tuples

Usage:
  supabase inspect db bloat [flags]

Flags:
  -h, --help   help for bloat
```

##### inspect db blocking

```
Show queries that are holding locks and the queries that are waiting for them to be released

Usage:
  supabase inspect db blocking [flags]

Flags:
  -h, --help   help for blocking
```

##### inspect db calls

```
Show queries from pg_stat_statements ordered by total times called

Usage:
  supabase inspect db calls [flags]

Flags:
  -h, --help   help for calls
```

##### inspect db db-stats

```
Show stats such as cache hit rates, total sizes, and WAL size

Usage:
  supabase inspect db db-stats [flags]

Flags:
  -h, --help   help for db-stats
```

##### inspect db index-stats

```
Show combined index size, usage percent, scan counts, and unused status

Usage:
  supabase inspect db index-stats [flags]

Flags:
  -h, --help   help for index-stats
```

##### inspect db locks

```
Show queries which have taken out an exclusive lock on a relation

Usage:
  supabase inspect db locks [flags]

Flags:
  -h, --help   help for locks
```

##### inspect db long-running-queries

```
Show currently running queries running for longer than 5 minutes

Usage:
  supabase inspect db long-running-queries [flags]

Flags:
  -h, --help   help for long-running-queries
```

##### inspect db outliers

```
Show queries from pg_stat_statements ordered by total execution time

Usage:
  supabase inspect db outliers [flags]

Flags:
  -h, --help   help for outliers
```

##### inspect db replication-slots

```
Show information about replication slots on the database

Usage:
  supabase inspect db replication-slots [flags]

Flags:
  -h, --help   help for replication-slots
```

##### inspect db role-stats

```
Show information about roles on the database

Usage:
  supabase inspect db role-stats [flags]

Flags:
  -h, --help   help for role-stats
```

##### inspect db table-stats

```
Show combined table size, index size, and estimated row count

Usage:
  supabase inspect db table-stats [flags]

Flags:
  -h, --help   help for table-stats
```

##### inspect db traffic-profile

```
Show read/write activity ratio for tables based on block I/O operations

Usage:
  supabase inspect db traffic-profile [flags]

Flags:
  -h, --help   help for traffic-profile
```

##### inspect db vacuum-stats

```
Show statistics related to vacuum operations per table

Usage:
  supabase inspect db vacuum-stats [flags]

Flags:
  -h, --help   help for vacuum-stats
```

#### inspect report

```
Generate a CSV output for all inspect commands

Usage:
  supabase inspect report [flags]

Flags:
  -h, --help                help for report
      --output-dir string   Path to save CSV files in (default ".")
```

### migration

```
Manage database migration scripts

Usage:
  supabase migration [command]

Aliases:
  migration, migrations

Available Commands:
  down        Resets applied migrations up to the last n versions
  fetch       Fetch migration files from history table
  list        List local and remote migrations
  new         Create an empty migration script
  repair      Repair the migration history table
  squash      Squash migrations to a single file
  up          Apply pending migrations to local database

Flags:
  -h, --help   help for migration
```

#### migration down

```
Resets applied migrations up to the last n versions

Usage:
  supabase migration down [flags]

Flags:
      --db-url string   Resets applied migrations on the database specified by the connection string (must be percent-encoded).
  -h, --help            help for down
      --last uint       Reset up to the last n migration versions. (default 1)
      --linked          Resets applied migrations on the linked project.
      --local           Resets applied migrations on the local database. (default true)
```

#### migration fetch

```
Fetch migration files from history table

Usage:
  supabase migration fetch [flags]

Flags:
      --db-url string   Fetches migrations from the database specified by the connection string (must be percent-encoded).
  -h, --help            help for fetch
      --linked          Fetches migration history from the linked project. (default true)
      --local           Fetches migration history from the local database.
```

#### migration list

```
List local and remote migrations

Usage:
  supabase migration list [flags]

Flags:
      --db-url string     Lists migrations of the database specified by the connection string (must be percent-encoded).
  -h, --help              help for list
      --linked            Lists migrations applied to the linked project. (default true)
      --local             Lists migrations applied to the local database.
  -p, --password string   Password to your remote Postgres database.
```

#### migration new

```
Create an empty migration script

Usage:
  supabase migration new <migration name> [flags]

Flags:
  -h, --help   help for new
```

#### migration repair

```
Repair the migration history table

Usage:
  supabase migration repair [version] ... [flags]

Flags:
      --db-url string                   Repairs migrations of the database specified by the connection string (must be percent-encoded).
  -h, --help                            help for repair
      --linked                          Repairs the migration history of the linked project. (default true)
      --local                           Repairs the migration history of the local database.
  -p, --password string                 Password to your remote Postgres database.
      --status [ applied | reverted ]   Version status to update.
```

#### migration squash

```
Squash migrations to a single file

Usage:
  supabase migration squash [flags]

Flags:
      --db-url string     Squashes migrations of the database specified by the connection string (must be percent-encoded).
  -h, --help              help for squash
      --linked            Squashes the migration history of the linked project.
      --local             Squashes the migration history of the local database. (default true)
  -p, --password string   Password to your remote Postgres database.
      --version string    Squash up to the specified version.
```

#### migration up

```
Apply pending migrations to local database

Usage:
  supabase migration up [flags]

Flags:
      --db-url string   Applies migrations to the database specified by the connection string (must be percent-encoded).
  -h, --help            help for up
      --include-all     Include all migrations not found on remote history table.
      --linked          Applies pending migrations to the linked project.
      --local           Applies pending migrations to the local database. (default true)
```

### seed

```
Seed a Supabase project from supabase/config.toml

Usage:
  supabase seed [command]

Available Commands:
  buckets     Seed buckets declared in [storage.buckets]

Flags:
  -h, --help     help for seed
      --linked   Seeds the linked project.
      --local    Seeds the local database. (default true)
```

#### seed buckets

```
Seed buckets declared in [storage.buckets]

Usage:
  supabase seed buckets [flags]

Flags:
  -h, --help   help for buckets
```

### test

```
Run tests on local Supabase containers

Usage:
  supabase test [command]

Available Commands:
  db          Tests local database with pgTAP
  new         Create a new test file

Flags:
  -h, --help   help for test
```

#### test db

```
Tests local database with pgTAP

Usage:
  supabase test db [path] ... [flags]

Flags:
      --db-url string   Tests the database specified by the connection string (must be percent-encoded).
  -h, --help            help for db
      --linked          Runs pgTAP tests on the linked project.
      --local           Runs pgTAP tests on the local database. (default true)
```

#### test new

```
Create a new test file

Usage:
  supabase test new <name> [flags]

Flags:
  -h, --help                 help for new
  -t, --template [ pgtap ]   Template framework to generate. (default pgtap)
```

---

## Management APIs

### backups

```
Manage Supabase physical backups

Usage:
  supabase backups [command]

Available Commands:
  list        Lists available physical backups
  restore     Restore to a specific timestamp using PITR

Flags:
  -h, --help                 help for backups
      --project-ref string   Project ref of the Supabase project.
```

#### backups list

```
Lists available physical backups

Usage:
  supabase backups list [flags]

Flags:
  -h, --help   help for list
```

#### backups restore

```
Restore to a specific timestamp using PITR

Usage:
  supabase backups restore [flags]

Flags:
  -h, --help            help for restore
  -t, --timestamp int   The recovery time target in seconds since epoch.
```

### branches

```
Manage Supabase preview branches

Usage:
  supabase branches [command]

Available Commands:
  create      Create a preview branch
  delete      Delete a preview branch
  get         Retrieve details of a preview branch
  list        List all preview branches
  pause       Pause a preview branch
  unpause     Unpause a preview branch
  update      Update a preview branch

Flags:
  -h, --help                 help for branches
      --project-ref string   Project ref of the Supabase project.
```

#### branches create

```
Create a preview branch for the linked project.

Usage:
  supabase branches create [name] [flags]

Flags:
  -h, --help                help for create
      --notify-url string   URL to notify when branch is active healthy.
      --persistent          Whether to create a persistent branch.
      --region string       Select a region to deploy the branch database.
      --size string         Select a desired instance size for the branch database.
      --with-data           Whether to clone production data to the branch database.
```

#### branches delete

```
Delete a preview branch by its name or ID.

Usage:
  supabase branches delete [name] [flags]

Flags:
  -h, --help   help for delete
```

#### branches get

```
Retrieve details of the specified preview branch.

Usage:
  supabase branches get [name] [flags]

Flags:
  -h, --help   help for get
```

#### branches list

```
List all preview branches of the linked project.

Usage:
  supabase branches list [flags]

Flags:
  -h, --help   help for list
```

#### branches pause

```
Pause a preview branch

Usage:
  supabase branches pause [name] [flags]

Flags:
  -h, --help   help for pause
```

#### branches unpause

```
Unpause a preview branch

Usage:
  supabase branches unpause [name] [flags]

Flags:
  -h, --help   help for unpause
```

#### branches update

```
Update a preview branch by its name or ID.

Usage:
  supabase branches update [name] [flags]

Flags:
      --git-branch string   Change the associated git branch.
  -h, --help                help for update
      --name string         Rename the preview branch.
      --notify-url string   URL to notify when branch is active healthy.
      --persistent          Switch between ephemeral and persistent branch.
      --status string       Override the current branch status.
```

### config

```
Manage Supabase project configurations

Usage:
  supabase config [command]

Available Commands:
  push        Pushes local config.toml to the linked project

Flags:
  -h, --help                 help for config
      --project-ref string   Project ref of the Supabase project.
```

#### config push

```
Pushes local config.toml to the linked project

Usage:
  supabase config push [flags]

Flags:
  -h, --help   help for push
```

### domains

```
Manage custom domain names for Supabase projects.

Use of custom domains and vanity subdomains is mutually exclusive.

Usage:
  supabase domains [command]

Available Commands:
  activate    Activate the custom hostname for a project
  create      Create a custom hostname
  delete      Deletes the custom hostname config for your project
  get         Get the current custom hostname config
  reverify    Re-verify the custom hostname config for your project

Flags:
  -h, --help                 help for domains
      --include-raw-output   Include raw output (useful for debugging).
      --project-ref string   Project ref of the Supabase project.
```

#### domains activate

```
Activates the custom hostname configuration for a project.

This reconfigures your Supabase project to respond to requests on your custom hostname.
After the custom hostname is activated, your project's auth services will no longer function on the Supabase-provisioned subdomain.

Usage:
  supabase domains activate [flags]

Flags:
  -h, --help   help for activate
```

#### domains create

```
Create a custom hostname for your Supabase project.

Expects your custom hostname to have a CNAME record to your Supabase project's subdomain.

Usage:
  supabase domains create [flags]

Flags:
      --custom-hostname string   The custom hostname to use for your Supabase project.
  -h, --help                     help for create
```

#### domains delete

```
Deletes the custom hostname config for your project

Usage:
  supabase domains delete [flags]

Flags:
  -h, --help   help for delete
```

#### domains get

```
Retrieve the custom hostname config for your project, as stored in the Supabase platform.

Usage:
  supabase domains get [flags]

Flags:
  -h, --help   help for get
```

#### domains reverify

```
Re-verify the custom hostname config for your project

Usage:
  supabase domains reverify [flags]

Flags:
  -h, --help   help for reverify
```

### encryption

```
Manage encryption keys of Supabase projects

Usage:
  supabase encryption [command]

Available Commands:
  get-root-key    Get the root encryption key of a Supabase project
  update-root-key Update root encryption key of a Supabase project

Flags:
  -h, --help                 help for encryption
      --project-ref string   Project ref of the Supabase project.
```

#### encryption get-root-key

```
Get the root encryption key of a Supabase project

Usage:
  supabase encryption get-root-key [flags]

Flags:
  -h, --help   help for get-root-key
```

#### encryption update-root-key

```
Update root encryption key of a Supabase project

Usage:
  supabase encryption update-root-key [flags]

Flags:
  -h, --help   help for update-root-key
```

### functions

```
Manage Supabase Edge functions

Usage:
  supabase functions [command]

Available Commands:
  delete      Delete a Function from Supabase
  deploy      Deploy a Function to Supabase
  download    Download a Function from Supabase
  list        List all Functions in Supabase
  new         Create a new Function locally
  serve       Serve all Functions locally

Flags:
  -h, --help   help for functions
```

#### functions delete

```
Delete a Function from the linked Supabase project. This does NOT remove the Function locally.

Usage:
  supabase functions delete <Function name> [flags]

Flags:
  -h, --help                 help for delete
      --project-ref string   Project ref of the Supabase project.
```

#### functions deploy

```
Deploy a Function to the linked Supabase project.

Usage:
  supabase functions deploy [Function name] [flags]

Flags:
  -h, --help                 help for deploy
      --import-map string    Path to import map file.
  -j, --jobs uint            Maximum number of parallel jobs. (default 1)
      --no-verify-jwt        Disable JWT verification for the Function.
      --project-ref string   Project ref of the Supabase project.
      --prune                Delete Functions that exist in Supabase project but not locally.
      --use-api              Bundle functions server-side without using Docker.
```

#### functions download

```
Download the source code for a Function from the linked Supabase project. If no function name is provided, downloads all functions.

Usage:
  supabase functions download [Function name] [flags]

Flags:
  -h, --help                 help for download
      --project-ref string   Project ref of the Supabase project.
      --use-api              Unbundle functions server-side without using Docker.
```

#### functions list

```
List all Functions in the linked Supabase project.

Usage:
  supabase functions list [flags]

Flags:
  -h, --help                 help for list
      --project-ref string   Project ref of the Supabase project.
```

#### functions new

```
Create a new Function locally

Usage:
  supabase functions new <Function name> [flags]

Flags:
  -h, --help   help for new
```

#### functions serve

```
Serve all Functions locally

Usage:
  supabase functions serve [flags]

Flags:
      --env-file string                     Path to an env file to be populated to the Function environment.
  -h, --help                                help for serve
      --import-map string                   Path to import map file.
      --inspect                             Alias of --inspect-mode brk.
      --inspect-main                        Allow inspecting the main worker.
      --inspect-mode [ run | brk | wait ]   Activate inspector capability for debugging.
      --no-verify-jwt                       Disable JWT verification for the Function.
```

### network-bans

```
Network bans are IPs that get temporarily blocked if their traffic pattern looks abusive (e.g. multiple failed auth attempts).

The subcommands help you view the current bans, and unblock IPs if desired.

Usage:
  supabase network-bans [command]

Available Commands:
  get         Get the current network bans
  remove      Remove a network ban

Flags:
  -h, --help                 help for network-bans
      --project-ref string   Project ref of the Supabase project.
```

#### network-bans get

```
Get the current network bans

Usage:
  supabase network-bans get [flags]

Flags:
  -h, --help   help for get
```

#### network-bans remove

```
Remove a network ban

Usage:
  supabase network-bans remove [flags]

Flags:
      --db-unban-ip strings   IP to allow DB connections from.
  -h, --help                  help for remove
```

### network-restrictions

```
Manage network restrictions

Usage:
  supabase network-restrictions [command]

Available Commands:
  get         Get the current network restrictions
  update      Update network restrictions

Flags:
  -h, --help                 help for network-restrictions
      --project-ref string   Project ref of the Supabase project.
```

#### network-restrictions get

```
Get the current network restrictions

Usage:
  supabase network-restrictions get [flags]

Flags:
  -h, --help   help for get
```

#### network-restrictions update

```
Update network restrictions

Usage:
  supabase network-restrictions update [flags]

Flags:
      --append                  Append to existing restrictions instead of replacing them.
      --bypass-cidr-checks      Bypass some of the CIDR validation checks.
      --db-allow-cidr strings   CIDR to allow DB connections from.
  -h, --help                    help for update
```

### orgs

```
Manage Supabase organizations

Usage:
  supabase orgs [command]

Available Commands:
  create      Create an organization
  list        List all organizations

Flags:
  -h, --help   help for orgs
```

#### orgs create

```
Create an organization for the logged-in user.

Usage:
  supabase orgs create [flags]

Flags:
  -h, --help   help for create
```

#### orgs list

```
List all organizations the logged-in user belongs.

Usage:
  supabase orgs list [flags]

Flags:
  -h, --help   help for list
```

### postgres-config

```
Manage Postgres database config

Usage:
  supabase postgres-config [command]

Available Commands:
  delete      Delete specific Postgres database config overrides
  get         Get the current Postgres database config overrides
  update      Update Postgres database config

Flags:
  -h, --help                 help for postgres-config
      --project-ref string   Project ref of the Supabase project.
```

#### postgres-config delete

```
Delete specific config overrides, reverting them to their default values.

Usage:
  supabase postgres-config delete [flags]

Flags:
      --config strings   Config keys to delete (comma-separated)
  -h, --help             help for delete
      --no-restart       Do not restart the database after deleting config.
```

#### postgres-config get

```
Get the current Postgres database config overrides

Usage:
  supabase postgres-config get [flags]

Flags:
  -h, --help   help for get
```

#### postgres-config update

```
Overriding the default Postgres config could result in unstable database behavior.
Custom configuration also overrides the optimizations generated based on the compute add-ons in use.

Usage:
  supabase postgres-config update [flags]

Flags:
      --config strings               Config overrides specified as a 'key=value' pair
  -h, --help                         help for update
      --no-restart                   Do not restart the database after updating config.
      --replace-existing-overrides   If true, replaces all existing overrides with the ones provided. If false (default), merges existing overrides with the ones provided.
```

### projects

```
Manage Supabase projects

Usage:
  supabase projects [command]

Available Commands:
  api-keys    List all API keys for a Supabase project
  create      Create a project on Supabase
  delete      Delete a Supabase project
  list        List all Supabase projects

Flags:
  -h, --help   help for projects
```

#### projects api-keys

```
List all API keys for a Supabase project

Usage:
  supabase projects api-keys [flags]

Flags:
  -h, --help                 help for api-keys
      --project-ref string   Project ref of the Supabase project.
```

#### projects create

```
Create a project on Supabase

Usage:
  supabase projects create [project name] [flags]

Examples:
supabase projects create my-project --org-id cool-green-pqdr0qc --db-password ******** --region us-east-1

Flags:
      --db-password string   Database password of the project.
  -h, --help                 help for create
      --org-id string        Organization ID to create the project in.
      --region string        Select a region close to you for the best performance.
      --size string          Select a desired instance size for your project.
```

#### projects delete

```
Delete a Supabase project

Usage:
  supabase projects delete [ref] [flags]

Flags:
  -h, --help   help for delete
```

#### projects list

```
List all Supabase projects the logged-in user can access.

Usage:
  supabase projects list [flags]

Flags:
  -h, --help   help for list
```

### secrets

```
Manage Supabase secrets

Usage:
  supabase secrets [command]

Available Commands:
  list        List all secrets on Supabase
  set         Set a secret(s) on Supabase
  unset       Unset a secret(s) on Supabase

Flags:
  -h, --help                 help for secrets
      --project-ref string   Project ref of the Supabase project.
```

#### secrets list

```
List all secrets in the linked project.

Usage:
  supabase secrets list [flags]

Flags:
  -h, --help   help for list
```

#### secrets set

```
Set a secret(s) to the linked Supabase project.

Usage:
  supabase secrets set <NAME=VALUE> ... [flags]

Flags:
      --env-file string   Read secrets from a .env file.
  -h, --help              help for set
```

#### secrets unset

```
Unset a secret(s) from the linked Supabase project.

Usage:
  supabase secrets unset [NAME] ... [flags]

Flags:
  -h, --help   help for unset
```

### snippets

```
Manage Supabase SQL snippets

Usage:
  supabase snippets [command]

Available Commands:
  download    Download contents of a SQL snippet
  list        List all SQL snippets

Flags:
  -h, --help                 help for snippets
      --project-ref string   Project ref of the Supabase project.
```

#### snippets download

```
Download contents of the specified SQL snippet.

Usage:
  supabase snippets download <snippet-id> [flags]

Flags:
  -h, --help   help for download
```

#### snippets list

```
List all SQL snippets of the linked project.

Usage:
  supabase snippets list [flags]

Flags:
  -h, --help   help for list
```

### ssl-enforcement

```
Manage SSL enforcement configuration

Usage:
  supabase ssl-enforcement [command]

Available Commands:
  get         Get the current SSL enforcement configuration
  update      Update SSL enforcement configuration

Flags:
  -h, --help                 help for ssl-enforcement
      --project-ref string   Project ref of the Supabase project.
```

#### ssl-enforcement get

```
Get the current SSL enforcement configuration

Usage:
  supabase ssl-enforcement get [flags]

Flags:
  -h, --help   help for get
```

#### ssl-enforcement update

```
Update SSL enforcement configuration

Usage:
  supabase ssl-enforcement update [flags]

Flags:
      --disable-db-ssl-enforcement   Whether the DB should disable SSL enforcement for all external connections.
      --enable-db-ssl-enforcement    Whether the DB should enable SSL enforcement for all external connections.
  -h, --help                         help for update
```

### sso

```
Manage Single Sign-On (SSO) authentication for projects

Usage:
  supabase sso [command]

Available Commands:
  add         Add a new SSO identity provider
  info        Returns the SAML SSO settings required for the identity provider
  list        List all SSO identity providers for a project
  remove      Remove an existing SSO identity provider
  show        Show information about an SSO identity provider
  update      Update information about an SSO identity provider

Flags:
  -h, --help                 help for sso
      --project-ref string   Project ref of the Supabase project.
```

#### sso add

```
Add and configure a new connection to a SSO identity provider to your Supabase project.

Usage:
  supabase sso add [flags]

Examples:
  supabase sso add --type saml --project-ref mwjylndxudmiehsxhmmz --metadata-url 'https://...' --domains example.com

Flags:
      --attribute-mapping-file string   File containing a JSON mapping between SAML attributes to custom JWT claims.
      --domains strings                 Comma separated list of email domains to associate with the added identity provider.
  -h, --help                            help for add
      --metadata-file string            File containing a SAML 2.0 Metadata XML document describing the identity provider.
      --metadata-url string             URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.
      --name-id-format string           URI reference representing the classification of string-based identifier information.
      --skip-url-validation             Whether local validation of the SAML 2.0 Metadata URL should not be performed.
  -t, --type [ saml ]                   Type of identity provider (according to supported protocol).
```

#### sso info

```
Returns all of the important SSO information necessary for your project to be registered with a SAML 2.0 compatible identity provider.

Usage:
  supabase sso info [flags]

Examples:
  supabase sso info --project-ref mwjylndxudmiehsxhmmz

Flags:
  -h, --help   help for info
```

#### sso list

```
List all connections to a SSO identity provider to your Supabase project.

Usage:
  supabase sso list [flags]

Examples:
  supabase sso list --project-ref mwjylndxudmiehsxhmmz

Flags:
  -h, --help   help for list
```

#### sso remove

```
Remove a connection to an already added SSO identity provider. Removing the provider will prevent existing users from logging in. Please treat this command with care.

Usage:
  supabase sso remove <provider-id> [flags]

Examples:
  supabase sso remove b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz

Flags:
  -h, --help   help for remove
```

#### sso show

```
Provides the information about an established connection to an identity provider. You can use --metadata to obtain the raw SAML 2.0 Metadata XML document stored in your project's configuration.

Usage:
  supabase sso show <provider-id> [flags]

Examples:
  supabase sso show b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz

Flags:
  -h, --help       help for show
      --metadata   Show SAML 2.0 XML Metadata only
```

#### sso update

```
Update the configuration settings of a already added SSO identity provider.

Usage:
  supabase sso update <provider-id> [flags]

Examples:
  supabase sso update b5ae62f9-ef1d-4f11-a02b-731c8bbb11e8 --project-ref mwjylndxudmiehsxhmmz --add-domains example.com

Flags:
      --add-domains strings             Add this comma separated list of email domains to the identity provider.
      --attribute-mapping-file string   File containing a JSON mapping between SAML attributes to custom JWT claims.
      --domains strings                 Replace domains with this comma separated list of email domains.
  -h, --help                            help for update
      --metadata-file string            File containing a SAML 2.0 Metadata XML document describing the identity provider.
      --metadata-url string             URL pointing to a SAML 2.0 Metadata XML document describing the identity provider.
      --name-id-format string           URI reference representing the classification of string-based identifier information.
      --remove-domains strings          Remove this comma separated list of email domains from the identity provider.
      --skip-url-validation             Whether local validation of the SAML 2.0 Metadata URL should not be performed.
```

### storage

```
Manage Supabase Storage objects

Usage:
  supabase storage [command]

Available Commands:
  cp          Copy objects from src to dst path
  ls          List objects by path prefix
  mv          Move objects from src to dst path
  rm          Remove objects by file path

Flags:
  -h, --help     help for storage
      --linked   Connects to Storage API of the linked project. (default true)
      --local    Connects to Storage API of the local database.
```

#### storage cp

```
Copy objects from src to dst path

Usage:
  supabase storage cp <src> <dst> [flags]

Examples:
cp readme.md ss:///bucket/readme.md
cp -r docs ss:///bucket/docs
cp -r ss:///bucket/docs .
Flags:
      --cache-control string   Custom Cache-Control header for HTTP upload. (default "max-age=3600")
      --content-type string    Custom Content-Type header for HTTP upload. (default "auto-detect")
  -h, --help                   help for cp
  -j, --jobs uint              Maximum number of parallel jobs. (default 1)
  -r, --recursive              Recursively copy a directory.
```

#### storage ls

```
List objects by path prefix

Usage:
  supabase storage ls [path] [flags]

Examples:
ls ss:///bucket/docs

Flags:
  -h, --help        help for ls
  -r, --recursive   Recursively list a directory.
```

#### storage mv

```
Move objects from src to dst path

Usage:
  supabase storage mv <src> <dst> [flags]

Examples:
mv -r ss:///bucket/docs ss:///bucket/www/docs

Flags:
  -h, --help        help for mv
  -r, --recursive   Recursively move a directory.
```

#### storage rm

```
Remove objects by file path

Usage:
  supabase storage rm <file> ... [flags]

Examples:
rm -r ss:///bucket/docs
rm ss:///bucket/docs/example.md ss:///bucket/readme.md
Flags:
  -h, --help        help for rm
  -r, --recursive   Recursively remove a directory.
```

### vanity-subdomains

```
Manage vanity subdomains for Supabase projects.

Usage of vanity subdomains and custom domains is mutually exclusive.

Usage:
  supabase vanity-subdomains [command]

Available Commands:
  activate           Activate a vanity subdomain
  check-availability Checks if a desired subdomain is available for use
  delete             Deletes a project's vanity subdomain
  get                Get the current vanity subdomain

Flags:
  -h, --help                 help for vanity-subdomains
      --project-ref string   Project ref of the Supabase project.
```

#### vanity-subdomains activate

```
Activate a vanity subdomain for your Supabase project.

This reconfigures your Supabase project to respond to requests on your vanity subdomain.
After the vanity subdomain is activated, your project's auth services will no longer function on the {project-ref}.{supabase-domain} hostname.

Usage:
  supabase vanity-subdomains activate [flags]

Flags:
      --desired-subdomain string   The desired vanity subdomain to use for your Supabase project.
  -h, --help                       help for activate
```

#### vanity-subdomains check-availability

```
Checks if a desired subdomain is available for use

Usage:
  supabase vanity-subdomains check-availability [flags]

Flags:
      --desired-subdomain string   The desired vanity subdomain to use for your Supabase project.
  -h, --help                       help for check-availability
```

#### vanity-subdomains delete

```
Deletes the vanity subdomain for a project, and reverts to using the project ref for routing.

Usage:
  supabase vanity-subdomains delete [flags]

Flags:
  -h, --help   help for delete
```

#### vanity-subdomains get

```
Get the current vanity subdomain

Usage:
  supabase vanity-subdomains get [flags]

Flags:
  -h, --help   help for get
```

---

## Additional Commands

### completion

```
Generate the autocompletion script for supabase for the specified shell.
See each sub-command's help for details on how to use the generated script.

Usage:
  supabase completion [command]

Available Commands:
  bash        Generate the autocompletion script for bash
  fish        Generate the autocompletion script for fish
  powershell  Generate the autocompletion script for powershell
  zsh         Generate the autocompletion script for zsh

Flags:
  -h, --help   help for completion
```

#### completion bash

```
Generate the autocompletion script for the bash shell.

This script depends on the 'bash-completion' package.
If it is not installed already, you can install it via your OS's package manager.

To load completions in your current shell session:

	source <(supabase completion bash)

To load completions for every new session, execute once:

#### Linux:

	supabase completion bash > /etc/bash_completion.d/supabase

#### macOS:

	supabase completion bash > $(brew --prefix)/etc/bash_completion.d/supabase

You will need to start a new shell for this setup to take effect.

Usage:
  supabase completion bash

Flags:
  -h, --help              help for bash
      --no-descriptions   disable completion descriptions
```

#### completion fish

```
Generate the autocompletion script for the fish shell.

To load completions in your current shell session:

	supabase completion fish | source

To load completions for every new session, execute once:

	supabase completion fish > ~/.config/fish/completions/supabase.fish

You will need to start a new shell for this setup to take effect.

Usage:
  supabase completion fish [flags]

Flags:
  -h, --help              help for fish
      --no-descriptions   disable completion descriptions
```

#### completion powershell

```
Generate the autocompletion script for powershell.

To load completions in your current shell session:

	supabase completion powershell | Out-String | Invoke-Expression

To load completions for every new session, add the output of the above command
to your powershell profile.

Usage:
  supabase completion powershell [flags]

Flags:
  -h, --help              help for powershell
      --no-descriptions   disable completion descriptions
```

#### completion zsh

```
Generate the autocompletion script for the zsh shell.

If shell completion is not already enabled in your environment you will need
to enable it.  You can execute the following once:

	echo "autoload -U compinit; compinit" >> ~/.zshrc

To load completions in your current shell session:

	source <(supabase completion zsh)

To load completions for every new session, execute once:

#### Linux:

	supabase completion zsh > "${fpath[1]}/_supabase"

#### macOS:

	supabase completion zsh > $(brew --prefix)/share/zsh/site-functions/_supabase

You will need to start a new shell for this setup to take effect.

Usage:
  supabase completion zsh [flags]

Flags:
  -h, --help              help for zsh
      --no-descriptions   disable completion descriptions
```

### help

```
Help provides help for any command in the application.
Simply type supabase help [path to command] for full details.

Usage:
  supabase help [command] [flags]

Flags:
  -h, --help   help for help
```
