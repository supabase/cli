import { describe, expect, it } from "@effect/vitest";
import { BinaryResolver } from "./BinaryResolver.ts";
import { nativeReleaseForService } from "./ServiceCatalog.ts";
import { DEFAULT_VERSIONS } from "./versions.ts";

describe("slim native release descriptors", () => {
  it("formats the slim-services archive, manifest, and checksum names", () => {
    const release = nativeReleaseForService("postgrest", "v16.1", {
      os: "darwin",
      arch: "arm64",
    });
    expect(release).toMatchObject({
      releaseTag: "postgrest-v16.1",
      target: "darwin-arm64",
      archive: "tar.zst",
      downloadUrl:
        "https://github.com/supabase/slim-services/releases/download/postgrest-v16.1/postgrest-v16.1-darwin-arm64.tar.zst",
      manifestUrl:
        "https://github.com/supabase/slim-services/releases/download/postgrest-v16.1/postgrest-v16.1-darwin-arm64.manifest.json",
      checksumUrl:
        "https://github.com/supabase/slim-services/releases/download/postgrest-v16.1/SHA256SUMS",
    });
  });

  it("only exposes the three supported native targets", () => {
    expect(
      nativeReleaseForService("auth", DEFAULT_VERSIONS.auth, { os: "win32", arch: "x64" }),
    ).toBeUndefined();
    expect(
      nativeReleaseForService("auth", DEFAULT_VERSIONS.auth, { os: "linux", arch: "x64" })?.target,
    ).toBe("linux-amd64");
  });
});

describe("BinaryResolver.cachePath", () => {
  it("includes service, release provider, version, and target identity", () => {
    const path = BinaryResolver.cachePath("/home/user/.supabase/bin", {
      service: "postgres",
      releaseSet: "slim-services",
      version: DEFAULT_VERSIONS.postgres,
      runtime: "native",
      target: "linux-amd64",
    });
    expect(path).toBe(
      `/home/user/.supabase/bin/slim-services/postgres/${DEFAULT_VERSIONS.postgres}/native/linux-amd64`,
    );
  });
});
