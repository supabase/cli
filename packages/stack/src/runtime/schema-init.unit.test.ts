import { describe, expect, it } from "@effect/vitest";
import { serializeCommonContainerCommand } from "./ContainerEngine.ts";
import { StackIdSchema } from "../public/StackId.ts";
import {
  parseSchemaInitDatabaseUrl,
  rewriteDatabaseEnvironment,
  schemaInitArtifactIdentity,
  schemaInitHostGatewayExtraHosts,
} from "./SchemaInit.ts";

describe("parseSchemaInitDatabaseUrl", () => {
  it("keeps user, database name, host, port, and password", () => {
    const parsed = parseSchemaInitDatabaseUrl(
      "postgresql://supabase_auth_admin:s3cret%40x@127.0.0.1:54322/_supabase",
    );
    expect(parsed).toEqual({
      host: "127.0.0.1",
      port: 54322,
      password: "s3cret@x",
      database: "_supabase",
    });
  });

  it("rejects a non-postgres URL", () => {
    expect(parseSchemaInitDatabaseUrl("https://example.test/postgres")).toBeUndefined();
  });
});

describe("rewriteDatabaseEnvironment", () => {
  it("rewrites host, port, and password without changing user or database name", () => {
    const rewritten = rewriteDatabaseEnvironment(
      {
        DB_HOST: "supabase-database",
        DB_PORT: "5432",
        DB_PASSWORD: "old",
        GOTRUE_DB_DATABASE_URL:
          "postgresql://supabase_auth_admin:old@supabase-database:5432/postgres",
        DATABASE_URL: "ecto://supabase_admin:old@supabase-database:5432/_supabase",
        API_EXTERNAL_URL: "http://127.0.0.1:54321",
      },
      { host: "host.docker.internal", port: 54322, password: "fresh" },
    );
    expect(rewritten.DB_HOST).toBe("host.docker.internal");
    expect(rewritten.DB_PORT).toBe("54322");
    expect(rewritten.DB_PASSWORD).toBe("fresh");
    expect(rewritten.GOTRUE_DB_DATABASE_URL).toBe(
      "postgresql://supabase_auth_admin:fresh@host.docker.internal:54322/postgres",
    );
    expect(rewritten.DATABASE_URL).toBe(
      "ecto://supabase_admin:fresh@host.docker.internal:54322/_supabase",
    );
    expect(rewritten.API_EXTERNAL_URL).toBe("http://127.0.0.1:54321");
  });
});

describe("schemaInitHostGatewayExtraHosts", () => {
  it("adds host-gateway only on Linux Engine for host.docker.internal", () => {
    expect(schemaInitHostGatewayExtraHosts("linux", "host.docker.internal")).toEqual([
      "host.docker.internal:host-gateway",
    ]);
    expect(schemaInitHostGatewayExtraHosts("darwin", "host.docker.internal")).toEqual([]);
    expect(schemaInitHostGatewayExtraHosts("linux", "127.0.0.1")).toEqual([]);
  });
});

describe("schemaInitArtifactIdentity", () => {
  it("returns a version:image pin and rejects unknown releases", () => {
    const identity = schemaInitArtifactIdentity("auth");
    expect(identity).toMatch(/^v.+:/);
    expect(schemaInitArtifactIdentity("auth", "not-a-catalog-release")).toBeUndefined();
  });
});

describe("serializeCommonContainerCommand extra hosts", () => {
  it("emits --add-host after the network flags", () => {
    const request = serializeCommonContainerCommand({
      operation: "create-container",
      spec: {
        name: "schema-init",
        image: "example/auth:1",
        labels: {
          stackId: StackIdSchema.make("a".repeat(64)),
          ownerSessionId: "owner",
          workloadId: "auth:auth",
          startup: true,
          role: "workload",
        },
        network: "net",
        mounts: [],
        volumeMounts: [],
        publications: [],
        role: "workload",
        extraHosts: ["host.docker.internal:host-gateway"],
      },
    });
    const networkIndex = request.args.indexOf("--network");
    const addHostIndex = request.args.indexOf("--add-host");
    expect(networkIndex).toBeGreaterThan(-1);
    expect(addHostIndex).toBeGreaterThan(networkIndex);
    expect(request.args[addHostIndex + 1]).toBe("host.docker.internal:host-gateway");
  });
});
