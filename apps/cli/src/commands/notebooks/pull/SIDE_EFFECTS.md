# `supabase notebooks pull [Notebook id]`

Writes the linked project's notebooks into `supabase/notebooks/<name>.json`, one
file per notebook. A notebook file holds the notebook's API attributes minus the
ones a file cannot own: `name` is carried by the file name, and the server owns
the timestamps, the `owner` / `updated_by` identities, and `content.schema_version`.

## Files Read

| Path                                           | Format     | When                                                                                                             |
| ---------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/notebooks/`                | dir        | when no notebook id is given — to preserve existing notebooks and find local-only notebooks                      |
| `<workdir>/supabase/notebooks/<name>.json`     | JSON       | only for a local-only notebook the user chose to create in the project                                           |
| `<workdir>/supabase/.temp/project-ref`         | plain text | when `--remote=<ref>` and `SUPABASE_PROJECT_ID` are both unset, and as the linked parent for `--remote=<branch>` |
| `<workdir>/supabase/.temp/linked-project.json` | JSON       | existence check before the cache fill, once the project ref resolves                                             |
| `<SUPABASE_HOME or ~/.supabase>/profile`       | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`             |
| `<SUPABASE_PROFILE>` (YAML)                    | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command      |

## Files Written

| Path                                                       | Format | When                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `<workdir>/supabase/notebooks/`                            | dir    | created if absent, before the first notebook is written                                                                                                                                          |
| `<workdir>/supabase/notebooks/.notebook-<random>/<random>` | JSON   | scoped temporary file; linked for creation or renamed for explicit replacement, then cleaned                                                                                                     |
| `<workdir>/supabase/notebooks/<name>.json`                 | JSON   | only when absent during a broad pull, or replaced when its notebook id was explicitly given                                                                                                      |
| `<workdir>/supabase/.temp/linked-project.json`             | JSON   | after the project ref resolves, success or failure — only when no cached file exists, `.temp/project-ref` is absent or names the same ref, a token is available, and the project lookup succeeds |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json`            | JSON   | whenever the handler runs — flushed on success and on failure                                                                                                                                    |

Files are **removed** only when the user picks the delete answer at the
reconciliation prompt: a local notebook naming no project notebook is deleted
from `supabase/notebooks/` and nowhere else.

A project notebook whose name cannot be a file name — one holding `/`, `\`, a
control character, or the name `.` / `..` — is skipped and counted on stderr,
not sanitised: a sanitised name would push back as a rename of somebody's
notebook. Nothing outside `supabase/notebooks/` is ever written: the directory and each
entry are canonicalized and refused when they resolve outside the project root, so a
symlinked `supabase/notebooks` in a checkout cannot redirect a read, write, or delete.

## Reconciliation

With no notebook id given, a project notebook whose file already exists locally
is left unchanged. Only notebooks missing from `supabase/notebooks/` are
downloaded. A local notebook that names no project notebook is either one
somebody deleted in the dashboard or one somebody added locally and never
pushed, and neither list says which. So the command lists them and asks, with
three answers: leave them alone, create them in the project, or delete the local
files.

`keep` is the answer whenever there is nobody to ask — a non-TTY, `-o json|yaml|toml`, a
`--output-format` other than `text`, or a cancelled prompt. The other answers mutate local or remote state, so an unattended run reports the divergence and leaves both
sides alone rather than resolving it in a direction nobody chose.

Given a notebook id, that notebook is fetched directly and its returned name
selects the destination file. An existing file of that name is replaced, and
nothing else is reconciled.

## API Routes

| Method | Path                                | Auth         | Request body                    | Response (used fields)                                                                                                                                                                                                                                   |
| ------ | ----------------------------------- | ------------ | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/projects/{parent}/branches`    | Bearer token | none                            | `[{id, name, project_ref, is_default}]` — only for `--remote=<branch>` (or the deprecated `--project-ref=<branch>`), and for a bare `--remote` followed by a word that could name a branch; `{parent}` is `SUPABASE_PROJECT_ID`, else the linked project |
| `GET`  | `/v1/branches/{id}`                 | Bearer token | none                            | `{ref, status, …}` — only for `--remote=<branch UUID>` when no project is linked                                                                                                                                                                         |
| GET    | `/v2/projects/{ref}/notebooks`      | Bearer       | —                               | `data[].id`, `data[].attributes.name`, `links.next` — broad pull only                                                                                                                                                                                    |
| GET    | `/v2/projects/{ref}/notebooks/{id}` | Bearer       | —                               | `data.{id,attributes.{name,description,favorite,content}}`                                                                                                                                                                                               |
| POST   | `/v2/projects/{ref}/notebooks`      | Bearer       | `data.attributes` from the file | — (only for the create answer)                                                                                                                                                                                                                           |
| GET    | `/v1/projects`                      | Bearer       | —                               | `id`, `name`, `organization_slug`, `region` — project picker; only when no ref comes from `--remote=<ref>`, `SUPABASE_PROJECT_ID` or `.temp/project-ref`, stdin is a TTY and output is interactive                                                       |
| GET    | `/v1/projects/{ref}`                | Bearer       | —                               | linked-project cache fill — best-effort, only when `.temp/linked-project.json` is absent, `.temp/project-ref` is absent or names the same ref, and a token is available; failures are ignored                                                            |

The list route is walked by following `links.next` until it is null, rather than
by counting rows: a short page cannot be told from an exact multiple of the page
size.

## Exit Codes

| Code | Condition                                                                                                                                                                                                              |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0`  | success                                                                                                                                                                                                                |
| `1`  | no project ref — not linked and no `--remote`                                                                                                                                                                          |
| `1`  | the supplied notebook id is not a UUID                                                                                                                                                                                 |
| `1`  | the project holds two notebooks of one name during a broad pull                                                                                                                                                        |
| `1`  | the notebooks path exists but cannot be read as a directory                                                                                                                                                            |
| `1`  | an explicitly requested notebook name cannot be stored safely as a local file                                                                                                                                          |
| `1`  | a Management API call failed (transport, unexpected status, or undecodable body)                                                                                                                                       |
| `1`  | a local file the user chose to create in the project is not a readable notebook                                                                                                                                        |
| `1`  | a local notebook file cannot be written                                                                                                                                                                                |
| `1`  | `-o env`, which cannot represent the payload                                                                                                                                                                           |
| `1`  | invalid `--remote` selector — `--remote=<url>` (`TargetNeedsProjectError`), an empty value, `--remote=<value>` combined with `--project-ref`, or a branch the linked project does not have (`LinkBranchNotFoundError`) |

## Environment Variables

| Variable                | Purpose                                                                                                          | Required?                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `SUPABASE_ACCESS_TOKEN` | Management API bearer token                                                                                      | no (falls back to the stored login)                                       |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path                                                                          | no (falls back to `~/.supabase/profile` -> `supabase`)                    |
| `SUPABASE_PROJECT_ID`   | project ref when `--remote=<ref>` is unset; also the parent project that `--remote=<branch>` is resolved against | no (falls back to `supabase/.temp/project-ref`, then the picker on a TTY) |
| `SUPABASE_WORKDIR`      | project directory the command acts on                                                                            | no (falls back to `--workdir`, then the ancestor walk)                    |
| `SUPABASE_HOME`         | directory holding `telemetry.json`                                                                               | no (falls back to `~/.supabase`)                                          |

## Telemetry Events Fired

| Event                  | When                                           | Notable properties / groups                        |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `cli_command_executed` | post-handler, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags`, project group |

`--remote` is recorded as `true` (bare), the ref, or `<redacted>`; the deprecated
`--project-ref` is recorded verbatim only when it is ref-shaped, never a branch name.
The notebook id argument is not recorded.

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

After the project ref resolves, one `Target: …` banner naming the resolved project is printed on stderr in every output format; see [Command target](../../../../docs/command-target.md).

## Notes

- Requires `--remote=<ref|branch>`, `SUPABASE_PROJECT_ID`, a linked project (`supabase/.temp/project-ref`)
  or, on an interactive terminal, the project picker. A bare `--remote` targets the linked project.
- `--remote=<value>` is read as a project ref (20 lowercase letters), a branch of the linked
  project (by name or UUID), or `true|yes|on|1` for the linked project. A database URL is rejected
  (`supabase notebooks pull` takes a project, not a database); `false|no|off|0` and `--no-remote` fail with `--remote doesn't take false. Leave it out to use the linked project.`, and an empty value with `--remote= has an empty value. Pass --remote for the linked project or --remote=<ref|branch>; leave it out to use the linked project.`
- A bare `--remote` followed by a word that exactly matches a branch of the linked project, is
  within a small edit distance of one, or can't be checked because the branch listing failed stops
  the run before any other work with an error that names the cause (an HTTP status, or a missing or invalid access token) and offers both readings without echoing the word: `--remote=<branch>` for the branch, the command's operands then `--remote` for the linked project. Any other word runs as the operand.
- The deprecated `--project-ref` is an alias of `--remote=<ref>` (a non-ref value is read as a
  branch name) and prints a deprecation warning on stderr that names the replacement; it cannot
  be combined with `--remote=<value>`.
