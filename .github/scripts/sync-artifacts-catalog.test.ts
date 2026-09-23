import { describe, expect, test } from "bun:test";

import { InvalidPayloadError } from "./slim-mirror-payload.ts";
import {
  CATALOG_PATH,
  catalogDigestPins,
  planArtifactCatalogUpdate,
  releaseLine,
} from "./sync-artifacts-catalog.ts";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const fixture = `const workloadCatalog = {
  database: definition(
    "postgres",
    "17.6.1.168",
    "ghcr.io/supabase/cli/postgres:17.6.1.168@sha256:${"9".repeat(64)}",
    "bin/supabase-postgres-start",
    ["bin/supabase-postgres-start"],
    {
      "15.14.1.168":
        "ghcr.io/supabase/cli/postgres:15.14.1.168@sha256:${"f".repeat(64)}",
    },
  ),
  rest: definition("postgrest", "v16.2", "ghcr.io/supabase/cli/postgrest:v16.2", "bin/postgrest"),
  auth: definition("auth", "v2.196.0", "ghcr.io/supabase/cli/auth:v2.196.0", "bin/auth"),
  analytics: definition(
    "analytics",
    "v1.50.9",
    "ghcr.io/supabase/cli/analytics:v1.50.9@${DIGEST_A}",
    "bin/logflare",
  ),
  vector: definition("vector", "0.49.0", "ghcr.io/supabase/cli/vector:0.49.0", "bin/vector"),
  pooler: definition("pooler", "v2.9.10", "ghcr.io/supabase/cli/pooler:v2.9.10", "bin/server"),
};
`;

const dockerfile = `FROM supabase/postgres:17.6.1.171 AS pg
FROM library/kong:2.8.1 AS kong
FROM postgrest/postgrest:v16.3 AS postgrest
FROM timberio/vector:0.53.0-alpine AS vector
FROM supabase/supavisor:2.9.13 AS supavisor
FROM supabase/logflare:1.50.12 AS logflare
`;

function digests(
  overrides: Readonly<Record<string, string>> = {},
): (service: string, version: string) => string {
  return (service, version) => {
    const digest = overrides[`${service}:${version}`];
    if (digest === undefined) throw new Error(`unexpected digest lookup ${service}:${version}`);
    return digest;
  };
}

describe("releaseLine", () => {
  test.each([
    ["17.6.1.168", "17"],
    ["15.14.1.168", "15"],
    ["v2.196.0", "2"],
    ["2026.09.04-sha-5a67366", "2026"],
  ])("reads %s as line %s", (version, expected) => {
    expect(releaseLine(version)).toBe(expected);
  });
});

describe("planArtifactCatalogUpdate", () => {
  test("pins each slim Dockerfile image and skips aliases with no slim build", () => {
    const plan = planArtifactCatalogUpdate({
      dockerfile,
      catalog: fixture,
      digestFor: digests({ "postgres:17.6.1.171": DIGEST_B, "analytics:v1.50.12": DIGEST_B }),
    });

    expect(
      plan.updates.map(
        (update) => `${update.service} ${update.previousVersion} -> ${update.version}`,
      ),
    ).toEqual([
      "postgres 17.6.1.168 -> 17.6.1.171",
      "postgrest v16.2 -> v16.3",
      "vector 0.49.0 -> 0.53.0",
      "pooler v2.9.10 -> v2.9.13",
      "analytics v1.50.9 -> v1.50.12",
    ]);
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgres:17.6.1.171@${DIGEST_B}"`);
    expect(plan.source).toContain(
      `"ghcr.io/supabase/cli/postgres:15.14.1.168@sha256:${"f".repeat(64)}"`,
    );
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgrest:v16.3"`);
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/vector:0.53.0"`);
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/pooler:v2.9.13"`);
    expect(plan.source).not.toContain("kong");
  });

  test("moves a postgres pin onto the matching additional release line", () => {
    const plan = planArtifactCatalogUpdate({
      dockerfile: "FROM supabase/postgres:15.14.1.175 AS pg\n",
      catalog: fixture,
      digestFor: digests({ "postgres:15.14.1.175": DIGEST_B }),
    });

    expect(plan.updates).toEqual([
      {
        service: "postgres",
        version: "15.14.1.175",
        previousVersion: "15.14.1.168",
        target: "additional",
      },
    ]);
    expect(plan.source).toContain(`"17.6.1.168"`);
    expect(plan.source).toContain(`"15.14.1.175"`);
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgres:15.14.1.175@${DIGEST_B}"`);
  });

  test("does not look up a digest when the pin already matches", () => {
    const plan = planArtifactCatalogUpdate({
      dockerfile: "FROM postgrest/postgrest:v16.2 AS postgrest\n",
      catalog: fixture,
      digestFor: () => {
        throw new Error("digest lookup");
      },
    });

    expect(plan).toEqual({ source: fixture, updates: [], skipped: [] });
  });

  test("leaves an OrioleDB tag on docker.io and still pins the other images", () => {
    const plan = planArtifactCatalogUpdate({
      dockerfile: `FROM supabase/postgres:16.0.0.1-orioledb AS pg
FROM postgrest/postgrest:v16.3 AS postgrest
FROM supabase/postgres:orioledb-15.1.0.55 AS orioledb
`,
      catalog: fixture,
      digestFor: digests(),
    });

    expect(plan.updates.map((update) => update.service)).toEqual(["postgrest"]);
    expect(plan.source).toContain(
      `"ghcr.io/supabase/cli/postgres:17.6.1.168@sha256:${"9".repeat(64)}"`,
    );
    expect(plan.source).toContain(`"ghcr.io/supabase/cli/postgrest:v16.3"`);
    expect(plan.skipped.map((skip) => skip.alias)).toEqual(["pg", "orioledb"]);
  });

  test("skips a pin with no slim manifest and still applies the next one", () => {
    const plan = planArtifactCatalogUpdate({
      dockerfile: `FROM supabase/postgres:17.6.1.171 AS pg
FROM postgrest/postgrest:v16.3 AS postgrest
`,
      catalog: fixture,
      digestFor: (service) => (service === "postgres" ? undefined : DIGEST_B),
    });

    expect(plan.updates.map((update) => update.service)).toEqual(["postgrest"]);
    expect(plan.source).toContain(`"17.6.1.168"`);
    expect(plan.skipped.map((skip) => skip.alias)).toEqual(["pg"]);
  });

  test("refuses a Dockerfile tag that would escape the catalog string", () => {
    expect(() =>
      planArtifactCatalogUpdate({
        dockerfile: 'FROM supabase/gotrue:v1" AS gotrue\n',
        catalog: fixture,
        digestFor: digests(),
      }),
    ).toThrow(InvalidPayloadError);
  });

  test("skips a release line the catalog does not carry and still pins the rest", () => {
    const plan = planArtifactCatalogUpdate({
      dockerfile: `FROM supabase/postgres:16.1.1.1 AS pg
FROM postgrest/postgrest:v16.3 AS postgrest
`,
      catalog: fixture,
      digestFor: digests(),
    });

    expect(plan.updates.map((update) => update.service)).toEqual(["postgrest"]);
    expect(plan.skipped.map((skip) => skip.alias)).toEqual(["pg"]);
    expect(plan.source).toContain(`"17.6.1.168"`);
  });
});

describe("against the real catalog", () => {
  test("every slim Dockerfile alias is a catalog entry", async () => {
    const dockerfile = await Bun.file("apps/cli/src/shared/services/Dockerfile").text();
    const catalog = await Bun.file(CATALOG_PATH).text();

    expect(() => catalogDigestPins(dockerfile, catalog)).not.toThrow();
    const plan = planArtifactCatalogUpdate({
      dockerfile,
      catalog,
      digestFor: () => DIGEST_A,
    });
    expect(plan.source).toContain('definition(\n    "postgres"');
  });
});
