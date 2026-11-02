# supabase-config-push

Updates the configurations of a linked Supabase project with the local `supabase/config.toml` file.

This command allows you to manage project configuration as code by defining settings locally and then pushing them to your remote project.

Pass `--remote=<ref|branch>` to push to a specific project, or the name (or UUID) of a branch of the currently linked project — values that are exactly 20 lowercase letters are always treated as project refs. Without it, the linked project is the target. `--project-ref` still works in v3 but is deprecated and removed in v4; use `--remote`.

Before anything is pushed, the command prints the `Target:` line for the project or branch it resolved (name, ref, and for a branch its parent project), then shows the exact diff for every resource that will change. It then asks once — a single question covering every changed resource, with a default answer of no — and sends nothing until you confirm. If a change enables a paid add-on, its price is printed before the question.

A push with nothing to change never asks. Declining fails the command and writes nothing. Piped answers are never read, so a script, a JSON run (`-o json`, `--output-format json`) or an agent must pass `--yes` or set `SUPABASE_YES` in the shell; a `SUPABASE_YES` in `supabase/.env` does not count. With `--yes` the command echoes `Confirmed by --yes: …` to stderr and pushes.

In `json` output the result carries a `target` object with the resolved identity (`kind`, `project_ref`, `project_name`, `environment`, and `parent_project_ref` for a branch) next to the push summary.
