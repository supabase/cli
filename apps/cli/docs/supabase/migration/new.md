## supabase-migration-new

Create an empty migration file for you to fill in. Output from other commands, such as `db diff`, can be piped to `migration new <name>` through stdin.

The command creates the `supabase/migrations` directory in your current `workdir` if it does not exist. Every migration file in this directory is named `<timestamp>_<name>.sql`.
