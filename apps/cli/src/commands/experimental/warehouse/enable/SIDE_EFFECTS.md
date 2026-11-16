# warehouse enable

The command is generated from the Management API OpenAPI document and its `x-cli`
metadata. It requires both `experimental.warehouse = true` in local config (or
`SUPABASE_EXPERIMENTAL_WAREHOUSE=1`) and `--experimental` (or `SUPABASE_EXPERIMENTAL=1`).
Shell feature configuration overrides the project setting; neither opt-in writes config.

## Inputs and hosted effects

`--schema` is required. Repeat `--table` to select literal table names; omit it to
select the schema's currently eligible tables. `--warehouse-region`,
`--destination-project-ref`, and `--install-fdw` map to the API's optional settings.
`--remote` and `--project-ref` use the shared hosted-project resolver.
Hosted consent is required before mutation (`--yes` or shell `SUPABASE_YES` for
noninteractive runs). There is no preview or dry run.

| Method                  | Path                                          | Body / query                                                                                                          |
| ----------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| POST                    | `/v2/projects/{ref}/warehouse/enable`         | `{data:{type:"warehouse_setup",attributes:{schema,tables?,warehouse_region?,destination_project_ref?,install_fdw?}}}` |
| GET, only with `--wait` | `/v2/projects/{ref}/warehouse/setups/current` | `selection_id` from the accepted response; the API skips FDW inspection by default for this query                     |

`--wait` polls every two seconds until the API reports `succeeded` or `failed`.
`--timeout` defaults to `15m`. Failure surfaces `status_error`; selection conflicts
remain API errors. Timeout and interruption stop polling without cancelling remote work.
No local selection, readiness, or table-identity logic duplicates the API.

## Local state, authentication, and output

Authentication, profile/API URL selection, project resolution, debug HTTP logging,
identity stitching, linked-project caching, and command telemetry use shared services.
The linked-project cache and telemetry flush run on success and failure after resolution;
a closed experimental gate performs neither write. Token values are never printed.

Success writes the raw acceptance response, or the final status response with `--wait`.
Output defaults to JSON without a terminal and YAML on a terminal. `-o json|yaml`
overrides `--output-format`; `--output-format json` is supported and `stream-json`
is rejected. API errors are JSON on stderr with HTTP status, API code, and a hint.
Existing targeting/progress diagnostics remain on stderr. Exit codes are 0 on success,
1 for API/network/wait failure, 2 for generated input/consent/experimental-gate errors,
and the CLI's existing interruption exit code on cancellation.

This opt-in command is excluded from the stable generated command reference.
