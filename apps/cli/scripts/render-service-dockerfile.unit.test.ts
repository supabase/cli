import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

import {
  GO_DOCKERFILE_PATH,
  TS_DOCKERFILE_PATH,
  renderDockerfile,
} from "./render-service-dockerfile.ts";

// Both against the real, checked-in Dockerfile and the real catalog — no hardcoded version
// literal, so a catalog bump never makes this drift-detection test itself go stale.
const currentTsDockerfile = readFileSync(TS_DOCKERFILE_PATH, "utf8");

describe("renderDockerfile against the real catalog and Dockerfile", () => {
  test("round-trips: rewriting the checked-in Dockerfile reproduces it byte for byte (no drift)", () => {
    expect(renderDockerfile(currentTsDockerfile)).toBe(currentTsDockerfile);
  });

  test("rendering twice is stable", () => {
    expect(renderDockerfile(currentTsDockerfile)).toBe(renderDockerfile(currentTsDockerfile));
  });

  // The Go tree still `go:embed`s its own copy for a dependency that hasn't been removed yet;
  // this is the single place that keeps the two copies in sync (folded from the former
  // dockerfile-go-sync.unit.test.ts), until apps/cli-go is deleted.
  test("the Go tree's embedded Dockerfile is a byte copy of the TS-owned one", () => {
    const goDockerfile = readFileSync(GO_DOCKERFILE_PATH, "utf8");
    expect(goDockerfile).toBe(currentTsDockerfile);
  });

  test("detects drift when a generated line is hand-edited", () => {
    // A hand-edit to a generated tag (bumping gotrue without touching the catalog) must not
    // round-trip back to itself — this is the drift check's whole point.
    const tampered = currentTsDockerfile.replace(
      /FROM supabase\/gotrue:v[^\s]+ AS gotrue/,
      "FROM supabase/gotrue:v9.9.9 AS gotrue",
    );
    expect(tampered).not.toBe(currentTsDockerfile);
    expect(renderDockerfile(tampered)).not.toBe(tampered);
    // It heals back to the catalog-pinned tag, not just "detects a difference".
    expect(renderDockerfile(tampered)).toBe(currentTsDockerfile);
  });

  test("leaves every hand-/Dependabot-managed line untouched, including comments and pg14", () => {
    const rendered = renderDockerfile(currentTsDockerfile);
    for (const line of [
      "FROM library/kong:2.8.1 AS kong",
      "FROM supabase/pgadmin-schema-diff:cli-0.0.5 AS differ",
      "FROM supabase/migra:3.0.1663481299 AS migra",
      "FROM supabase/pg_prove:3.36 AS pgprove",
    ]) {
      expect(rendered).toContain(line);
    }
    // pg14 has no slim build: its tag is whatever the checked-in file already pins, verbatim.
    const pg14Line = currentTsDockerfile.split("\n").find((line) => line.endsWith("AS pg14"));
    expect(pg14Line).toBeDefined();
    expect(rendered).toContain(pg14Line);
  });
});
