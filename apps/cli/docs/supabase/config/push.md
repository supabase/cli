# supabase-config-push

Updates the configurations of a linked Supabase project with the local `supabase/config.toml` file.

This command allows you to manage project configuration as code by defining settings locally and then pushing them to your remote project.

Pass `--project-ref` to push to a specific project, or the name (or UUID) of a branch of the currently linked project — values that are exactly 20 lowercase letters are always treated as project refs. Without it, the linked project is the target.

Before anything is pushed, the command reports the project it resolved — its name and ref. When the resolved target is a preview branch that was only _inferred_ (for example after `supabase link <branch-name>`, or via `SUPABASE_PROJECT_ID`) rather than named on this invocation, it says so, names the branch and its parent project where they can be resolved, and asks for confirmation first. Declining — including on an unattended run with no `--yes` and no piped answer — fails the command rather than pushing. Pass `--yes` (or set `SUPABASE_YES`) to skip that confirmation in CI and scripted runs.

An explicit `--project-ref <branch-name-or-uuid>` on the same invocation skips the confirmation entirely (the target is still echoed) — naming the branch yourself already counts as confirming it. Because the confirmation reads one line of piped input just like any other prompt, a script piping multiple `y`/`n` answers to an _inferred_ branch target needs one extra leading answer for it, ahead of the per-service prompts it already answers.
