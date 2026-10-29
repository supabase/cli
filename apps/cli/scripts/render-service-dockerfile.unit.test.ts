import { describe, expect, test } from "vitest";

import { TS_DOCKERFILE_PATH, renderDockerfile } from "./render-service-dockerfile.ts";

/* Decoded as UTF-8 with a leading byte order mark kept (`.text()` would drop it). */
const readDockerfile = (path: string) =>
  Bun.file(path)
    .bytes()
    .then((bytes) => new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes));

// Both against the real, checked-in Dockerfile and the real catalog — no hardcoded version
// literal, so a catalog bump never makes this drift-detection test itself go stale.
const currentTsDockerfile = await readDockerfile(TS_DOCKERFILE_PATH);

describe("renderDockerfile against the real catalog and Dockerfile", () => {
  test("round-trips: rewriting the checked-in Dockerfile reproduces it byte for byte (no drift)", () => {
    expect(renderDockerfile(currentTsDockerfile)).toBe(currentTsDockerfile);
  });

  test("rendering twice is stable", () => {
    expect(renderDockerfile(currentTsDockerfile)).toBe(renderDockerfile(currentTsDockerfile));
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

  test("preserves hand-/Dependabot-managed lines verbatim, even when their own tags change", () => {
    // Simulates a Dependabot bump of kong/differ/migra/pgprove: give each a synthetic marker
    // tag (never a real pin) and confirm the generator leaves those exact lines alone rather
    // than reverting or otherwise touching them.
    const marker = "99.99.99-fixture-marker";
    let tampered = currentTsDockerfile;
    for (const alias of ["kong", "differ", "migra", "pgprove"]) {
      const pattern = new RegExp(`^FROM (\\S+):(\\S+) AS ${alias}$`, "m");
      const match = pattern.exec(tampered);
      expect(match, `no line for hand-managed alias '${alias}'`).not.toBeNull();
      tampered = tampered.replace(pattern, `FROM $1:${marker} AS ${alias}`);
    }
    expect(tampered).not.toBe(currentTsDockerfile);

    const rendered = renderDockerfile(tampered);
    for (const alias of ["kong", "differ", "migra", "pgprove"]) {
      const tamperedLine = tampered.split("\n").find((line) => line.endsWith(`AS ${alias}`));
      expect(tamperedLine).toBeDefined();
      expect(tamperedLine).toContain(marker);
      expect(rendered).toContain(tamperedLine);
    }
  });
});
