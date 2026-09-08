import { describe, expect, test } from "bun:test";

import {
  CATALOG_PATH,
  InvalidPayloadError,
  planCatalogUpdate,
  releaseLine,
  validatePayload,
} from "./sync-workload-catalog.ts";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

/**
 * The real catalog, so these tests fail if its shape drifts away from what the
 * patterns expect rather than passing against a stale hand-written fixture.
 */
const realCatalog = await Bun.file(CATALOG_PATH).text();

/** A trimmed catalog carrying both entry shapes the script has to rewrite. */
const fixture = `const workloadCatalog = {
  "database:database": native(
    "postgres",
    "17.6.1.168",
    "ghcr.io/supabase/cli/postgres:17.6.1.168@sha256:${"9".repeat(64)}",
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start"],
    {
      additionalReleases: {
        "15.14.1.168":
          "ghcr.io/supabase/cli/postgres:15.14.1.168@sha256:${"f".repeat(64)}",
      },
      containerAlias: "supabase-database",
    },
  ),
  "rest:rest": native(
    "postgrest",
    "v16.2",
    "ghcr.io/supabase/cli/postgrest:v16.2",
    "bin/postgrest",
    ["bin/postgrest"],
    { containerAlias: "supabase-rest" },
  ),
  "auth:auth": native("auth", "v2.196.0", "ghcr.io/supabase/cli/auth:v2.196.0", "bin/auth", [
    "bin/auth",
  ]),
  "studio:studio": native(
    "studio",
    "2026.09.04-sha-5a67366",
    "ghcr.io/supabase/cli/studio:2026.09.04-sha-5a67366@sha256:${"c".repeat(64)}",
    "bin/studio",
    ["bin/studio"],
  ),
} satisfies Readonly<Record<string, WorkloadCatalogEntry>>;
`;

describe("releaseLine", () => {
  test.each([
    ["17.6.1.168", "17"],
    ["15.14.1.168", "15"],
    ["v2.196.0", "2"],
    ["v16.2", "16"],
    ["2026.09.04-sha-5a67366", "2026"],
    ["0.53.0", "0"],
  ])("reads %s as line %s", (version, expected) => {
    expect(releaseLine(version)).toBe(expected);
  });
});

describe("validatePayload", () => {
  test("rejects a version that would escape the string literal", () => {
    expect(() =>
      validatePayload({ service: "auth", version: 'v1",\n  "pwned', digest: DIGEST_A }),
    ).toThrow(InvalidPayloadError);
  });

  test("rejects a non-sha256 digest", () => {
    expect(() => validatePayload({ service: "auth", version: "v1.0.0", digest: "latest" })).toThrow(
      InvalidPayloadError,
    );
  });

  test("rejects an uppercase or path-traversing service name", () => {
    expect(() =>
      validatePayload({ service: "../../etc", version: "v1.0.0", digest: DIGEST_A }),
    ).toThrow(InvalidPayloadError);
    expect(() => validatePayload({ service: "Auth", version: "v1.0.0", digest: DIGEST_A })).toThrow(
      InvalidPayloadError,
    );
  });
});

describe("planCatalogUpdate", () => {
  test("bumps a single-line service and pins the digest", () => {
    const plan = planCatalogUpdate({
      source: fixture,
      service: "auth",
      version: "v2.197.0",
      digest: DIGEST_A,
    });

    expect(plan.kind).toBe("updated");
    if (plan.kind !== "updated") return;
    expect(plan.previousVersion).toBe("v2.196.0");
    expect(plan.target).toBe("default");
    expect(plan.source).toContain(
      `native("auth", "v2.197.0", "ghcr.io/supabase/cli/auth:v2.197.0@${DIGEST_A}", "bin/auth"`,
    );
    expect(plan.source).not.toContain("v2.196.0");
  });

  test("adds a digest to a previously tag-only pin", () => {
    const plan = planCatalogUpdate({
      source: fixture,
      service: "postgrest",
      version: "v16.2",
      digest: DIGEST_A,
    });

    expect(plan.kind).toBe("updated");
    if (plan.kind !== "updated") return;
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgrest:v16.2@${DIGEST_A}"`);
  });

  test("bumps a date-versioned service across a year boundary", () => {
    const plan = planCatalogUpdate({
      source: fixture,
      service: "studio",
      version: "2027.01.02-sha-abc1234",
      digest: DIGEST_A,
    });

    expect(plan.kind).toBe("updated");
    if (plan.kind !== "updated") return;
    expect(plan.source).toContain(
      `"ghcr.io/supabase/cli/studio:2027.01.02-sha-abc1234@${DIGEST_A}"`,
    );
  });

  test("a 17.x postgres release moves the default and leaves the 15.x line alone", () => {
    const plan = planCatalogUpdate({
      source: fixture,
      service: "postgres",
      version: "17.6.1.169",
      digest: DIGEST_A,
    });

    expect(plan.kind).toBe("updated");
    if (plan.kind !== "updated") return;
    expect(plan.previousVersion).toBe("17.6.1.168");
    expect(plan.target).toBe("default");
    expect(plan.source).toContain(`"postgres",\n    "17.6.1.169",`);
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgres:17.6.1.169@${DIGEST_A}"`);
    // The additional line must survive untouched.
    expect(plan.source).toContain(`"15.14.1.168":`);
    expect(plan.source).toContain(`sha256:${"f".repeat(64)}`);
  });

  test("a 15.x postgres release moves the additional line, never the 17.x default", () => {
    const plan = planCatalogUpdate({
      source: fixture,
      service: "postgres",
      version: "15.14.1.169",
      digest: DIGEST_B,
    });

    expect(plan.kind).toBe("updated");
    if (plan.kind !== "updated") return;
    expect(plan.previousVersion).toBe("15.14.1.168");
    expect(plan.target).toBe("additional");
    expect(plan.source).toContain(`"15.14.1.169":`);
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgres:15.14.1.169@${DIGEST_B}"`);
    // The 17.x default is the regression this guards: it must not move.
    expect(plan.source).toContain(`"postgres",\n    "17.6.1.168",`);
    expect(plan.source).toContain(`sha256:${"9".repeat(64)}`);
  });

  test("skips a postgres release line the catalog does not carry", () => {
    const plan = planCatalogUpdate({
      source: fixture,
      service: "postgres",
      version: "16.4.1.001",
      digest: DIGEST_A,
    });

    expect(plan.kind).toBe("unmodelled-release-line");
    if (plan.kind !== "unmodelled-release-line") return;
    expect(plan.known).toEqual(["17.6.1.168", "15.14.1.168"]);
  });

  test("re-dispatching the same release is a no-op", () => {
    const first = planCatalogUpdate({
      source: fixture,
      service: "auth",
      version: "v2.197.0",
      digest: DIGEST_A,
    });
    expect(first.kind).toBe("updated");
    if (first.kind !== "updated") return;

    expect(
      planCatalogUpdate({
        source: first.source,
        service: "auth",
        version: "v2.197.0",
        digest: DIGEST_A,
      }).kind,
    ).toBe("unchanged");
  });

  test("a digest change on the same version still syncs", () => {
    const plan = planCatalogUpdate({
      source: fixture,
      service: "auth",
      version: "v2.196.0",
      digest: DIGEST_A,
    });

    expect(plan.kind).toBe("updated");
    if (plan.kind !== "updated") return;
    expect(plan.source).toContain(`auth:v2.196.0@${DIGEST_A}`);
  });

  test("reports a service the catalog does not model", () => {
    expect(
      planCatalogUpdate({
        source: fixture,
        service: "kong",
        version: "v3.0.0",
        digest: DIGEST_A,
      }).kind,
    ).toBe("unmodelled-service");
  });

  test("does not confuse postgres with postgrest", () => {
    const plan = planCatalogUpdate({
      source: fixture,
      service: "postgrest",
      version: "v17.0",
      digest: DIGEST_A,
    });

    expect(plan.kind).toBe("updated");
    if (plan.kind !== "updated") return;
    expect(plan.previousVersion).toBe("v16.2");
    // postgres keeps both of its own pins.
    expect(plan.source).toContain(`"17.6.1.168",`);
    expect(plan.source).toContain(`"15.14.1.168":`);
  });

  test("rejects an invalid payload instead of rewriting the catalog", () => {
    expect(() =>
      planCatalogUpdate({
        source: fixture,
        service: "auth",
        version: "v1.0.0",
        digest: "sha256:not-a-digest",
      }),
    ).toThrow(InvalidPayloadError);
  });
});

describe("against the real catalog", () => {
  test("every modelled service is addressable and idempotent", () => {
    // Derived from the catalog itself so a newly modelled workload is covered
    // without editing this list.
    const services = [
      ...new Set(
        [...realCatalog.matchAll(/native\(\s*"([a-z][a-z0-9-]*)",/g)].map(
          (match) => match[1] ?? "",
        ),
      ),
    ];
    expect(services.length).toBeGreaterThan(10);

    for (const service of services) {
      const bumped = planCatalogUpdate({
        source: realCatalog,
        service,
        version: "99.99.99",
        digest: DIGEST_A,
      });
      // 99.x is a line no service carries, so postgres (multi-line) skips while
      // every single-line service bumps. Either way it must be recognised.
      expect(
        bumped.kind === "updated" || bumped.kind === "unmodelled-release-line",
        `${service} was not addressable in the real catalog`,
      ).toBe(true);

      if (bumped.kind !== "updated") continue;
      expect(
        planCatalogUpdate({
          source: bumped.source,
          service,
          version: "99.99.99",
          digest: DIGEST_A,
        }).kind,
      ).toBe("unchanged");
    }
  });
});
