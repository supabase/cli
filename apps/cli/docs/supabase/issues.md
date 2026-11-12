## supabase-issues

Checks a project for security, performance, and health issues. Findings are grouped by check, with every affected resource and its evidence preserved. Severities are `info`, `warning`, and `critical`, corresponding to the underlying INFO, WARN, and ERROR findings.

The default `--type all --severity info` displays every issue. Use `--fail-on warning` to exit with status 1 when a displayed issue is warning or critical. The severity filter applies before the exit threshold.

Inspects the local database by default. Use `--remote` for the linked project, or `--remote=<ref|branch|url>` for another target. Security and performance checks use a transaction that is always rolled back for local databases and direct database URLs. Health checks require a remote project: `--type health` rejects local and direct database targets, while `--type all` reports health coverage as unavailable for those targets.

By default, the command prints a table with severity, category, issue title, and the number of affected resources, followed by check coverage. Long titles wrap to fit the terminal. Narrow terminals show stacked fields when the table cannot fit. Unavailable checks include their reason and an incomplete-results warning. An empty result means no issues match the selected severity; it does not establish that the project is healthy.

Structured output contains `issues` and `checks`. Each issue includes its stable check ID, severity, category, documentation URL, and affected resources. Coverage reports each requested category as complete or unavailable. A remote check that cannot run is reported as unavailable and exits with status 1; it is never reported as a clean check.

`supabase db advisors` is deprecated. Its existing flags, defaults, output, and exit behavior remain supported.

Use `--output-format json` or `--output-format stream-json` for structured output. The legacy `-o` / `--output` flag is not supported by this command. Check IDs identify check types within a project; they are not persistent incident IDs.
