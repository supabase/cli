# `supabase issues`

Target: selectable, no consent. Local database lint transactions always roll back.

## Files and environment

Uses the same configuration, connection, credentials, target resolution, linked-project cache, and telemetry files and environment as [db advisors](../db/advisors/SIDE_EFFECTS.md). No issue lifecycle state is persisted.

## API routes

Remote security and performance use `GET /v1/projects/{ref}/advisors/security` and `GET /v1/projects/{ref}/advisors/performance`. Health uses `POST /v2/projects/{ref}/advisors/run` with `data.type=project_advisors` and `data.attributes.lints` containing the four `log_{data_api,auth,storage,edge_function}_error_rate_high` names. Target resolution may fetch project and branch metadata. Linked cache and telemetry finalizers run on success and failure.

## Output and exits

Text prints a JSON object; machine modes put `{ issues, checks }` in the standard success result. Issues group by lint name, retain affected evidence, and sort by decreasing severity then ID. Severity defaults to info. Type defaults to all. Fail-on defaults to none and applies only to displayed issues. Exit 1 indicates an error, a matching fail-on threshold, or unavailable remote check coverage. Local all reports unavailable health coverage without failing. Explicit local or direct-database health is an unsupported-target error. Authentication, transport, and API failures remain errors.

`-o` / `--output` is rejected with guidance to use `--output-format json|stream-json`. Check IDs are project-scoped check identifiers, not persisted incidents.
