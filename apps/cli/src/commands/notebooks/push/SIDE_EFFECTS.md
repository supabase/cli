# `supabase notebooks push [Notebook name]`

Writes `supabase/notebooks/<name>.json` into the linked project, one call per
file. A file is matched to a project notebook **by name** — the API assigns a
uuid, but a checkout is shared through git and a uuid in a file name is
unreadable — so a file whose name a project notebook already carries updates that
notebook, and one with no match creates a new notebook.

## Files Read

| Path                                           | Format     | When                                                                                                             |
| ---------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/notebooks/`                | dir        | always — the file names are the notebook names; missing means empty, while any other read failure aborts         |
| `<workdir>/supabase/notebooks/<name>.json`     | JSON       | one per notebook being pushed; all of them are read and decoded before the first call                            |
| `<workdir>/supabase/.temp/project-ref`         | plain text | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` are both unset, and as the linked parent for `--remote=<branch>` |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | existence check before the cache fill, once the project ref resolves                                             |
| `<SUPABASE_HOME or ~/.supabase>/profile`       | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`             |
| `<SUPABASE_PROFILE>` (YAML)                    | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command      |

Every file is read and decoded **before** the first write, so a directory holding
one unreadable notebook fails without having half-pushed the rest.

Files under `supabase/notebooks/` that do not end in `.json`, and ones whose name
cannot be a notebook name, are ignored rather than pushed. Reconciliation is chosen before uploads. Names are checked for local-file safety only
when the user selects copying into the directory; unsupported names can still be
kept or deleted remotely. All selected downloads are read before uploads begin.

## Files Written

| Path                                                       | Format | When                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/notebooks/.notebook-<random>/<random>` | JSON   | scoped temporary file; atomically linked to `<name>.json`, then cleaned                                                                                                                          |
| `<workdir>/supabase/notebooks/<name>.json`                 | JSON   | only for a project-only notebook the user chose to write into the directory                                                                                                                      |
| `<workdir>/supabase/.temp/linked-project.json`             | JSON   | after the project ref resolves, success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json`            | JSON   | whenever the handler runs — flushed on success and on failure                                                                                                                                    |

Nothing local is ever removed by `push`.

## Reconciliation

With no notebook name given, a project notebook that names no local file is
either one somebody deleted from the checkout or one somebody added in the
dashboard, and neither list says which. So the command lists them and asks, with
three answers: leave them alone, write them into `supabase/notebooks/`, or delete
them from the project.

`keep` is the answer whenever there is nobody to ask — a non-TTY, `-o json|yaml|toml`, a
`--output-format` other than `text`, or a cancelled prompt. The other answers mutate local or remote state, so an unattended run reports the divergence and leaves both
sides alone rather than resolving it in a direction nobody chose.

Given a notebook name, nothing is reconciled at all: the argument says which
notebook to act on, so the project's other notebooks are not that invocation's
business.

Notebook files are read only from inside the project: `supabase/notebooks/` and each
entry are canonicalized and refused when they resolve outside the project root.

## Confirmation

- After the project ref resolves, one `Target: …` banner naming the resolved project is printed on stderr in every output format; see [Command target](../../../../docs/command-target.md).
- Asks `Push <n> notebook(s) on <target>?` (`Push <n> notebook(s) and delete <m> from the project on <target>?` for the delete answer; default No) before the first write, after printing one `Create`, `Update` or `Delete` line per notebook. `--yes` or a shell `SUPABASE_YES` confirms without asking; a piped `y` on stdin is never read. Without `--yes`, a non-interactive, JSON, stream-json or `-o` run fails with `HostedMutationConsentRequiredError`, and declining fails with `HostedMutationDeclinedError`; neither changes anything.
- No confirmation is asked when nothing would be uploaded or deleted (an empty notebooks directory with the `keep` or write-locally answer). The reconciliation question above is separate: it chooses what to do with project-only notebooks, and the confirmation covers the resulting uploads and deletes together.

## API Routes

| Method | Path                                | Auth         | Request body                           | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | ----------------------------------- | ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{parent}/branches`    | Bearer token | none                                   | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| GET    | `/v2/projects/{ref}/notebooks`      | Bearer       | —                                      | `data[].id`, `data[].attributes.name`, `links.next`                                                                                                                                                                                                      |
| POST   | `/v2/projects/{ref}/notebooks`      | Bearer       | `data.attributes` — name plus the file | —                                                                                                                                                                                                                                                        |
| PATCH  | `/v2/projects/{ref}/notebooks/{id}` | Bearer       | `data.attributes` — name plus the file | —                                                                                                                                                                                                                                                        |
| DELETE | `/v2/projects/{ref}/notebooks/{id}` | Bearer       | —                                      | — (only for the delete answer)                                                                                                                                                                                                                           |
| GET    | `/v2/projects/{ref}/notebooks/{id}` | Bearer       | —                                      | — (only for the write-locally answer)                                                                                                                                                                                                                    |
| GET    | `/v1/projects`                      | Bearer       | —                                      | `id`, `name`, `organization_slug`, `region` — project picker; only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, stdin is a TTY and output is interactive                                                       |
| GET    | `/v1/projects/{ref}`                | Bearer       | —                                      | linked-project cache fill — best-effort, only when `.temp/linked-project.json` is absent, `.temp/project-ref` is absent or names the same ref, and a token is available; failures are ignored                                                            |

`content` replaces the whole notebook body, and a cell keeps its identity by
echoing back its `id` — which is why a pulled file carries cell ids and a push
sends them as written. A cell with no `id` is added as a new one.

Attributes the file leaves out stay out of the request, so a notebook whose file
never mentions `favorite` keeps whatever the dashboard set.

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                |
| `1`  | no project ref — not linked and no `--remote`                                                                                                                                                                          |
| `1`  | the named notebook is not in `supabase/notebooks/`                                                                                                                                                                     |
| `1`  | a file is unreadable, not JSON, or not a notebook — before anything is sent                                                                                                                                            |
| `1`  | duplicate remote names (only the selected name for a named push)                                                                                                                                                       |
| `1`  | the notebooks path exists but cannot be read as a directory                                                                                                                                                            |
| `1`  | a project notebook name cannot be stored safely as a local file                                                                                                                                                        |
| `1`  | a Management API call failed (transport, unexpected status, or undecodable body)                                                                                                                                       |
| `1`  | `-o env`, which cannot represent the payload                                                                                                                                                                           |
| `1`  | declined at the confirmation prompt (`HostedMutationDeclinedError`, `context canceled`) — nothing is changed                                                                                                           |
| `1`  | JSON, stream-json, `-o` or non-interactive run without `--yes` (`HostedMutationConsentRequiredError`) — nothing is changed                                                                                             |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |

## Environment Variables

| Variable                | Purpose                                                                                                          | Required?                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | Management API bearer token                                                                                      | no (falls back to the stored login)                                       |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                                                          | no (falls back to `~/.supabase/profile` -> `supabase`)                    |
| `SUPABASE_PROJECT_ID`   | project ref when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against | no (falls back to `supabase/.temp/project-ref`, then the picker on a TTY) |
| `SUPABASE_WORKDIR`      | project directory the command acts on                                                                            | no (falls back to `--workdir`, then the ancestor walk)                    |
| `SUPABASE_HOME`         | directory holding `telemetry.json`                                                                               | no (falls back to `~/.supabase`)                                          |
| `SUPABASE_YES`          | confirms the hosted mutation without asking; only the shell environment counts, never `supabase/.env`            | no (falls back to the interactive prompt)                                 |

## Telemetry Events Fired

| Event                  | When                                           | Notable properties / groups                        |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `cli_command_executed` | post-handler, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags`, project group |

`--remote` is recorded as `true` (bare), the ref, or `<redacted>`; the deprecated
`--project-ref` is recorded verbatim only when it is ref-shaped, never a branch name.
The notebook name argument is user content and is not.

## Filename safety and failures

Filenames must fit within 255 UTF-8 bytes including `.json`. Windows reserved
characters, device names (including extensions), trailing spaces/dots, path
separators, and control characters are unsupported. Broad pulls skip and count
unsupported names; explicit pulls and reconciliation copies reject them.

Before copying locally, names are compared using Unicode NFC normalization and
lowercasing against both selected notebooks and existing directory entries.
Conflicting filenames fail before writes rather than silently aliasing on another
filesystem. Creation uses an atomic hard link from a scoped temporary file and
fails if the destination appears during the operation. Only an explicit pull by
id replaces an existing file. Temporary files are removed on success, failure,
and interruption.

A missing, empty, or previously visited pagination cursor fails with a typed API
response error. Partial inventories are never used to reconcile notebooks.

Network operations show progress in text mode; machine output remains payload-only.
`-o table` and `-o csv` are rejected by command instrumentation before the handler
runs. `-o env` is rejected by the handler before resolving the project.

## Notes

- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase notebooks push` takes a project, not a database); `false|no|off|0`, `--no-remote` and an
  empty value fail with `Leave out --remote to use the linked project.`
- A bare `--remote` followed by a word that is a branch of the linked project fails before any
  other work with a `Did you mean --remote=<word>?` hint, since the word may have been meant as
  the flag's value.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
