# supabase-pull

Pull a remote project into a local `supabase/` directory with one command:

```sh
supabase pull --project-ref abcdefghijklmnopqrst --use-api --yes
```

In a linked project, run `supabase pull`. Use the global `--workdir` flag to
select the destination project directory. The directory must already exist.
An existing local config is reused. From a subfolder with no `supabase/`
directory, the nearest project is reused if it is linked; otherwise the command
runs the standard init scaffold in the current folder before project lookup.
A linked folder with missing config is initialized without removing its link.
`SUPABASE_WORKDIR` also selects the destination; `--workdir` takes precedence.
An explicit destination never falls back to a linked parent. Link detection uses
`supabase/.temp/project-ref`, not the metadata cache.

The command runs these existing operations in order:

1. `config pull` updates the local configuration, retaining its confirmation,
   secret masking, remote overlay, and git dirty-file checks.
2. `db pull --declarative` exports schema with pg-delta, normally to
   `supabase/schemas/`. It creates no migrations and does not update remote
   migration history. Existing pg-delta directory/format settings apply.
3. `functions download` downloads every deployed Edge Function.
4. `secrets list` supplies the names for `supabase/functions/.env.example`.
   Each name has an empty value; secret digests are excluded. The example is
   regenerated on each successful pull, even when no secrets exist.
5. Offers to run `link` after the export, unless the folder is already linked to
   the selected project. Declining keeps the export and any existing link.

Use `--password` for the database password, `--strict-coverage` to fail when
pg-delta finds objects it cannot manage, and `--use-api` for server-side function
unbundling without Docker. `--yes` accepts both config and link confirmation;
`--force` permits config writes over uncommitted changes. Use `--link` to link
without prompting or `--link=false` to skip linking even with `--yes`.
Without `--yes` or `--link`, noninteractive exports stay unlinked. When the
folder is linked to a different project, the prompt explicitly asks to replace
that link.

This captures the project's configuration, database schema, and function source.
Database rows, storage objects and secret values are not exported. Config fields
that the API masks or cannot return retain config pull's existing warnings and
skip behavior. Fill secret values into a local environment file yourself.

A declined config confirmation stops the command. A failure stops subsequent
steps and retains completed writes. Existing local functions absent remotely
are not deleted. Use `--output-format json` or `stream-json` for one combined
result including the individual component results, secret names, and `linked`
(whether the folder is linked to the pulled project). A link failure retains
the exported files and fails the command.
