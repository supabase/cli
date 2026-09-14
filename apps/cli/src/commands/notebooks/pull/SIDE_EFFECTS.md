# `supabase notebooks pull [Notebook id]`

Writes the linked project's notebooks into `supabase/notebooks/<name>.json`, one
file per notebook. A notebook file holds the notebook's API attributes minus the
ones a file cannot own: `name` is carried by the file name, and the server owns
the timestamps, the `owner` / `updated_by` identities, and `content.schema_version`.

## Files Read

| Path                                       | Format     | When                                                                                                        |
| ------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/notebooks/`            | dir        | when no notebook id is given — to preserve existing notebooks and find local-only notebooks                 |
| `<workdir>/supabase/notebooks/<name>.json` | JSON       | only for a local-only notebook the user chose to create in the project                                      |
| `<SUPABASE_HOME or ~/.supabase>/profile`   | plain text | when neither `--profile` nor `SUPABASE_PROFILE` is set — names the profile, defaulting to `supabase`        |
| `<SUPABASE_PROFILE>` (YAML)                | YAML       | when `SUPABASE_PROFILE` is a filesystem path rather than a built-in name; a read failure aborts the command |

## Files Written

| Path                                                       | Format | When                                                                                         |
| ---------------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/notebooks/`                            | dir    | created if absent, before the first notebook is written                                      |
| `<workdir>/supabase/notebooks/.notebook-<random>/<random>` | JSON   | scoped temporary file; linked for creation or renamed for explicit replacement, then cleaned |
| `<workdir>/supabase/notebooks/<name>.json`                 | JSON   | only when absent during a broad pull, or replaced when its notebook id was explicitly given  |
| `<SUPABASE_HOME or ~/.supabase>/telemetry.json`            | JSON   | whenever the handler runs — flushed on success and on failure                                |

Files are **removed** only when the user picks the delete answer at the
reconciliation prompt: a local notebook naming no project notebook is deleted
from `supabase/notebooks/` and nowhere else.

A project notebook whose name cannot be a file name — one holding `/`, `\`, a
control character, or the name `.` / `..` — is skipped and counted on stderr,
not sanitised: a sanitised name would push back as a rename of somebody's
notebook. Nothing outside `supabase/notebooks/` is ever written.

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

| Method | Path                                | Auth   | Request body                    | Response (used fields)                                                |
| ------ | ----------------------------------- | ------ | ------------------------------- | --------------------------------------------------------------------- |
| GET    | `/v2/projects/{ref}/notebooks`      | Bearer | —                               | `data[].id`, `data[].attributes.name`, `links.next` — broad pull only |
| GET    | `/v2/projects/{ref}/notebooks/{id}` | Bearer | —                               | `data.{id,attributes.{name,description,favorite,content}}`            |
| POST   | `/v2/projects/{ref}/notebooks`      | Bearer | `data.attributes` from the file | — (only for the create answer)                                        |

The list route is walked by following `links.next` until it is null, rather than
by counting rows: a short page cannot be told from an exact multiple of the page
size.

## Exit Codes

| Code | Condition                                                                        |
| ---- | -------------------------------------------------------------------------------- |
| `0`  | success                                                                          |
| `1`  | no project ref — not linked and no `--project-ref`                               |
| `1`  | the supplied notebook id is not a UUID                                           |
| `1`  | the project holds two notebooks of one name during a broad pull                  |
| `1`  | the notebooks path exists but cannot be read as a directory                      |
| `1`  | an explicitly requested notebook name cannot be stored safely as a local file    |
| `1`  | a Management API call failed (transport, unexpected status, or undecodable body) |
| `1`  | a local file the user chose to create in the project is not a readable notebook  |
| `1`  | a local notebook file cannot be written                                          |
| `1`  | `-o env`, which cannot represent the payload                                     |

## Environment Variables

| Variable                | Purpose                                 | Required?                                              |
| ----------------------- | --------------------------------------- | ------------------------------------------------------ |
| `SUPABASE_ACCESS_TOKEN` | Management API bearer token             | no (falls back to the stored login)                    |
| `SUPABASE_PROFILE`      | built-in profile name or YAML file path | no (falls back to `~/.supabase/profile` -> `supabase`) |
| `SUPABASE_WORKDIR`      | project directory the command acts on   | no (falls back to `--workdir`, then the ancestor walk) |
| `SUPABASE_HOME`         | directory holding `telemetry.json`      | no (falls back to `~/.supabase`)                       |

## Telemetry Events Fired

| Event                  | When                                           | Notable properties / groups                        |
| ---------------------- | ---------------------------------------------- | -------------------------------------------------- |
| `cli_command_executed` | post-handler, success or failure (via wrapper) | `exit_code`, `duration_ms`, `flags`, project group |

`--project-ref` is marked telemetry-safe, so its value is recorded verbatim —
the same call `functions download` makes for the same flag. The notebook id
argument is not recorded.

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
