## supabase-issues

Checks a project for security, performance, and health issues. Findings are grouped by check, with every affected resource and its evidence preserved. Severities are `info`, `warning`, and `critical`, corresponding to the underlying INFO, WARN, and ERROR findings.

The default `--type all --severity info` displays every issue. Use `--fail-on warning` to exit with status 1 when a displayed issue is warning or critical. The severity filter applies before the exit threshold.

Inspects the local database by default. Use `--remote` for the linked project, or `--remote=<ref|branch|url>` for another target. Security and performance checks use a transaction that is always rolled back for local databases and direct database URLs. Health checks require a remote project: `--type health` rejects local and direct database targets, while `--type all` reports health coverage as unavailable for those targets.

Remote health coverage consists of four elevated error-rate checks: Data API (`log_data_api_error_rate_high`), Auth (`log_auth_error_rate_high`), Storage (`log_storage_error_rate_high`), and Edge Functions (`log_edge_function_error_rate_high`). It does not cover database CPU, memory, disk, connection saturation, or other project health signals. Complete health coverage means these four checks ran successfully.

By default, the command prints a table with severity, category, issue title, and the number of affected resources, followed by check coverage. Long titles wrap to fit the terminal. Narrow terminals show stacked fields when the table cannot fit. Unavailable checks include their reason and an incomplete-results warning. An empty result means no issues match the selected severity; it does not establish that the project is healthy.

Structured output contains `issues` and `checks`. Each issue includes its stable check ID, severity, category, documentation URL, and affected resources. Coverage reports each requested category as complete or unavailable. Remote categories run concurrently. A category that fails due to an API, network, or response-decoding error is reported as unavailable, preserves findings from successful categories, and exits with status 1. Missing or invalid local credentials fail before checks run. Authentication or authorization failures (HTTP 401 or 403) are fatal and do not produce partial results. An unavailable category is never reported as a clean check.

`supabase db advisors` is planned for deprecation in a future release and remains available alongside `supabase issues`. Its existing flags, defaults, output, and exit behavior remain supported.

Use `--output-format json` or `--output-format stream-json` for structured output. The legacy `-o` / `--output` flag is not supported by this command. Check IDs identify check types within a project; they are not persistent incident IDs.
