/**
 * Transcribed verbatim from the former `apps/cli-go/internal/start/templates/pooler.exs`
 * (Go `//go:embed templates/pooler.exs`, parsed as a `text/template` named
 * `poolerTenant`, `apps/cli-go/internal/start/start.go:155-158`). `internal/start`
 * (including this template) was deleted outright as unreachable from the TS CLI
 * (CLI-1966); the last commit with it intact is a253ccba25c21356ccd33044c4474aecb77d1ae4
 * (https://github.com/supabase/cli/blob/a253ccba25c21356ccd33044c4474aecb77d1ae4/apps/cli-go/internal/start/templates/pooler.exs).
 * Do not hand-edit the Elixir body — this is now the sole source of truth.
 *
 * Placeholders (`{{ .Field }}`) were Go's `poolerTenant` struct fields
 * (`start.go:144-153`): DbHost, DbPort, DbDatabase, DbPassword, ExternalId,
 * ModeType, DefaultMaxClients, DefaultPoolSize. Rendered by
 * `lib/template-render.ts`.
 */
export const LEGACY_START_POOLER_EXS_TEMPLATE = `{:ok, _} = Application.ensure_all_started(:supavisor)

{:ok, version} =
  case Supavisor.Repo.query!("select version()") do
    %{rows: [[ver]]} -> Supavisor.Helpers.parse_pg_version(ver)
    _ -> nil
  end

params = %{
  "external_id" => "{{ .ExternalId }}",
  "db_host" => "{{ .DbHost }}",
  "db_port" => {{ .DbPort }},
  "db_database" => "{{ .DbDatabase }}",
  "require_user" => false,
  "auth_query" => "SELECT * FROM pgbouncer.get_auth($1)",
  "default_max_clients" => {{ .DefaultMaxClients }},
  "default_pool_size" => {{ .DefaultPoolSize }},
  "default_parameter_status" => %{"server_version" => version},
  "users" => [%{
    "db_user" => "pgbouncer",
    "db_password" => "{{ .DbPassword }}",
    "mode_type" => "{{ .ModeType }}",
    "pool_size" => {{ .DefaultPoolSize }},
    "is_manager" => true
  }]
}

if !Supavisor.Tenants.get_tenant_by_external_id(params["external_id"]) do
  {:ok, _} = Supavisor.Tenants.create_tenant(params)
end
`;
