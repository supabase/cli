import { describe, expect, it } from "@effect/vitest";
import {
  detectArtifactHostHint,
  isSlimCatalogImage,
  nativeArtifactCandidates,
  rewriteSlimImageHost,
  slimImagePullCandidates,
} from "./SlimArtifactMirrors.ts";

const PINNED =
  "ghcr.io/supabase/cli/postgres:17.6.1.168@sha256:936536bb1f97bcab0e30f58613545f8a75676c185c5eb5b86d8f8b33ca3063a1";
const ECR_PINNED =
  "public.ecr.aws/supabase/cli/postgres:17.6.1.168@sha256:936536bb1f97bcab0e30f58613545f8a75676c185c5eb5b86d8f8b33ca3063a1";

const githubUrls = {
  service: "postgrest",
  version: "v16.2",
  target: "linux-arm64",
  downloadUrl:
    "https://github.com/supabase/slim-services/releases/download/postgrest-v16.2/postgrest-v16.2-linux-arm64.tar.zst",
  manifestUrl:
    "https://github.com/supabase/slim-services/releases/download/postgrest-v16.2/postgrest-v16.2-linux-arm64.manifest.json",
  checksumUrl:
    "https://github.com/supabase/slim-services/releases/download/postgrest-v16.2/SHA256SUMS",
};

describe("SlimArtifactMirrors", () => {
  it("detects well-known sandbox markers", () => {
    expect(detectArtifactHostHint({})).toBe("default");
    expect(detectArtifactHostHint({ CLAUDE_CODE_REMOTE: "1" })).toBe("claude");
    expect(detectArtifactHostHint({ CLAUDECODE: "1" })).toBe("claude");
    expect(detectArtifactHostHint({ CODEX_SANDBOX: "seatbelt" })).toBe("codex");
    expect(detectArtifactHostHint({ CURSOR_AGENT: "1" })).toBe("cursor");
  });

  it("swaps slim hosts without dropping a digest pin", () => {
    expect(rewriteSlimImageHost(PINNED, "public.ecr.aws/supabase/cli/")).toBe(ECR_PINNED);
    expect(rewriteSlimImageHost(ECR_PINNED, "ghcr.io/supabase/cli/")).toBe(PINNED);
    expect(isSlimCatalogImage(ECR_PINNED)).toBe(true);
    expect(isSlimCatalogImage("ghcr.io/supabase/postgres:17.6")).toBe(false);
  });

  it("defaults slim image pulls to ECR then GHCR", () => {
    expect(slimImagePullCandidates(PINNED, { env: {} })).toEqual([ECR_PINNED, PINNED]);
    expect(slimImagePullCandidates(PINNED, { env: { CLAUDE_CODE_REMOTE: "1" } })).toEqual([
      ECR_PINNED,
      PINNED,
    ]);
  });

  it("prefers GHCR for Codex and Cursor image pulls", () => {
    expect(slimImagePullCandidates(PINNED, { env: { CURSOR_AGENT: "1" } })).toEqual([
      PINNED,
      ECR_PINNED,
    ]);
    expect(slimImagePullCandidates(PINNED, { env: { CODEX_CI: "1" } })).toEqual([
      PINNED,
      ECR_PINNED,
    ]);
  });

  it("treats SUPABASE_INTERNAL_IMAGE_REGISTRY as a hard override", () => {
    expect(
      slimImagePullCandidates(PINNED, { env: {}, registryOverride: "public.ecr.aws" }),
    ).toEqual([ECR_PINNED]);
    expect(slimImagePullCandidates(PINNED, { env: {}, registryOverride: "ghcr.io" })).toEqual([
      PINNED,
    ]);
    expect(
      slimImagePullCandidates(PINNED, { env: {}, registryOverride: "my.mirror.example" }),
    ).toEqual([
      "my.mirror.example/supabase/cli/postgres:17.6.1.168@sha256:936536bb1f97bcab0e30f58613545f8a75676c185c5eb5b86d8f8b33ca3063a1",
    ]);
  });

  it("leaves non-slim images as a single candidate", () => {
    expect(slimImagePullCandidates("supabase/pg_prove:3.36", { env: {} })).toEqual([
      "supabase/pg_prove:3.36",
    ]);
  });

  it("orders native fetches ECR, GHCR, GitHub by default", () => {
    expect(nativeArtifactCandidates(githubUrls, { env: {} })).toEqual([
      {
        kind: "oci",
        registry: "public.ecr.aws",
        repository: "supabase/cli/postgrest",
        tag: "v16.2-native-linux-arm64",
      },
      {
        kind: "oci",
        registry: "ghcr.io",
        repository: "supabase/cli/postgrest",
        tag: "v16.2-native-linux-arm64",
      },
      {
        kind: "github",
        downloadUrl: githubUrls.downloadUrl,
        manifestUrl: githubUrls.manifestUrl,
        checksumUrl: githubUrls.checksumUrl,
      },
    ]);
  });

  it("prefers GHCR then GitHub for Cursor native fetches", () => {
    const candidates = nativeArtifactCandidates(githubUrls, { env: { CURSOR_AGENT: "1" } });
    expect(candidates.map((candidate) => candidate.kind)).toEqual(["oci", "github", "oci"]);
    expect(candidates[0]).toMatchObject({ registry: "ghcr.io" });
  });
});
