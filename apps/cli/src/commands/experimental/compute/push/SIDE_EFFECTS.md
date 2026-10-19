# `supabase compute push [name...] (alias: deploy)`

## Feature gate

This command is registered only when `experimental.compute` is enabled. Set
`SUPABASE_EXPERIMENTAL_COMPUTE=1` to enable it, or `0` to disable it; an unset
or empty variable uses the project configuration. Any non-boolean value
reports an invalid feature-flag value before command parsing. When disabled, it is absent from
help and completion; direct invocation follows the normal unknown-command path
and the command handler does not run. See the [Compute command guide](../../../../../docs/compute-commands.md).

> **No live test yet.** `compute` runs against the v2 Management API, which the
> supabase/cli-e2e-ci supabox stack is not expected to serve, so a `*.live.test.ts`
> here would be permanently skipped or permanently red. Revisit when the v2
> Compute routes are available on that stack.

## Files Read

| Path                                     | Format     | When                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.json`         | JSON       | always when present — preferred over `config.toml`; each compute's runtime, size, exposure, instances, source. An explicit `--workdir`/`SUPABASE_WORKDIR` is read exactly as given, with no ancestor search; with a DEFAULTED workdir the loader may resolve an ancestor project's `config.json` from a subdirectory (CLI-2285), and the resolved compute `source` below resolves against that SAME ancestor root |
| `<workdir>/supabase/config.toml`         | TOML       | always when no `config.json` exists — the same compute fields, with the same explicit-vs-default workdir rule                                                                                                                                                                                                                                                                                                     |
| `<compute source>/**`                    | any        | always — packaged into the build context, minus whatever `[compute.<name>] exclude` matches. An excluded directory is not descended into, so nothing under it is read at all                                                                                                                                                                                                                                      |
| `<workdir>/supabase/.temp/project-ref`   | plain text | when neither `--remote=<ref>` nor `SUPABASE_PROJECT_ID` is set — names the linked project                                                                                                                                                                                                                                                                                                                         |
| `<SUPABASE_HOME or ~/.supabase>/profile` | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`                                                                                                                                                                                                                                                                                                              |
| `<SUPABASE_PROFILE>` (YAML)              | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command                                                                                                                                                                                                                                                                                                       |

## Files Written

| Path                                            | Format | When                                                                                                                                                                                                                              |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json` | JSON   | always — flushed on success and on failure                                                                                                                                                                                        |
| `<workdir>/supabase/.temp/linked-project.json`  | JSON   | post-run, once the project ref has resolved (success or failure), only when no such file exists, `<workdir>/supabase/.temp/project-ref` doesn't name another ref, an access token exists and `GET /v1/projects/{ref}` returns 200 |

## Confirmation

Before anything is uploaded, the command asks `deploy compute <names>?` (default
**No**). `--yes` (the root persistent flag) or a shell `SUPABASE_YES` answers it and
prints `Confirmed by --yes: …` on stderr; a `SUPABASE_YES` in a project `.env` does not
count. With neither — and no interactive terminal to prompt on, which includes a
redirected stdout, piped stdin and any `--output-format json`/`stream-json` or `-o`
machine format — the command fails with the consent-required error rather than
deploying unasked. Stdin is never read for the answer.

## API Routes

| Method          | Path                                         | Auth                                        | Request body                                        | Response (used fields)                                                                                                                                                                                                                                                                          |
| --------------- | -------------------------------------------- | ------------------------------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`          | `/v2/projects/{ref}/compute/{name}/uploads`  | Bearer token                                | none                                                | `data.id`, `data.attributes.url/method`                                                                                                                                                                                                                                                         |
| `POST` or `PUT` | presigned upload URL (control-plane storage) | URL signature — **no** Supabase credentials | `.tar.gz` build context                             | status only. The method is the one the upload slot names: `POST` if it says so, else `PUT`                                                                                                                                                                                                      |
| `POST`          | `/v2/projects/{ref}/compute/{name}/deploy`   | Bearer token                                | `{data:{type,attributes:{spec,context_upload_id}}}` | `data.attributes.build_state`                                                                                                                                                                                                                                                                   |
| `GET`           | `/v2/projects/{ref}/compute/{name}`          | Bearer token                                | none                                                | `build_state`, `state_reason`, `image_version`, `spec`                                                                                                                                                                                                                                          |
| `GET`           | `/v1/projects`                               | Bearer token                                | none                                                | `id`, `name`, `organization_slug`, `region` — project picker: only when no ref resolves from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `supabase/.temp/project-ref` and stdin and stdout are TTYs                                                                                              |
| `GET`           | `/v1/projects/{ref}`                         | Bearer token                                | none                                                | `ref`, `name`, `organization_id`, `organization_slug` — linked-project cache miss only (best-effort, post-run): written only when `<workdir>/supabase/.temp/linked-project.json` doesn't exist, `.temp/project-ref` doesn't name another ref, an access token exists and the lookup returns 200 |
| `GET`           | `/v1/projects/{parent}/branches`             | Bearer token                                | none                                                | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project                                        |

`GET /v2/projects/{ref}/compute/{name}` is polled until `build_state` leaves
`building`. It is skipped entirely in two cases: under `--no-wait`, and when
the deploy response already carried a terminal `build_state`. Either way the
run reports the accepted spec the deploy response returned.

## Exit Codes

| Code | Condition                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                               |
| `1`  | no compute named and none found in the project                                                        |
| `1`  | a selected unconfigured source directory has no explicit `--exposure` (`MissingComputeExposureError`) |
| `1`  | config records a runtime, size or exposure the CLI does not know                                      |
| `1`  | `[compute.<name>] exclude` records a pattern the CLI cannot act on (`InvalidComputeExcludeError`)     |
| `1`  | `[compute.<name>] exclude` matches every file in the source (`ComputeSourceMissingError`)             |
| `1`  | a compute's source is missing, not a directory, or empty                                              |
| `1`  | a compute's source directory cannot be read                                                           |
| `1`  | a compute's source links to a path outside itself                                                     |
| `1`  | build context upload failed                                                                           |
| `1`  | the build reached `failed`, or never left `building`                                                  |
| `1`  | with `--no-wait`: the deploy was answered with `build_state: failed`                                  |
| `1`  | confirmation declined                                                                                 |
| `1`  | confirmation needed but this run can't prompt, and no `--yes`                                         |
| `1`  | API error, or project not enrolled in the alpha                                                       |

## Environment Variables

| Variable                        | Purpose                                                                                                                                         | Required?                                                                                                                                                                                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SUPABASE_EXPERIMENTAL_COMPUTE` | command registration (boolean `1`/`true` enables, `0`/`false` disables; unset/empty uses `experimental.compute`; non-boolean values are errors) | no                                                                                                                                                                                                                                    |
| `SUPABASE_ACCESS_TOKEN`         | auth token (bypasses credential file/keyring lookup)                                                                                            | no (falls back to keyring → `~/.supabase/access-token`)                                                                                                                                                                               |
| `SUPABASE_PROJECT_ID`           | project ref, consulted after `--remote=<ref>`                                                                                                   | no (falls back to `supabase/.temp/project-ref`, then the picker)                                                                                                                                                                      |
| `SUPABASE_PROFILE`              | built-in profile name or YAML file path                                                                                                         | no (falls back to `~/.supabase/profile` -> `supabase`)                                                                                                                                                                                |
| `SUPABASE_WORKDIR`              | project directory the command acts on                                                                                                           | no (falls back to `--workdir`, then the ancestor walk) — read exactly as given when SET (flag or env), with **no ancestor search**; a DEFAULTED workdir may still resolve an ancestor project's config from a subdirectory (CLI-2285) |
| `SUPABASE_HOME`                 | directory holding `telemetry.json`                                                                                                              | no (falls back to `~/.supabase`)                                                                                                                                                                                                      |
| `SUPABASE_YES`                  | answers the deploy confirmation, as `--yes` does                                                                                                | no (defaults to prompting)                                                                                                                                                                                                            |

## Telemetry Events Fired

| Event                  | When                                       | Notable properties / groups         |
| ---------------------- | ------------------------------------------ | ----------------------------------- |
| `cli_command_executed` | post-run, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags` |

No custom events — only the `cli_command_executed` that the instrumentation
wrapper emits for every command.

## Output Formats

`-o env` is refused **before** the first deploy rather than at emit time: the
payload always carries a `compute` array, which a flat `KEY=value` list cannot
express, and discovering that at the end would fail the command with the remote
project already changed.

Under `--no-wait` the deploy returns with the build still running, so the
follow-up hint (`compute status`) is emitted as a success trailer: stderr,
once, at the end of the run rather than between compute. **Text output
only** — like the rest of the human deploy report it sits behind
`output.format === "text"` and the `-o` check, so `--output-format json`,
`stream-json` and every `-o` mode emit no hint. Machine callers read
`build_state` from the payload instead. The hint carries
`--remote=<ref>`, the resolved project ref, when a `--remote=<value>` or `--project-ref` was given, since it is copy-pasted verbatim.

A multi-compute run stops at the first failure, and names on stderr in **every**
format, machine ones included, both the compute it never attempted and — under
`--no-wait` — the accepted compute whose builds it left running. Neither report
has the trailer's format guard: that run is a CI run, where nobody watched the
loop, and "what still needs deploying" and "what is still in flight" are both
part of the question the failure raises. The second report also covers a real
gap, since `runCli` drains success trailers only on exit code 0, so a failing
run discards every follow-up hint it had queued.

A source directory without a `[compute.<name>]` entry requires explicit
`--exposure public` or `--exposure private`; a bare push fails with
`MissingComputeExposureError` before any selected Compute is packaged, uploaded,
or deployed. A
configured entry retains its existing exposure default.

`--exposure` decides one deploy and nothing writes it down, so an override the
config does not already agree with is reported on stderr, naming the
`[compute.<name>] exposure` line to add. Unguarded by format, like the
runtime-guess nudge: every deploy sends a complete spec, so an override does not
change the configuration used by a later push. An unconfigured source directory
continues to require an explicit exposure on every push. Silent when the config already resolves to the same
exposure, case included.

Under `--no-wait` the `Image` row and the payload's `image_version` are omitted
while `build_state` is `building`. The deploy response may carry an
`image_version` — a re-push of a compute that is already serving echoes the image
it is serving now — and that is the previous build's, not this one's.

## `[compute.<name>] exclude`

Patterns are read the way `.gitignore` reads them: one without `/` matches that name at any
depth, one with `/` is anchored at the compute's source directory, a trailing `/` matches
directories only, `**` spans directories, and within a single segment the syntax is the CLI's
existing glob matcher (`*`, `?`, `[a-z]`). An excluded directory is not descended into, so
everything beneath it is out too — which is also why the reported count counts the path the
walk turned back at rather than what sat underneath it.

Two details follow from that pruning. A **trailing** `**` matches what is inside a directory
rather than the directory itself, so `cache/**` empties `cache` and leaves the directory in the
archive, while `cache` on its own removes it; a `**` anywhere else may still span nothing, so
`build/**/cache` matches `build/cache`. And repeated trailing separators are normalized before
anchoring is decided, so `dist/` and `dist//` are the same unanchored directory pattern.

Re-inclusion (`!`) is **not** supported and is refused rather than read as a literal filename:
excluding a directory stops the walk there, so a pattern re-admitting something beneath it could
never be reached. An empty pattern, an empty path segment (`src//dist`), and a malformed
character class are refused the same way. Every refusal names the compute and the pattern.

All of it is refused **before** anything is packaged or uploaded, beside the runtime, size and
exposure checks: a pattern the CLI cannot read is knowable from `config.toml` alone.

`push` applies only the patterns the project recorded — there are no built-in defaults, so a
compute with no `exclude` key uploads its source directory whole, including one scaffolded by a
CLI that predates the setting. `compute new` is what writes a runtime's default list, into
`config.toml` where it can be read and edited.

When patterns are configured, the packaged line carries the count: `Packaged
supabase/compute/api (3 files, 1.2 KiB, excluded 2 paths).` The clause is omitted entirely when
the compute records no patterns, so an unconfigured compute's output is unchanged.

A source directory whose every file is excluded fails with `ComputeSourceMissingError` before
the upload, naming the patterns rather than reporting the "only empty directories" case that a
genuinely empty tree gets. The two are told apart by whether any path was actually excluded,
not by whether patterns were configured — a tree of nothing but empty directories packages to
zero files whatever `exclude` says, and blaming a pattern that matched nothing would send the
user to edit a line that is doing its job.

An excluded symlink is excluded **before** it is vetted for escaping the build context, so
adding a hoisted `node_modules` link to `exclude` is a real answer to
`ComputeSourceEscapingLinkError` rather than something that failure pre-empts.

The presigned upload above is the one request whose URL is itself a credential.
`--debug` logs every request URL, so `httpClientLayer` redacts query
strings that carry a signature.

## Notes

- Targets the linked project unless `--remote=<ref>` is given; a bare `--remote` also targets the linked project. `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked project (by name or UUID, resolved through `GET /v1/projects/{parent}/branches`), or `true|yes|on|1` for the linked project. A database URL is rejected (`supabase experimental compute push` takes a project, not a database); `false|no|off|0`, `--no-remote` and an empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that is a branch of the linked project fails before any other work with a `Did you mean --remote=<word>?` hint, since the word may have been meant as the flag's value.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` and prints a deprecation warning on stderr that names the replacement; it cannot be combined with `--remote=<value>`. An empty `--project-ref` is rejected.
