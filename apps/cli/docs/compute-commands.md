# Compute commands

The experimental Compute command family runs application containers alongside a
project; it is separate from the database instance size. Its commands and local
configuration may change incompatibly while experimental. The family is opt in. Enable it with
`SUPABASE_EXPERIMENTAL_COMPUTE=1` or by setting `compute = true` under
`[experimental]` in `supabase/config.toml`.

The environment variable accepts a boolean (`1`, `t`, `T`, `TRUE`, `true`, `True` / `0`, `f`, `F`, `FALSE`, `false`, `False`;
other casings such as `tRue` fail) to enable or disable the family. When it is unset or empty, the config file is used; any
non-boolean value reports an
invalid feature-flag value on Compute paths (including their completion), root
help, or root-level completion before a subcommand is chosen.
Unrelated commands do not resolve the Compute flag. Unreadable or malformed
configuration leaves Compute disabled. An environment opt-in applies only to
that process; use the project setting to share the opt-in with teammates and CI.

```toml
[experimental]
compute = true
```

For `supabase/config.json`, use the equivalent JSON object:

```json
{
  "experimental": {
    "compute": true
  }
}
```

When enabled, the CLI exposes:

- `supabase compute new`
- `supabase compute push`
- `supabase compute list`
- `supabase compute status`
- `supabase compute logs`
- `supabase compute delete`

`supabase compute logs` remains available until v4 with its existing `--tail`,
`--kind`, and `-f/--follow` options. It prints a deprecation warning on stderr.
For the new log browser, read Compute logs with `supabase logs --remote --service compute`. Use
`--resource <name>` to select an application and `--kind app|requests|builds` to
select its log stream. Press `L` in the interactive browser to load more logs.

Compute source directories live under `supabase/compute/<name>/`.

`compute new` edits TOML configuration. It refuses projects whose authoritative
configuration is JSON before prompting or writing, so it cannot save deployment
settings into an ignored file. To deploy a source directory without a Compute
configuration entry, `compute push` requires an explicit `--exposure public` or
`--exposure private`. Record the entry in the authoritative config to persist
its deployment settings.

`compute push` and `compute delete` change the remote project, so both ask for
confirmation first, and both default to no. `compute delete` asks for the
compute's name to be typed back. Pass `--yes`, or set `SUPABASE_YES` in your
shell, to confirm in scripts and CI; without it, a run that cannot prompt fails
before changing anything.

## Excluding files from the build context

`compute push` packages a compute's source directory into the build context, minus the paths
that `[compute.<name>] exclude` matches. Patterns follow `.gitignore`'s path rules:

- A pattern matches that name at any depth unless a `/` other than a trailing one anchors it
  at the compute's source directory: `dist/` matches every `dist` directory, `/dist/` only
  the top-level one.
- A trailing `/` matches directories only. Repeated trailing separators count as one, so
  `dist/` and `dist//` are the same pattern.
- `**` spans directories. Within one segment, `*`, `?` and character classes such as `[a-z]`
  work as in the CLI's other glob options; a class negates with `^` (`[^a]`), not `!`.

An excluded directory is not descended into, so everything beneath it is out too, and the
`excluded <n> paths` count on the packaged line counts the directory, not its contents. For
the same reason, a trailing `**` matches what is inside a directory rather than the directory
itself: `cache/**` empties `cache` and keeps the directory, while `cache` removes it.

Re-inclusion with `!` is refused rather than read as a file name: a pattern re-admitting a
path beneath an excluded directory could never be reached. Empty patterns, empty path
segments (`src//dist`) and malformed character classes are refused too. Every refusal names
the compute and the pattern, and happens before anything is packaged or uploaded.

`compute push` applies only the patterns recorded in the config; it has no built-in defaults,
so a compute without an `exclude` key uploads its whole source directory. `compute new`
writes the selected runtime's default list into the project config, where it can be edited.

A source whose every file is excluded fails before upload with an error naming the patterns.
An excluded symbolic link is skipped before the CLI checks whether it points outside the
source directory, so excluding a hoisted `node_modules` link resolves the escaping-link error.
