# `supabase pull`

Composes config pull, pg-delta declarative db pull, all-function download, and
secrets list. Uses existing APIs and handlers; no new endpoints.

Before building the component runtimes, checks for `supabase/` in the current
directory (or `--workdir` / `SUPABASE_WORKDIR`, with the flag taking precedence).
Reuses a config in that directory. If the directory has no `supabase/` and no
explicit workdir, discovers the nearest project using the existing config path
finder and reuses it when `.temp/project-ref` contains a valid ref. An unlinked
parent (including one with only a metadata cache) does not prevent initialization
in the current directory. A linked directory with missing config is initialized
without deleting the link. Existing empty, unlinked `supabase/` directories keep
normal lookup behavior. All component runtimes receive the discovered project
root. The scaffold remains if later runtime setup fails.

## Files Read

- `<workdir>/supabase/config.json` or `config.toml`, including remote overlays,
  dotenv references and pg-delta settings, following config pull and db pull.
- `<workdir>/supabase/.env`, `.env.local`, and the existing database command's
  environment/config inputs.
- `<workdir>/supabase/.temp/project-ref` and linked-project cache for project
  selection when `--project-ref` and `SUPABASE_PROJECT_ID` are absent.
- Git status for an existing config before changing it, unless `--force`.
- Existing credential/profile files and keyring through the standard runtime.

The detailed component contracts remain authoritative:
[config pull](../config/pull/SIDE_EFFECTS.md),
[db pull](../db/pull/SIDE_EFFECTS.md) (declarative mode only),
[functions download](../functions/download/SIDE_EFFECTS.md), and
[secrets list](../secrets/list/SIDE_EFFECTS.md). Optional linking follows
[link](../link/SIDE_EFFECTS.md), including service-version probes and metadata.

## Files Written

| Path                                                        | Format                                            | When                                                                                                                                        |
| ----------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `<workdir>/supabase/config.toml`, `supabase/.gitignore`     | TOML, text                                        | Standard init scaffold when neither config format exists; existing configs are retained                                                     |
| `<workdir>/supabase/config.{toml,json}`                     | Existing format                                   | Remote config edits after confirmation; db pull may update schema paths                                                                     |
| `<workdir>/supabase/schemas/**`                             | SQL and `.pgdelta-export.json` ownership metadata | Declarative export; honors the configured declarative directory and existing managed-file replacement rules                                 |
| `<workdir>/supabase/functions/**`                           | Function source                                   | Downloads every deployed function with the existing downloader                                                                              |
| `<workdir>/supabase/functions/.env.example`                 | dotenv template                                   | After all preceding steps succeed; replaces the example with sorted secret names and empty values, including a header when no secrets exist |
| `<workdir>/supabase/.temp/**`, `~/.supabase/telemetry.json` | Existing cache formats                            | Standard component caches and telemetry; `SUPABASE_HOME` relocates home state                                                               |

No migration files or remote migration-history entries are created. Existing
function files absent from the remote deployment are not deleted. Actual local
`.env` files are not overwritten. Newly initialized config bypasses the git dirty
guard for this invocation; existing config requires `--force` to bypass it.

After export, an optional link step writes `supabase/.temp/project-ref`, service
version/pooler files, and linked-project metadata using the existing link
workflow. A matching link is left alone. Otherwise, a confirmation asks to link
the folder (or replace its existing link). `--link` selects linking explicitly;
`--link=false` skips it even with `--yes`. An omitted choice prompts in text mode,
defaults to no, and is accepted by `--yes` / `SUPABASE_YES`. Machine modes without
an affirmative flag skip linking. Declining preserves existing link state and
does not cancel the export. A link failure fails the command after export.

## API Routes

All Management API requests use the existing profile and bearer credentials.

| Method | Path                                       | Request body | Used response                                                         |
| ------ | ------------------------------------------ | ------------ | --------------------------------------------------------------------- |
| GET    | `/v2/projects/{ref}/config`                | none         | Project configuration attributes                                      |
| GET    | `/v1/projects/{ref}/functions`             | none         | Function slugs and metadata                                           |
| GET    | `/v1/projects/{ref}/functions/{slug}/body` | none         | Function bundle or multipart source                                   |
| GET    | `/v1/projects/{ref}/functions/{slug}`      | none         | Entrypoint metadata when absent from bundle                           |
| GET    | `/v1/projects/{ref}/secrets`               | none         | Secret names; digests are never written to the example or pull result |
| GET    | `/v1/projects/{ref}`                       | none         | Standard linked-project metadata cache                                |

Project selection, linked database credential resolution, pooler fallback and
Docker image acquisition retain the component contracts above. Database schema
introspection uses the existing pg-delta engine; no project data export occurs.
If linking is accepted, also uses link's existing project API-key, storage config,
pooler config, and tenant REST/Auth/Storage version routes. No new endpoints.

## Environment Variables

- `SUPABASE_ACCESS_TOKEN`, `SUPABASE_PROFILE`, `SUPABASE_HOME`: existing auth/profile/state resolution.
- `SUPABASE_PROJECT_ID`: project-ref fallback.
- `SUPABASE_WORKDIR`: destination project directory, also selectable with `--workdir`.
- `SUPABASE_DB_PASSWORD`: linked database password fallback; `--password` wins.
- `SUPABASE_YES`: config and link confirmations, also selectable with `--yes`.
- Existing db pull variables, including `PGDELTA_DEBUG`, and functions download's
  Docker/registry variables retain their existing meanings.

## Exit Codes

- `0`: all steps complete, or the user declines config confirmation (later steps skipped).
- `1`: unsupported `-o/--output`, invalid workdir/ref/config, dirty config refusal,
  authentication/API/database/filesystem failure, invalid dotenv secret name,
  or pg-delta coverage failure with `--strict-coverage`.

Steps execute sequentially and stop on the first failure. Completed writes remain
on disk and no overall success is emitted after failure. Retrying reuses the
existing component update behavior; this is not an atomic project snapshot.

## Telemetry Events Fired

One `cli_command_executed` event for `pull`, through `withCommandTelemetry`.
Project refs and boolean flags follow the normal telemetry policy; passwords are
redacted. Existing cache/telemetry finalizers run on success and failure.
Successful linking retains link's `cli_project_linked` and group-identification
events; it does not emit a separate `cli_command_executed` event or duplicate
the composition's cache/telemetry finalizers.

## Output

Text mode retains each component's progress, config diff/confirmation and
warnings, then prints `Project pulled into supabase/.` on success.

JSON emits one success envelope containing `project_ref`, absolute `directory`,
component `config`, `database`, and `functions` results, `linked` indicating a
link to the pulled project, an optional `link` result, and `secrets` containing
`names` and the absolute `env_example` path. Stream JSON retains progress/log
frames and emits one final result. Declining config emits `declined: true` and
no database/functions/secrets result. All `-o/--output` values are rejected with
an instruction to use `--output-format`.
