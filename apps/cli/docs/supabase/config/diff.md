## supabase-config-diff

Compare your local `supabase/config.toml` with the effective configuration of a remote project or branch, to see what `config push` would change. Read-only: it never modifies the local file or any remote configuration.

Pass `--remote=<ref|branch>` to compare against a specific project, or the name (or UUID) of a branch of the currently linked project. Values that are exactly 20 lowercase letters are always treated as project refs. Without `--remote`, the linked project is the target.

`--project-ref` still works in v3 but is deprecated and removed in v4; use `--remote`. When the target ref matches the `project_id` of a `[remotes.*]` block, that block's merged config is the local side of the comparison.

Only platform-managed properties are compared. Local-stack-only sections, such as `[studio]`, `[analytics]`, `[functions]`, `[edge_runtime]`, port numbers, image version pins and `[db.migrations]`, have no hosted counterpart and are never reported, whether or not your file declares them.

Each difference is classified as one of:

- `update`: the file declares a value that differs remotely.
- `remote-only`: the remote differs while the file is silent. The shown local value is the schema default that a `config push` would write.
- `local-only`: the file declares a value that the remote did not report.

`(unset)` means the local side has no value at all. `(not returned)` means the response did not carry the property.

Secret values are never compared, because the platform only reports digests. They are listed in a masked-credentials note, as are declared properties that `config push` cannot communicate and any block the response omitted entirely.

Local values are shown as the configuration your file would produce once pushed, not its literal spelling. For example, a duration written as `"1m"` renders as `"1m0s"`, and byte sizes are shown in the units you wrote.

With `--exit-code`, the command exits `2` when any difference is found and keeps exit `1` for errors, so scripts can tell drift from failure.

Machine-readable output is available through `--output-format json|stream-json`. The payload is versioned and contains `schema_version`, `config_schema`, `target`, `scope`, `changes[]`, `masked[]`, `unmanaged[]` and `counts`, with per-change `path`s as segment arrays.

`target` identifies the compared project: `kind` (`linked`), `project_ref`, `project_name`, and `environment` (`production`, `branch` or `unverified`) when known. It also carries `parent_project_ref` for a branch, `branch` when one was named, and `local_scope` (`base` or `remotes.<name>`).

The legacy global `-o`/`--output` flag is not supported by this command; use `--output-format json|stream-json` instead.
