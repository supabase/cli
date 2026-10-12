import { describe, expect, test, vi } from "vitest";

import { renderDockerfile } from "./render-service-dockerfile.ts";

// A minimal fixture catalog covering every slim-capable alias, so `renderDockerfile`'s
// one-line-per-alias check is satisfied by default; each test only mutates what it's
// exercising. `vi.mock` factories are hoisted above every other top-level statement, so the
// fixture pins are built inline here rather than imported from an outer module.
vi.mock("@supabase/stack/internal/artifacts", async (importOriginal) => {
  const nativePin = { archive: "a".repeat(64), manifest: "b".repeat(64) };
  const natives = { "darwin-arm64": nativePin, "linux-amd64": nativePin, "linux-arm64": nativePin };
  const pin = (sourceService: string, upstreamImage: string, isDefault: boolean) => ({
    service: sourceService,
    sourceService,
    isDefault,
    pin: {
      upstreamVersion: upstreamImage.split(":").at(-1),
      revision: 0,
      image: `ghcr.io/supabase/cli/${sourceService}:fixture-r0@sha256:${"c".repeat(64)}`,
      upstreamImage,
      natives,
    },
  });
  return {
    ...(await importOriginal<typeof import("@supabase/stack/internal/artifacts")>()),
    catalogPins: () => [
      pin("postgres", "supabase/postgres:17.0.0", true),
      pin("postgres", "supabase/postgres:15.0.0", false),
      pin("postgres", "supabase/postgres:17.0.0-orioledb", false),
      pin("mailpit", "axllent/mailpit:v1.0.0", true),
      pin("postgrest", "postgrest/postgrest:v1.0.0", true),
      pin("pgmeta", "supabase/postgres-meta:v1.0.0", true),
      pin("studio", "supabase/studio:1.0.0", true),
      pin("imgproxy", "ghcr.io/imgproxy/imgproxy:v1.0.0", true),
      pin("edge-runtime", "supabase/edge-runtime:v1.0.0", true),
      pin("vector", "timberio/vector:1.0.0-alpine", true),
      pin("pooler", "supabase/supavisor:1.0.0", true),
      pin("auth", "supabase/gotrue:v1.0.0", true),
      pin("realtime", "supabase/realtime:v1.0.0", true),
      pin("storage", "supabase/storage-api:v1.0.0", true),
      pin("analytics", "supabase/logflare:1.0.0", true),
    ],
  };
});

/** A minimal Dockerfile with every slim-capable alias, plus kong and pg14 (hand-managed). */
function baseDockerfile(overrides: Readonly<Record<string, string>> = {}): string {
  const lines: Readonly<Record<string, string>> = {
    pg: "FROM supabase/postgres:16.9.9 AS pg",
    pg15: "FROM supabase/postgres:14.9.9 AS pg15",
    mailpit: "FROM axllent/mailpit:v0.9.9 AS mailpit",
    postgrest: "FROM postgrest/postgrest:v0.9.9 AS postgrest",
    pgmeta: "FROM supabase/postgres-meta:v0.9.9 AS pgmeta",
    studio: "FROM supabase/studio:0.9.9 AS studio",
    imgproxy: "FROM darthsim/imgproxy:v0.9.9 AS imgproxy",
    edgeruntime: "FROM supabase/edge-runtime:v0.9.9 AS edgeruntime",
    vector: "FROM timberio/vector:0.9.9-alpine AS vector",
    supavisor: "FROM supabase/supavisor:0.9.9 AS supavisor",
    gotrue: "FROM supabase/gotrue:v0.9.9 AS gotrue",
    realtime: "FROM supabase/realtime:v0.9.9 AS realtime",
    storage: "FROM supabase/storage-api:v0.9.9 AS storage",
    logflare: "FROM supabase/logflare:0.9.9 AS logflare",
    kong: "FROM library/kong:2.8.1 AS kong",
  };
  const merged = { ...lines, ...overrides };
  return `# hand-authored header\n${Object.values(merged).join("\n")}\n# hand-authored footer\n`;
}

describe("renderDockerfile: pin selection", () => {
  test("pg takes the default pin and pg15 the additional stock pin; an OrioleDB pin has no alias", () => {
    const rendered = renderDockerfile(baseDockerfile());
    expect(rendered).toContain("FROM supabase/postgres:17.0.0 AS pg\n");
    expect(rendered).toContain("FROM supabase/postgres:15.0.0 AS pg15\n");
    expect(rendered).not.toContain("orioledb");
  });
});

describe("renderDockerfile: repository rule", () => {
  test("keeps the existing repository and only replaces the tag", () => {
    const rendered = renderDockerfile(baseDockerfile());
    expect(rendered).toContain("FROM supabase/gotrue:v1.0.0 AS gotrue\n");
  });

  test("fails loudly when the Dockerfile's repository no longer matches the catalog's, for a non-overridden alias", () => {
    expect(() =>
      renderDockerfile(baseDockerfile({ gotrue: "FROM some-other-org/gotrue:v0.9.9 AS gotrue" })),
    ).toThrow(/gotrue.*repository/i);
  });

  test("tolerates imgproxy's documented repository mismatch (the allowlisted override)", () => {
    const rendered = renderDockerfile(baseDockerfile());
    // Catalog upstreamImage repo is ghcr.io/imgproxy/imgproxy; the Dockerfile keeps darthsim.
    expect(rendered).toContain("FROM darthsim/imgproxy:v1.0.0 AS imgproxy\n");
  });

  test("still fails loudly when imgproxy's Dockerfile repository drifts from its override entry", () => {
    expect(() =>
      renderDockerfile(
        baseDockerfile({ imgproxy: "FROM some-other-org/imgproxy:v0.9.9 AS imgproxy" }),
      ),
    ).toThrow(/imgproxy.*REPOSITORY_OVERRIDES/i);
  });
});

describe("renderDockerfile: line preservation", () => {
  test("never inserts a line for a missing slim-capable alias", () => {
    const withoutPg15 = baseDockerfile().replace(/FROM supabase\/postgres:14\.9\.9 AS pg15\n/, "");
    expect(() => renderDockerfile(withoutPg15)).toThrow(/pg15/);
  });

  test("leaves non-slim-capable lines (kong) and comments byte-for-byte untouched", () => {
    const current = baseDockerfile();
    const rendered = renderDockerfile(current);
    expect(rendered).toContain("FROM library/kong:2.8.1 AS kong");
    expect(rendered).toContain("# hand-authored header");
    expect(rendered).toContain("# hand-authored footer");
  });
});
