import { describe, expect, it } from "vitest";
import { DEFAULT_VERSIONS, dockerImageForService } from "./versions.ts";

describe("DEFAULT_VERSIONS", () => {
  it("has all required services", () => {
    expect(DEFAULT_VERSIONS).toHaveProperty("postgres");
    expect(DEFAULT_VERSIONS).toHaveProperty("postgrest");
    expect(DEFAULT_VERSIONS).toHaveProperty("auth");
  });

  it("versions are non-empty strings", () => {
    expect(typeof DEFAULT_VERSIONS.postgres).toBe("string");
    expect(DEFAULT_VERSIONS.postgres.length).toBeGreaterThan(0);
    expect(typeof DEFAULT_VERSIONS.postgrest).toBe("string");
    expect(DEFAULT_VERSIONS.postgrest.length).toBeGreaterThan(0);
    expect(typeof DEFAULT_VERSIONS.auth).toBe("string");
    expect(DEFAULT_VERSIONS.auth.length).toBeGreaterThan(0);
  });
});

describe("dockerImageForService", () => {
  it("returns correct image for postgres", () => {
    expect(dockerImageForService("postgres", "17.6.1.090")).toBe(
      "public.ecr.aws/supabase/postgres:17.6.1.090",
    );
  });

  it("returns correct image for postgrest (with v prefix)", () => {
    expect(dockerImageForService("postgrest", "14.5")).toBe(
      "public.ecr.aws/supabase/postgrest:v14.5",
    );
  });

  it("returns correct image for auth (with v prefix)", () => {
    expect(dockerImageForService("auth", "2.187.0")).toBe(
      "public.ecr.aws/supabase/gotrue:v2.187.0",
    );
  });
});
