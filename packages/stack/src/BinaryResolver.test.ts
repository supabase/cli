import { describe, expect, it } from "@effect/vitest";
import { BinaryResolver } from "./BinaryResolver.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const postgresVersion = DEFAULT_VERSIONS.postgres;
const postgrestVersion = DEFAULT_VERSIONS.postgrest;
const authRcVersion = DEFAULT_VERSIONS.auth;

describe("BinaryResolver.downloadUrl", () => {
  it("constructs postgres URL (appends -cli suffix for native binaries)", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgres",
      version: postgresVersion,
      assetName: "darwin-arm64",
    });
    expect(url).toBe(
      `https://github.com/supabase/postgres/releases/download/v${postgresVersion}-cli/supabase-postgres-v${postgresVersion}-cli-darwin-arm64.tar.gz`,
    );
  });

  it("constructs postgrest URL", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgrest",
      version: postgrestVersion,
      assetName: "macos-aarch64",
    });
    expect(url).toBe(
      `https://github.com/PostgREST/postgrest/releases/download/v${postgrestVersion}/postgrest-v${postgrestVersion}-macos-aarch64.tar.xz`,
    );
  });

  it("constructs postgrest Windows URL with .zip extension", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgrest",
      version: postgrestVersion,
      assetName: "windows-x86-64",
    });
    expect(url).toBe(
      `https://github.com/PostgREST/postgrest/releases/download/v${postgrestVersion}/postgrest-v${postgrestVersion}-windows-x86-64.zip`,
    );
  });

  it("constructs auth URL for rc releases", () => {
    const url = BinaryResolver.downloadUrl({
      service: "auth",
      version: authRcVersion,
      assetName: "arm64",
    });
    expect(url).toBe(
      `https://github.com/supabase/auth/releases/download/rc${authRcVersion}/auth-v${authRcVersion}-arm64.tar.gz`,
    );
  });
});

describe("BinaryResolver.checksumUrl", () => {
  it("appends .sha256 for postgres", () => {
    const url = BinaryResolver.checksumUrl({
      service: "postgres",
      version: postgresVersion,
      assetName: "darwin-arm64",
    });
    expect(url).toBe(
      `https://github.com/supabase/postgres/releases/download/v${postgresVersion}-cli/supabase-postgres-v${postgresVersion}-cli-darwin-arm64.tar.gz.sha256`,
    );
  });

  it("returns null for postgrest (no checksum published)", () => {
    expect(
      BinaryResolver.checksumUrl({
        service: "postgrest",
        version: postgrestVersion,
        assetName: "macos-aarch64",
      }),
    ).toBeNull();
  });

  it("returns null for auth (no checksum published)", () => {
    expect(
      BinaryResolver.checksumUrl({
        service: "auth",
        version: authRcVersion,
        assetName: "arm64",
      }),
    ).toBeNull();
  });
});

describe("BinaryResolver.cachePath", () => {
  it("constructs cache path", () => {
    const path = BinaryResolver.cachePath("/home/user/.supabase/bin", {
      service: "postgres",
      version: postgresVersion,
      assetName: "darwin-arm64",
    });
    expect(path).toBe(`/home/user/.supabase/bin/postgres/${postgresVersion}/darwin-arm64`);
  });
});
