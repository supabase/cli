import type { ApiKeyResponse, V1CreateAProjectOutput } from "@supabase/api/effect";
import { describe, expect, it } from "vitest";

import { apiKeyValue, apiKeysToEnv } from "../../shared/legacy-api-keys.format.ts";
import {
  type LegacyLinkedProject,
  dashboardUrlForProfile,
  formatRegion,
  renderProjectApiKeysTable,
  renderProjectCreateTable,
  renderProjectsListTable,
} from "./projects.format.ts";
import { generateDbPassword } from "./projects.prompt.ts";

type ApiKey = typeof ApiKeyResponse.Type;
type CreatedProject = typeof V1CreateAProjectOutput.Type;

const PROJECT: LegacyLinkedProject = {
  id: "abcdefghijklmnopqrst",
  ref: "abcdefghijklmnopqrst",
  organization_id: "org-id",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: "db.example.com",
    version: "15",
    postgres_engine: "15",
    release_channel: "ga",
  },
  linked: false,
};

const CREATED: CreatedProject = {
  id: "abcdefghijklmnopqrst",
  ref: "abcdefghijklmnopqrst",
  organization_id: "org-id",
  organization_slug: "acme",
  name: "alpha",
  region: "eu-west-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "COMING_UP",
};

describe("formatRegion", () => {
  it("maps a known region code to its display name", () => {
    expect(formatRegion("us-east-1")).toBe("East US (North Virginia)");
    expect(formatRegion("ap-southeast-2")).toBe("Oceania (Sydney)");
  });

  it("passes an unknown region code through unchanged", () => {
    expect(formatRegion("mars-west-9")).toBe("mars-west-9");
  });
});

describe("dashboardUrlForProfile", () => {
  it("resolves the built-in profile dashboard URLs", () => {
    expect(dashboardUrlForProfile("supabase")).toBe("https://supabase.com/dashboard");
    expect(dashboardUrlForProfile("supabase-staging")).toBe("https://supabase.green/dashboard");
    expect(dashboardUrlForProfile("supabase-local")).toBe("http://localhost:8082");
  });

  it("defaults to the production dashboard for unknown profiles", () => {
    expect(dashboardUrlForProfile("/path/to/profile.yaml")).toBe("https://supabase.com/dashboard");
  });
});

describe("apiKeyValue / apiKeysToEnv", () => {
  it("masks a null or absent api key value", () => {
    expect(apiKeyValue(null)).toBe("******");
    expect(apiKeyValue(undefined)).toBe("******");
    expect(apiKeyValue("secret")).toBe("secret");
  });

  it("uppercases names and builds SUPABASE_<NAME>_KEY entries", () => {
    const keys: ReadonlyArray<ApiKey> = [
      { name: "anon", api_key: "anon-key" },
      { name: "service_role", api_key: null },
    ];
    expect(apiKeysToEnv(keys)).toEqual({
      SUPABASE_ANON_KEY: "anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "******",
    });
  });
});

describe("generateDbPassword", () => {
  it("produces a 16-character alphanumeric password with no colon", () => {
    const password = generateDbPassword();
    expect(password).toHaveLength(16);
    expect(password).toMatch(/^[a-zA-Z0-9]{16}$/);
    expect(password).not.toContain(":");
  });

  it("is non-deterministic across calls", () => {
    const a = generateDbPassword();
    const b = generateDbPassword();
    expect(a).not.toBe(b);
  });
});

describe("renderProjectsListTable", () => {
  it("renders all six columns and a bullet for the linked project", () => {
    const table = renderProjectsListTable([
      { ...PROJECT, linked: true },
      { ...PROJECT, id: "qrstuvwxyzabcdefghij", name: "beta", linked: false },
    ]);
    expect(table).toContain("LINKED");
    expect(table).toContain("ORG ID");
    expect(table).toContain("REFERENCE ID");
    expect(table).toContain("NAME");
    expect(table).toContain("REGION");
    expect(table).toContain("CREATED AT (UTC)");
    expect(table).toContain("●");
    expect(table).toContain("East US (North Virginia)");
    expect(table).toContain("2026-05-27 01:02:03");
    expect(table).toContain("abcdefghijklmnopqrst");
  });

  it("renders no bullet when nothing is linked", () => {
    const table = renderProjectsListTable([{ ...PROJECT, linked: false }]);
    expect(table).not.toContain("●");
  });
});

describe("renderProjectCreateTable", () => {
  it("renders the five create columns", () => {
    const table = renderProjectCreateTable(CREATED);
    expect(table).toContain("ORG ID");
    expect(table).toContain("REFERENCE ID");
    expect(table).toContain("NAME");
    expect(table).toContain("REGION");
    expect(table).toContain("CREATED AT (UTC)");
    expect(table).toContain("West EU (Ireland)");
    expect(table).not.toContain("LINKED");
  });
});

describe("renderProjectApiKeysTable", () => {
  it("renders the NAME / KEY VALUE columns and masks null keys", () => {
    const table = renderProjectApiKeysTable([
      { name: "anon", api_key: "anon-key" },
      { name: "service_role", api_key: null },
    ]);
    expect(table).toContain("NAME");
    expect(table).toContain("KEY VALUE");
    expect(table).toContain("anon-key");
    expect(table).toContain("******");
  });
});
