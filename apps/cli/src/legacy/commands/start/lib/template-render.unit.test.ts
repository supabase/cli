import { describe, expect, it } from "vitest";

import { LEGACY_START_KONG_YML_TEMPLATE } from "../templates/kong.yml.ts";
import { LEGACY_START_POOLER_EXS_TEMPLATE } from "../templates/pooler.exs.ts";
import { LEGACY_START_VECTOR_YAML_TEMPLATE } from "../templates/vector.yaml.ts";
import {
  legacyRenderGoTemplate,
  legacyRenderStartKongYml,
  legacyRenderStartPoolerExs,
  legacyRenderStartVectorYaml,
  type LegacyStartKongYmlFields,
  type LegacyStartPoolerExsFields,
  type LegacyStartVectorYamlFields,
} from "./template-render.ts";

const kongFields: LegacyStartKongYmlFields = {
  gotrueId: "supabase_auth_test",
  restId: "supabase_rest_test",
  realtimeId: "supabase_realtime_test",
  storageId: "supabase_storage_test",
  studioId: "supabase_studio_test",
  pgmetaId: "supabase_pg_meta_test",
  edgeRuntimeId: "supabase_edge_runtime_test",
  logflareId: "supabase_analytics_test",
  poolerId: "supabase_pooler_test",
  apiHost: "127.0.0.1",
  apiPort: 54321,
  bearerToken: "test-bearer-token",
  queryToken: "test-query-token",
};

const vectorFields: LegacyStartVectorYamlFields = {
  apiKey: "test-api-key",
  vectorId: "supabase_vector_test",
  logflareId: "supabase_analytics_test",
  kongId: "supabase_kong_test",
  gotrueId: "supabase_auth_test",
  restId: "supabase_rest_test",
  realtimeId: "supabase_realtime_test",
  storageId: "supabase_storage_test",
  edgeRuntimeId: "supabase_edge_runtime_test",
  dbId: "supabase_db_test",
};

const poolerFields: LegacyStartPoolerExsFields = {
  dbHost: "supabase_db_test",
  dbPort: 6543,
  dbDatabase: "postgres",
  dbPassword: "postgres",
  externalId: "supabase_pooler_test",
  modeType: "transaction",
  defaultMaxClients: 100,
  defaultPoolSize: 20,
};

describe("legacyRenderGoTemplate", () => {
  it("substitutes bare {{ .Field }} placeholders", () => {
    expect(legacyRenderGoTemplate("hello {{ .Name }}", { Name: "world" })).toBe("hello world");
  });

  it("tolerates any amount of whitespace inside the braces", () => {
    expect(legacyRenderGoTemplate("{{.Name}} {{  .Name  }} {{ .Name }}", { Name: "x" })).toBe(
      "x x x",
    );
  });

  it("renders numeric fields as base-10 strings with no added quotes or decimals", () => {
    expect(legacyRenderGoTemplate("port={{ .Port }}", { Port: 6543 })).toBe("port=6543");
  });

  it("throws when a referenced field is missing (missingkey=error parity)", () => {
    expect(() => legacyRenderGoTemplate("{{ .Missing }}", {})).toThrow(/\.Missing/);
  });

  it("does not error on struct fields that exist but are never referenced", () => {
    expect(legacyRenderGoTemplate("{{ .Used }}", { Used: "a", Unused: "b" })).toBe("a");
  });
});

describe("legacyRenderStartKongYml", () => {
  it("replaces every placeholder with no template syntax or missing-value markers left behind", () => {
    const rendered = legacyRenderStartKongYml(kongFields);
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
    expect(rendered).not.toContain("<no value>");
    expect(rendered).not.toContain("undefined");
  });

  it("interpolates each service upstream URL from the matching container id", () => {
    const rendered = legacyRenderStartKongYml(kongFields);
    expect(rendered).toContain("url: http://supabase_auth_test:9999/verify");
    expect(rendered).toContain("url: http://supabase_rest_test:3000/");
    expect(rendered).toContain("url: http://supabase_realtime_test:4000/socket");
    expect(rendered).toContain("url: http://supabase_storage_test:5000/s3");
    expect(rendered).toContain("url: http://supabase_edge_runtime_test:8081/");
    expect(rendered).toContain("url: http://supabase_pg_meta_test:8080/");
    expect(rendered).toContain("url: http://supabase_analytics_test:4000/");
    expect(rendered).toContain("url: http://supabase_pooler_test:4000/v2");
    expect(rendered).toContain("url: http://supabase_studio_test:3000/api/mcp");
  });

  it("interpolates the bearer and query tokens into every header/querystring reference", () => {
    const rendered = legacyRenderStartKongYml(kongFields);
    expect(rendered).toContain('"Authorization: test-bearer-token"');
    expect(rendered).toContain('"sb-api-key: test-bearer-token"');
    expect(rendered).toContain('"apikey:test-query-token"');
    expect(rendered.match(/test-bearer-token/g)).toHaveLength(
      (LEGACY_START_KONG_YML_TEMPLATE.match(/\{\{ \.BearerToken \}\}/g) ?? []).length,
    );
  });

  it("throws referencing the missing Go struct field when a placeholder has no value", () => {
    const { gotrueId: _gotrueId, ...withoutGotrue } = kongFields;
    const rawFields: Record<string, string | number> = {
      RestId: withoutGotrue.restId,
      RealtimeId: withoutGotrue.realtimeId,
      StorageId: withoutGotrue.storageId,
      StudioId: withoutGotrue.studioId,
      PgmetaId: withoutGotrue.pgmetaId,
      EdgeRuntimeId: withoutGotrue.edgeRuntimeId,
      LogflareId: withoutGotrue.logflareId,
      PoolerId: withoutGotrue.poolerId,
      ApiHost: withoutGotrue.apiHost,
      ApiPort: withoutGotrue.apiPort,
      BearerToken: withoutGotrue.bearerToken,
      QueryToken: withoutGotrue.queryToken,
    };
    expect(() => legacyRenderGoTemplate(LEGACY_START_KONG_YML_TEMPLATE, rawFields)).toThrow(
      /\.GotrueId/,
    );
  });
});

describe("legacyRenderStartVectorYaml", () => {
  it("replaces every placeholder with no template syntax or missing-value markers left behind", () => {
    const rendered = legacyRenderStartVectorYaml(vectorFields);
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain("}}");
    expect(rendered).not.toContain("<no value>");
    expect(rendered).not.toContain("undefined");
  });

  it("interpolates the vector, router, and logflare sink fields", () => {
    const rendered = legacyRenderStartVectorYaml(vectorFields);
    expect(rendered).toContain('- "supabase_vector_test"');
    expect(rendered).toContain("kong: '.appname == \"supabase_kong_test\"'");
    expect(rendered).toContain("auth: '.appname == \"supabase_auth_test\"'");
    expect(rendered).toContain("rest: '.appname == \"supabase_rest_test\"'");
    expect(rendered).toContain("realtime: '.appname == \"supabase_realtime_test\"'");
    expect(rendered).toContain("storage: '.appname == \"supabase_storage_test\"'");
    expect(rendered).toContain("functions: '.appname == \"supabase_edge_runtime_test\"'");
    expect(rendered).toContain("db: '.appname == \"supabase_db_test\"'");
    expect(rendered).toContain('x-api-key: "test-api-key"');
    expect(rendered).toContain(
      'uri: "http://supabase_analytics_test:4000/api/logs?source_name=gotrue.logs.prod"',
    );
  });

  it("throws referencing the missing Go struct field when a placeholder has no value", () => {
    const { apiKey: _apiKey, ...withoutApiKey } = vectorFields;
    const rawFields: Record<string, string | number> = {
      VectorId: withoutApiKey.vectorId,
      LogflareId: withoutApiKey.logflareId,
      KongId: withoutApiKey.kongId,
      GotrueId: withoutApiKey.gotrueId,
      RestId: withoutApiKey.restId,
      RealtimeId: withoutApiKey.realtimeId,
      StorageId: withoutApiKey.storageId,
      EdgeRuntimeId: withoutApiKey.edgeRuntimeId,
      DbId: withoutApiKey.dbId,
    };
    expect(() => legacyRenderGoTemplate(LEGACY_START_VECTOR_YAML_TEMPLATE, rawFields)).toThrow(
      /\.ApiKey/,
    );
  });
});

describe("legacyRenderStartPoolerExs", () => {
  it("renders the exact expected Elixir source", () => {
    expect(legacyRenderStartPoolerExs(poolerFields)).toBe(
      `{:ok, _} = Application.ensure_all_started(:supavisor)

{:ok, version} =
  case Supavisor.Repo.query!("select version()") do
    %{rows: [[ver]]} -> Supavisor.Helpers.parse_pg_version(ver)
    _ -> nil
  end

params = %{
  "external_id" => "supabase_pooler_test",
  "db_host" => "supabase_db_test",
  "db_port" => 6543,
  "db_database" => "postgres",
  "require_user" => false,
  "auth_query" => "SELECT * FROM pgbouncer.get_auth($1)",
  "default_max_clients" => 100,
  "default_pool_size" => 20,
  "default_parameter_status" => %{"server_version" => version},
  "users" => [%{
    "db_user" => "pgbouncer",
    "db_password" => "postgres",
    "mode_type" => "transaction",
    "pool_size" => 20,
    "is_manager" => true
  }]
}

if !Supavisor.Tenants.get_tenant_by_external_id(params["external_id"]) do
  {:ok, _} = Supavisor.Tenants.create_tenant(params)
end
`,
    );
  });

  it("renders numeric fields as bare Elixir integer literals with no quotes or decimals", () => {
    const rendered = legacyRenderStartPoolerExs(poolerFields);
    expect(rendered).toContain('"db_port" => 6543,');
    expect(rendered).toContain('"default_max_clients" => 100,');
    expect(rendered).toContain('"default_pool_size" => 20,');
    expect(rendered).toContain('"pool_size" => 20,');
    expect(rendered).not.toMatch(/"db_port" => "6543"/);
    expect(rendered).not.toMatch(/"db_port" => 6543\.0/);
  });

  it("throws referencing the missing Go struct field when a placeholder has no value", () => {
    const { dbHost: _dbHost, ...withoutDbHost } = poolerFields;
    const rawFields: Record<string, string | number> = {
      DbPort: withoutDbHost.dbPort,
      DbDatabase: withoutDbHost.dbDatabase,
      DbPassword: withoutDbHost.dbPassword,
      ExternalId: withoutDbHost.externalId,
      ModeType: withoutDbHost.modeType,
      DefaultMaxClients: withoutDbHost.defaultMaxClients,
      DefaultPoolSize: withoutDbHost.defaultPoolSize,
    };
    expect(() => legacyRenderGoTemplate(LEGACY_START_POOLER_EXS_TEMPLATE, rawFields)).toThrow(
      /\.DbHost/,
    );
  });
});
