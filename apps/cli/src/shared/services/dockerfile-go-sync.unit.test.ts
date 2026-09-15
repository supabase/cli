import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import serviceImagesDockerfile from "./Dockerfile" with { type: "text" };

// The Go tree still `go:embed`s its own copy for a dependency that hasn't been removed
// yet; this keeps the two copies in sync until apps/cli-go is deleted, at which point
// this test should be deleted alongside it.
const GO_DOCKERFILE_PATH = fileURLToPath(
  new URL("../../../../cli-go/pkg/config/templates/Dockerfile", import.meta.url),
);

describe("Go Dockerfile sync guard", () => {
  test("keeps the Go tree's embedded Dockerfile byte-identical to the TS-owned copy", () => {
    const goDockerfile = readFileSync(GO_DOCKERFILE_PATH, "utf8");
    expect(goDockerfile).toBe(serviceImagesDockerfile);
  });
});
