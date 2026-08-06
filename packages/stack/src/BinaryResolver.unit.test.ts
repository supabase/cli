import { describe, expect, it } from "@effect/vitest";
import { BinaryResolver } from "./BinaryResolver.ts";
import { nativeReleaseForService } from "./ServiceArtifacts.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

const postgresVersion = DEFAULT_VERSIONS.postgres;
const postgrestVersion = DEFAULT_VERSIONS.postgrest;
const authVersion = DEFAULT_VERSIONS.auth;
const authRcVersion = "2.188.0-rc.15";
const edgeRuntimeVersion = DEFAULT_VERSIONS["edge-runtime"];

describe("nativeReleaseForService", () => {
  it("constructs postgres URL (appends -cli suffix for native binaries)", () => {
    const release = nativeReleaseForService("postgres", postgresVersion, {
      os: "darwin",
      arch: "arm64",
    });
    expect(release?.downloadUrl).toBe(
      `https://github.com/supabase/postgres/releases/download/v${postgresVersion}-cli/supabase-postgres-v${postgresVersion}-cli-darwin-arm64.tar.gz`,
    );
    expect(release?.checksumUrl).toBe(`${release?.downloadUrl}.sha256`);
    expect(release?.stripComponents).toBe(true);
  });

  it("constructs postgrest URL", () => {
    const release = nativeReleaseForService("postgrest", postgrestVersion, {
      os: "darwin",
      arch: "arm64",
    });
    expect(release?.downloadUrl).toBe(
      `https://github.com/PostgREST/postgrest/releases/download/v${postgrestVersion}/postgrest-v${postgrestVersion}-macos-aarch64.tar.xz`,
    );
  });

  it("constructs postgrest Windows URL with .zip extension", () => {
    const release = nativeReleaseForService("postgrest", postgrestVersion, {
      os: "win32",
      arch: "x64",
    });
    expect(release?.downloadUrl).toBe(
      `https://github.com/PostgREST/postgrest/releases/download/v${postgrestVersion}/postgrest-v${postgrestVersion}-windows-x86-64.zip`,
    );
    expect(release?.archive).toBe("zip");
  });

  it("constructs auth URL for rc releases", () => {
    const release = nativeReleaseForService("auth", authRcVersion, {
      os: "linux",
      arch: "arm64",
    });
    expect(release?.downloadUrl).toBe(
      `https://github.com/supabase/auth/releases/download/rc${authRcVersion}/auth-v${authRcVersion}-arm64.tar.gz`,
    );
  });

  it("constructs edge-runtime URL", () => {
    const release = nativeReleaseForService("edge-runtime", edgeRuntimeVersion, {
      os: "darwin",
      arch: "arm64",
    });
    expect(release?.downloadUrl).toBe(
      `https://github.com/supabase/edge-runtime/releases/download/v${edgeRuntimeVersion}/edge-runtime-v${edgeRuntimeVersion}-aarch64-darwin.tar.gz`,
    );
  });

  it("returns no native release for unsupported platforms", () => {
    expect(
      nativeReleaseForService("auth", authVersion, { os: "win32", arch: "arm64" }),
    ).toBeUndefined();
  });
});

describe("BinaryResolver.cachePath", () => {
  it("constructs cache path", () => {
    const path = BinaryResolver.cachePath("/home/user/.supabase/bin", {
      service: "postgres",
      provider: "github.com/supabase/postgres",
      version: postgresVersion,
      assetName: "darwin-arm64",
    });
    expect(path).toBe(
      `/home/user/.supabase/bin/postgres/github.com_supabase_postgres/${postgresVersion}/darwin-arm64`,
    );
  });
});

describe("BinaryResolver.legacyExecutablePath", () => {
  it("recognizes the executable suffix used by Windows archives", () => {
    expect(BinaryResolver.legacyExecutablePath("C:/cache/postgrest", "postgrest", "win32")).toBe(
      "C:/cache/postgrest/postgrest.exe",
    );
  });

  it("keeps Unix executable names unchanged", () => {
    expect(BinaryResolver.legacyExecutablePath("/cache/postgrest", "postgrest", "linux")).toBe(
      "/cache/postgrest/postgrest",
    );
  });
});

describe("BinaryResolver.legacyCacheRequiredPaths", () => {
  it("requires the Postgres initialization payload as well as the executable", () => {
    expect(BinaryResolver.legacyCacheRequiredPaths("/cache/postgres", "postgres", "linux")).toEqual(
      [
        "/cache/postgres/bin/postgres",
        "/cache/postgres/bin/pg_isready",
        "/cache/postgres/bin/psql",
        "/cache/postgres/share/supabase-cli/bin/supabase-postgres-init.sh",
        "/cache/postgres/lib",
      ],
    );
  });
});
