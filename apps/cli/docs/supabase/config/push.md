## supabase-config-push

Update the linked project, or one of its branches, with the properties your local `supabase/config.toml` declares. This lets you manage project configuration as code. Properties the file does not declare are left unchanged.

Pass `--remote=<ref|branch>` to push to a specific project, or the name (or UUID) of a branch of the currently linked project. Values that are exactly 20 lowercase letters are always treated as project refs. Without `--remote`, the linked project is the target.

`--project-ref` still works in v3 but is deprecated and removed in v4; use `--remote`.

Before anything is pushed, the command prints the `Target:` line for the resolved project or branch (name, ref, and for a branch its parent project). It then shows the exact diff for every resource that will change. If a change enables a paid add-on, its price is printed before the question.

The command asks once, with one question covering every changed resource and a default answer of no. It sends nothing until you confirm. A push with nothing to change never asks, and declining fails the command and writes nothing.

Piped answers are never read, so a script, a JSON run (`-o json`, `--output-format json`) or an agent must pass `--yes` or set `SUPABASE_YES` in the shell. A `SUPABASE_YES` in `supabase/.env` does not count. With `--yes` the command echoes `Confirmed by --yes: …` to stderr and pushes.

In `json` output the result carries a `target` object with the resolved identity (`kind`, `project_ref`, `project_name`, `environment`, and `parent_project_ref` for a branch) next to the push summary.
