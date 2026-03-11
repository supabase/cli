import { describe, expect, it } from "@effect/vitest";
import { BinaryResolver } from "./BinaryResolver.ts";

describe("BinaryResolver.downloadUrl", () => {
  it("constructs postgres URL (appends -cli suffix for native binaries)", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgres",
      version: "17.6.1.081",
      assetName: "darwin-arm64",
    });
    expect(url).toBe(
      "https://github.com/supabase/postgres/releases/download/v17.6.1.081-cli/supabase-postgres-v17.6.1.081-cli-darwin-arm64.tar.gz",
    );
  });

  it("constructs postgrest URL", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgrest",
      version: "14.5",
      assetName: "macos-aarch64",
    });
    expect(url).toBe(
      "https://github.com/PostgREST/postgrest/releases/download/v14.5/postgrest-v14.5-macos-aarch64.tar.xz",
    );
  });

  it("constructs postgrest Windows URL with .zip extension", () => {
    const url = BinaryResolver.downloadUrl({
      service: "postgrest",
      version: "14.5",
      assetName: "windows-x86-64",
    });
    expect(url).toBe(
      "https://github.com/PostgREST/postgrest/releases/download/v14.5/postgrest-v14.5-windows-x86-64.zip",
    );
  });

  it("constructs auth URL", () => {
    const url = BinaryResolver.downloadUrl({
      service: "auth",
      version: "2.187.0",
      assetName: "arm64",
    });
    expect(url).toBe(
      "https://github.com/supabase/auth/releases/download/v2.187.0/auth-v2.187.0-arm64.tar.gz",
    );
  });
});

describe("BinaryResolver.checksumUrl", () => {
  it("appends .sha256 for postgres", () => {
    const url = BinaryResolver.checksumUrl({
      service: "postgres",
      version: "17.6.1.081",
      assetName: "darwin-arm64",
    });
    expect(url).toBe(
      "https://github.com/supabase/postgres/releases/download/v17.6.1.081-cli/supabase-postgres-v17.6.1.081-cli-darwin-arm64.tar.gz.sha256",
    );
  });

  it("returns null for postgrest (no checksum published)", () => {
    expect(
      BinaryResolver.checksumUrl({
        service: "postgrest",
        version: "14.5",
        assetName: "macos-aarch64",
      }),
    ).toBeNull();
  });

  it("returns null for auth (no checksum published)", () => {
    expect(
      BinaryResolver.checksumUrl({
        service: "auth",
        version: "2.187.0",
        assetName: "arm64",
      }),
    ).toBeNull();
  });
});

describe("BinaryResolver.cachePath", () => {
  it("constructs cache path", () => {
    const path = BinaryResolver.cachePath("/home/user/.supabase/bin", {
      service: "postgres",
      version: "17.6.1.081",
      assetName: "darwin-arm64",
    });
    expect(path).toBe("/home/user/.supabase/bin/postgres/17.6.1.081/darwin-arm64");
  });
});
