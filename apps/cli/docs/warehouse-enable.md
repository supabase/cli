# Warehouse enable

`warehouse enable` uses the [generated API command framework](generated-api-commands.md).

The API snapshot currently uses the staging source in `packages/api/scripts/openapi-source.json`
because the new enable operation is not yet in the production schema. The sync workflow
honors that pin. Switch the pin back to production and regenerate once the endpoint
is promoted; the pin controls generation, not the CLI's runtime API URL.

## Try Warehouse

Use a personal access token and a project on the selected platform. The project
must have Warehouse available and the account must have the required permissions.

```sh
export SUPABASE_EXPERIMENTAL_WAREHOUSE=1
export SUPABASE_PROFILE=supabase-staging
# Supply SUPABASE_ACCESS_TOKEN or log in with the selected profile.
pnpm --dir apps/cli dev warehouse enable \
  --remote=abcdefghijklmnopqrst \
  --schema public --table orders \
  --wait --timeout 15m --experimental --yes
```

Repeat `--table` for multiple literal names; omit it to select the currently eligible
tables in the schema. `--warehouse-region`, `--destination-project-ref`, and
`--install-fdw` expose the API's setup options. Without `--wait`, success means the
API accepted setup, not that replication is ready.

The family gate can also be set with `[experimental] warehouse = true` in local
config. Shell `SUPABASE_EXPERIMENTAL_WAREHOUSE` overrides it. This is independent
of the execution gate, `--experimental` or shell `SUPABASE_EXPERIMENTAL=1`.
