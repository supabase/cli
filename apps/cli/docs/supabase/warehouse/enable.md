# supabase-warehouse-enable

Enable Warehouse replication for the currently eligible tables in `--schema`, or select one table with `--table`. Schema selection includes only the eligible tables that exist when you run this command. Tables created later are not replicated automatically; add them to Warehouse replication separately. A partitioned table keeps its logical table identity and includes its current and future partitions.

The command resolves the hosted project, prints the selected tables, and asks for confirmation with a default answer of no. Pass `--remote=<ref|branch>` to select a project or branch; otherwise it uses the linked project. Scripts and machine output require `--yes` or `SUPABASE_YES` in the shell.

The confirmed selection includes PostgreSQL table identities. If the selection changes before setup, enablement fails and you must run the command again to review it. Retrying the same selection is safe. An enabled Warehouse with a different selection is rejected: change its replication selection separately rather than replacing it through enablement.

Without `--wait`, success means the API accepted setup. With `--wait`, the command waits for routing readiness, a running pipeline, and initial-copy completion for every selected table. It reports initial synchronization and replication state separately. Query connectivity is not tested. Missing table observations never count as completion.

`--timeout` defaults to `15m` and bounds the wait after setup is accepted. A timeout does not cancel setup; rerun the same command with `--wait` to continue waiting. Use `--output-format json` or `--output-format stream-json` for structured results. Selection and progress stay on stderr. The legacy `-o`/`--output` flag is unsupported.

This command uses the managed Warehouse destination and placement defaults. It does not install the Warehouse FDW.
